/**
 * Analítica con consentimiento (M-0116, M-0317).
 *
 * La regla del proyecto no admite excepciones: **sin consentimiento explícito no se
 * registra el evento**. El proveedor local guarda en el propio documento; no hay
 * píxeles de terceros ni GA4 hasta que exista un texto legal aprobado.
 */
import { id as generateId } from './ids.js';
import { now } from './dates.js';

export const EVENT_TYPES = [
  'page_view', 'product_view', 'search', 'affiliate_click', 'add_to_cart', 'remove_from_cart',
  'begin_checkout', 'purchase', 'promotion_impression', 'promotion_click', 'content_click',
  'availability_subscribe', 'coupon_click',
];

export class LocalAnalyticsProvider {
  constructor({ store, collection = 'events', limit = 50_000 }) {
    this.name = 'local';
    this.store = store;
    this.collection = collection;
    this.limit = limit;
  }

  async track(event) {
    return this.store.transaction(state => {
      if (!Array.isArray(state[this.collection])) state[this.collection] = [];
      state[this.collection].push(event);
      // Se recorta por el extremo antiguo: la analítica no debe hacer crecer el
      // documento sin límite.
      if (state[this.collection].length > this.limit) {
        state[this.collection].splice(0, state[this.collection].length - this.limit);
      }
      return event;
    });
  }
}

export class AnalyticsService {
  constructor({ provider, logger, requireConsent = true } = {}) {
    this.provider = provider;
    this.logger = logger;
    this.requireConsent = requireConsent;
    this.stats = { tracked: 0, skippedWithoutConsent: 0 };
  }

  /**
   * @param {{type:string, consent?:boolean, sessionId?:string, ...}} event
   * @returns {Promise<object|null>} el evento registrado, o `null` si se omitió
   */
  async track({ type, consent = false, ...rest }) {
    if (this.requireConsent && !consent) {
      this.stats.skippedWithoutConsent += 1;
      return null;
    }
    const event = {
      id: generateId('evt'),
      type,
      timestamp: now(),
      ...sanitize(rest),
    };
    await this.provider.track(event);
    this.stats.tracked += 1;
    return event;
  }

  describe() {
    return { provider: this.provider?.name || null, requireConsent: this.requireConsent, ...this.stats };
  }
}

/** Recorta y normaliza los campos para que un cliente no pueda inflar el documento. */
function sanitize(input) {
  const output = {};
  const limits = {
    sessionId: 80, source: 50, medium: 50, campaign: 80, page: 200, referrer: 500,
    device: 30, country: 60, term: 120, placementId: 80, clickId: 40, locale: 10, channelId: 80,
  };
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      output[key] = value.slice(0, limits[key] || 200);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      output[key] = value;
    } else if (Array.isArray(value)) {
      output[key] = value.slice(0, 50);
    } else if (typeof value === 'object') {
      output[key] = JSON.parse(JSON.stringify(value).slice(0, 2000).replace(/[^}\]"]+$/, '') || '{}');
    }
  }
  return output;
}

/** Detecta el tipo de dispositivo a partir del `user-agent`, sin librerías. */
export function detectDevice(userAgent = '') {
  const agent = String(userAgent).toLowerCase();
  if (/bot|crawler|spider|crawling/.test(agent)) return 'bot';
  if (/ipad|tablet|kindle|playbook|silk/.test(agent)) return 'tablet';
  if (/mobi|android|iphone|ipod|phone/.test(agent)) return 'mobile';
  return 'desktop';
}

/** Clasifica el origen del tráfico a partir del `referer`, sin cookies de terceros. */
export function detectSource(referer, explicit = null) {
  if (explicit) return String(explicit).slice(0, 50);
  if (!referer) return 'direct';
  try {
    const host = new URL(referer).hostname.replace(/^www\./, '');
    if (/google\./.test(host)) return 'google';
    if (/bing\./.test(host)) return 'bing';
    if (/duckduckgo\./.test(host)) return 'duckduckgo';
    if (/facebook\.|instagram\.|fb\./.test(host)) return 'meta';
    if (/t\.co|twitter\.|x\.com/.test(host)) return 'x';
    if (/linkedin\./.test(host)) return 'linkedin';
    if (/youtube\.|youtu\.be/.test(host)) return 'youtube';
    if (/whatsapp\./.test(host)) return 'whatsapp';
    if (/tiktok\./.test(host)) return 'tiktok';
    return host.slice(0, 50);
  } catch {
    return 'direct';
  }
}
