/**
 * Rate limiting (M-0119, M-0120).
 *
 * Mejora sobre el monolito: la clave es configurable (IP, sesión, clave de API,
 * combinación), no solo IP+ruta; se expone el estado en cabeceras `X-RateLimit-*`; y
 * la purga es proporcional al uso, no un barrido al azar cuando el mapa crece.
 */

export class RateLimiter {
  constructor({ trustProxy = false } = {}) {
    this.buckets = new Map();
    this.trustProxy = trustProxy;
    this.stats = { checks: 0, blocked: 0 };
  }

  /** IP del cliente. Solo mira `x-forwarded-for` si se confía en el proxy. */
  clientIp(req) {
    if (this.trustProxy) {
      const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
      if (forwarded) return forwarded;
    }
    return req.socket?.remoteAddress || 'unknown';
  }

  /**
   * @param {string} key clave del cubo
   * @param {{windowMs:number, max:number}} limit
   * @returns {{allowed:boolean, remaining:number, limit:number, resetMs:number, retryAfter:number}}
   */
  consume(key, { windowMs, max }) {
    this.stats.checks += 1;
    const reference = Date.now();
    const current = this.buckets.get(key);
    const bucket = current && reference - current.startedAt < windowMs ? current : { startedAt: reference, count: 0 };
    bucket.count += 1;
    this.buckets.set(key, bucket);

    if (this.buckets.size > 5000) this.prune(reference);

    const resetMs = bucket.startedAt + windowMs - reference;
    const allowed = bucket.count <= max;
    if (!allowed) this.stats.blocked += 1;
    return {
      allowed,
      remaining: Math.max(0, max - bucket.count),
      limit: max,
      resetMs: Math.max(0, resetMs),
      retryAfter: Math.max(1, Math.ceil(resetMs / 1000)),
    };
  }

  /** Comprueba sin consumir: útil para decidir antes de leer el cuerpo. */
  peek(key, { windowMs, max }) {
    const bucket = this.buckets.get(key);
    if (!bucket || Date.now() - bucket.startedAt >= windowMs) return { allowed: true, remaining: max };
    return { allowed: bucket.count < max, remaining: Math.max(0, max - bucket.count) };
  }

  reset(key) {
    return this.buckets.delete(key);
  }

  prune(reference = Date.now()) {
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      // Un cubo de más de una hora ya no sirve para ninguna ventana del proyecto.
      if (reference - bucket.startedAt > 3_600_000) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Cabeceras estándar para que el cliente pueda respetar el límite (M-0120). */
  headers(result) {
    return {
      'X-RateLimit-Limit': String(result.limit),
      'X-RateLimit-Remaining': String(result.remaining),
      'X-RateLimit-Reset': String(Math.ceil(result.resetMs / 1000)),
    };
  }

  describe() {
    return { buckets: this.buckets.size, ...this.stats };
  }
}
