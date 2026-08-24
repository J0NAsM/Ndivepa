/**
 * Bus de eventos (M-0078 … M-0081, M-0303 … M-0304).
 *
 * Convención de nombres: `dominio.entidad.acción` (`product.variant.created`).
 * Los suscriptores se ejecutan **después** de que la transacción esté en disco: un
 * suscriptor no puede ver un estado que luego se descarta.
 */

const WILDCARD = '*';

export class EventBus {
  constructor({ logger, maxRetries = 3, baseDelayMs = 100, deadLetterLimit = 200 } = {}) {
    this.logger = logger;
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
    this.deadLetterLimit = deadLetterLimit;
    this.subscribers = new Map();
    this.deadLetters = [];
    this.seen = new Set();
    this.stats = { emitted: 0, delivered: 0, failed: 0 };
  }

  /**
   * @param {string} pattern nombre exacto, `dominio.*` o `*`
   * @param {(payload:object, meta:object)=>any} handler
   */
  subscribe(pattern, handler, { name = handler.name || 'anónimo' } = {}) {
    if (!this.subscribers.has(pattern)) this.subscribers.set(pattern, []);
    this.subscribers.get(pattern).push({ handler, name });
    this.seen.add(pattern);
    return () => {
      const list = this.subscribers.get(pattern) || [];
      const position = list.findIndex(entry => entry.handler === handler);
      if (position >= 0) list.splice(position, 1);
    };
  }

  matching(eventName) {
    const parts = eventName.split('.');
    const patterns = [eventName, WILDCARD];
    for (let depth = 1; depth < parts.length; depth += 1) {
      patterns.push(`${parts.slice(0, depth).join('.')}.${WILDCARD}`);
    }
    return patterns.flatMap(pattern => this.subscribers.get(pattern) || []);
  }

  /** Publica un evento y espera a todos los suscriptores. Un fallo no detiene a los demás. */
  async emit(eventName, payload = {}, meta = {}) {
    this.stats.emitted += 1;
    this.seen.add(eventName);
    const listeners = this.matching(eventName);
    if (!listeners.length) return { event: eventName, delivered: 0 };

    let delivered = 0;
    for (const listener of listeners) {
      const ok = await this.deliver(listener, eventName, payload, meta);
      if (ok) delivered += 1;
    }
    this.stats.delivered += delivered;
    return { event: eventName, delivered, listeners: listeners.length };
  }

  async deliver(listener, eventName, payload, meta) {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        await listener.handler(payload, { event: eventName, attempt, ...meta });
        return true;
      } catch (error) {
        if (attempt === this.maxRetries) {
          this.stats.failed += 1;
          this.pushDeadLetter({ event: eventName, subscriber: listener.name, payload, error: error.message, attempts: attempt + 1 });
          this.logger?.error('Suscriptor agotó sus reintentos', { event: eventName, subscriber: listener.name, error: error.message });
          return false;
        }
        // Backoff exponencial (M-0080): 100 ms, 200 ms, 400 ms…
        await new Promise(resolve => setTimeout(resolve, this.baseDelayMs * 2 ** attempt));
      }
    }
    return false;
  }

  pushDeadLetter(entry) {
    this.deadLetters.unshift({ ...entry, failedAt: new Date().toISOString() });
    if (this.deadLetters.length > this.deadLetterLimit) this.deadLetters.length = this.deadLetterLimit;
  }

  /** Cola de eventos fallidos, inspeccionable desde el panel (M-0081). */
  failed({ limit = 50 } = {}) {
    return this.deadLetters.slice(0, limit);
  }

  clearFailed() {
    const count = this.deadLetters.length;
    this.deadLetters = [];
    return count;
  }

  /** Reintenta manualmente un evento fallido. */
  async retryFailed(position) {
    const entry = this.deadLetters[position];
    if (!entry) return null;
    this.deadLetters.splice(position, 1);
    return this.emit(entry.event, entry.payload, { retryOf: entry.subscriber });
  }

  /** Catálogo de eventos vistos, para el diagnóstico (M-0304). */
  catalog() {
    return {
      events: [...this.seen].sort(),
      subscribers: Object.fromEntries(
        [...this.subscribers.entries()]
          .filter(([, list]) => list.length)
          .map(([pattern, list]) => [pattern, list.map(entry => entry.name)]),
      ),
      stats: { ...this.stats },
      deadLetters: this.deadLetters.length,
    };
  }
}
