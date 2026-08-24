/**
 * Webhooks salientes (M-0117, M-0118).
 *
 * Nota sobre el alcance: el proyecto tiene prohibido hacer peticiones externas
 * durante la validación de enlaces (para evitar SSRF y scraping). Los webhooks son
 * distinto: el destino lo configura el administrador, no un dato del catálogo, y aun
 * así se validan igual contra hosts internos.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { id as generateId } from './ids.js';
import { now } from './dates.js';
import { ValidationError } from './errors.js';

/** Mismos hosts prohibidos que en la validación de enlaces: sin excepciones. */
export function isUnsafeHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost'
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.localhost')
    || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
    || host.includes(':')
  );
}

export function signPayload(secret, payload, timestamp) {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

export function verifySignature(secret, payload, timestamp, signature) {
  const expected = Buffer.from(signPayload(secret, payload, timestamp), 'utf8');
  const received = Buffer.from(String(signature || ''), 'utf8');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export class WebhookService {
  constructor({ store, logger, collection = 'webhooks', deliveryCollection = 'webhookDeliveries', enabled = true, maxAttempts = 5 } = {}) {
    this.store = store;
    this.logger = logger;
    this.collection = collection;
    this.deliveryCollection = deliveryCollection;
    this.enabled = enabled;
    this.maxAttempts = maxAttempts;
  }

  validateUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw ValidationError.single('url', 'La URL del webhook no es válida.');
    }
    if (parsed.protocol !== 'https:') throw ValidationError.single('url', 'El webhook debe usar HTTPS.');
    if (isUnsafeHost(parsed.hostname)) throw ValidationError.single('url', 'El destino apunta a un host interno y no se admite.');
    return parsed.toString();
  }

  list(filter = {}) {
    return this.store.collection(this.collection).filter(row => {
      if (filter.event && !this.subscribedTo(row, filter.event)) return false;
      if (filter.active !== undefined && Boolean(row.active) !== Boolean(filter.active)) return false;
      return true;
    });
  }

  subscribedTo(subscription, eventName) {
    return (subscription.events || []).some(pattern => {
      if (pattern === '*' || pattern === eventName) return true;
      if (!pattern.endsWith('.*')) return false;
      return eventName.startsWith(pattern.slice(0, -1));
    });
  }

  async subscribe({ url, events, secret, description = '' }) {
    const safeUrl = this.validateUrl(url);
    if (!Array.isArray(events) || !events.length) throw ValidationError.single('events', 'Indica al menos un evento.');
    if (!secret || String(secret).length < 24) throw ValidationError.single('secret', 'El secreto debe tener al menos 24 caracteres.');
    return this.store.transaction(state => {
      if (!Array.isArray(state[this.collection])) state[this.collection] = [];
      const subscription = {
        id: generateId('hook'),
        url: safeUrl,
        events,
        secret,
        description,
        active: true,
        failures: 0,
        lastDeliveryAt: null,
        createdAt: now(),
      };
      state[this.collection].unshift(subscription);
      return subscription;
    });
  }

  async unsubscribe(webhookId) {
    return this.store.transaction(state => {
      const rows = state[this.collection] || [];
      const position = rows.findIndex(row => row.id === webhookId);
      if (position < 0) return null;
      const [removed] = rows.splice(position, 1);
      return removed;
    });
  }

  /**
   * Entrega un evento a todas las suscripciones que lo escuchan.
   * Un fallo no bloquea nada: se registra y se reintenta con backoff (M-0118).
   */
  async dispatch(eventName, payload, { fetchImpl = globalThis.fetch } = {}) {
    if (!this.enabled) return [];
    const subscriptions = this.list({ event: eventName, active: true });
    const results = [];
    for (const subscription of subscriptions) {
      results.push(await this.deliver(subscription, eventName, payload, fetchImpl));
    }
    return results;
  }

  async deliver(subscription, eventName, payload, fetchImpl) {
    const body = JSON.stringify({ event: eventName, data: payload, sentAt: now() });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signPayload(subscription.secret, body, timestamp);
    const delivery = {
      id: generateId('del'),
      webhookId: subscription.id,
      event: eventName,
      status: 'pending',
      attempts: 0,
      httpStatus: null,
      error: null,
      createdAt: now(),
    };

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      delivery.attempts = attempt;
      try {
        const response = await fetchImpl(subscription.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Ndivepa-Event': eventName,
            'X-Ndivepa-Timestamp': String(timestamp),
            'X-Ndivepa-Signature': signature,
          },
          body,
          signal: AbortSignal.timeout(8000),
        });
        delivery.httpStatus = response.status;
        if (response.ok) {
          delivery.status = 'delivered';
          break;
        }
        delivery.error = `HTTP ${response.status}`;
        // 4xx distinto de 408/429 no se reintenta: el destino lo rechaza por contrato.
        if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
          delivery.status = 'rejected';
          break;
        }
      } catch (error) {
        delivery.error = error.message;
      }
      if (attempt < this.maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, Math.min(30_000, 2 ** attempt * 500)));
      } else {
        delivery.status = 'failed';
      }
    }

    await this.store.transaction(state => {
      if (!Array.isArray(state[this.deliveryCollection])) state[this.deliveryCollection] = [];
      state[this.deliveryCollection].unshift({ ...delivery, finishedAt: now() });
      if (state[this.deliveryCollection].length > 500) state[this.deliveryCollection].length = 500;
      const subscriptionRow = (state[this.collection] || []).find(row => row.id === subscription.id);
      if (subscriptionRow) {
        subscriptionRow.lastDeliveryAt = now();
        subscriptionRow.failures = delivery.status === 'delivered' ? 0 : (subscriptionRow.failures || 0) + 1;
        // Un destino que falla 20 veces seguidas se desactiva: no se insiste para siempre.
        if (subscriptionRow.failures >= 20) subscriptionRow.active = false;
      }
    });

    return delivery;
  }

  deliveries({ limit = 50, webhookId = null } = {}) {
    return this.store
      .collection(this.deliveryCollection)
      .filter(row => !webhookId || row.webhookId === webhookId)
      .slice(0, limit);
  }
}
