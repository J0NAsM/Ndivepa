/**
 * Bloqueos con expiración (M-0087, M-0518).
 *
 * Dos clientes comprando la última unidad a la vez es el caso clásico de
 * sobreventa. El `Store` ya serializa las escrituras, pero un proceso de negocio
 * abarca varias lecturas y escrituras: eso es lo que protege este mutex.
 */
import { ConflictError } from './errors.js';

export class LockService {
  constructor({ defaultTtlMs = 10_000, logger } = {}) {
    this.defaultTtlMs = defaultTtlMs;
    this.logger = logger;
    this.locks = new Map();
    this.stats = { acquired: 0, waited: 0, timeouts: 0 };
  }

  isHeld(key) {
    const entry = this.locks.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
      this.locks.delete(key);
      return false;
    }
    return true;
  }

  /** Intento sin espera. Devuelve la función de liberación o `null`. */
  tryAcquire(key, { ttlMs = this.defaultTtlMs, owner = 'anónimo' } = {}) {
    if (this.isHeld(key)) return null;
    const entry = { owner, expiresAt: Date.now() + ttlMs };
    this.locks.set(key, entry);
    this.stats.acquired += 1;
    return () => {
      if (this.locks.get(key) === entry) this.locks.delete(key);
    };
  }

  async acquire(key, { ttlMs = this.defaultTtlMs, waitMs = 5000, owner = 'anónimo' } = {}) {
    const deadline = Date.now() + waitMs;
    let release = this.tryAcquire(key, { ttlMs, owner });
    if (release) return release;
    this.stats.waited += 1;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      release = this.tryAcquire(key, { ttlMs, owner });
      if (release) return release;
    }
    this.stats.timeouts += 1;
    throw new ConflictError(`No se pudo obtener el bloqueo "${key}"; otra operación lo mantiene.`, { key });
  }

  /** Ejecuta la función con el bloqueo tomado y lo libera siempre. */
  async withLock(key, fn, options = {}) {
    const release = await this.acquire(key, options);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Igual que `withLock` pero sobre varias claves, ordenadas para evitar interbloqueos. */
  async withLocks(keys, fn, options = {}) {
    const ordered = [...new Set(keys)].sort();
    const releases = [];
    try {
      for (const key of ordered) releases.push(await this.acquire(key, options));
      return await fn();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  prune() {
    const reference = Date.now();
    let removed = 0;
    for (const [key, entry] of this.locks) {
      if (entry.expiresAt <= reference) {
        this.locks.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  describe() {
    return { held: this.locks.size, ...this.stats };
  }
}
