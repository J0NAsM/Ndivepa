/**
 * Caché en memoria con TTL e invalidación por etiqueta (M-0088, M-0540 … M-0543).
 *
 * El precio calculado y la disponibilidad son las dos consultas más repetidas del
 * catálogo. Cachearlas por clave no basta: al cambiar una regla de precio hay que
 * invalidar todo lo que dependía de ella, y para eso están las etiquetas.
 */

export class Cache {
  constructor({ defaultTtlMs = 30_000, maxEntries = 5000 } = {}) {
    this.defaultTtlMs = defaultTtlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.tags = new Map();
    this.stats = { hits: 0, misses: 0, evictions: 0, invalidations: 0 };
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      this.stats.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.delete(key);
      this.stats.misses += 1;
      return undefined;
    }
    this.stats.hits += 1;
    return entry.value;
  }

  set(key, value, { ttlMs = this.defaultTtlMs, tags = [] } = {}) {
    if (this.entries.size >= this.maxEntries) this.evictOldest();
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs, tags });
    for (const tag of tags) {
      if (!this.tags.has(tag)) this.tags.set(tag, new Set());
      this.tags.get(tag).add(key);
    }
    return value;
  }

  /** Lee o calcula. La función solo se ejecuta si falta o caducó. */
  async remember(key, factory, options = {}) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await factory();
    return this.set(key, value, options);
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (entry) for (const tag of entry.tags) this.tags.get(tag)?.delete(key);
    return this.entries.delete(key);
  }

  /** Invalida todo lo etiquetado, por ejemplo `price:prod_123` o `inventory`. */
  invalidateTag(tag) {
    const keys = this.tags.get(tag);
    if (!keys) return 0;
    let removed = 0;
    for (const key of keys) if (this.delete(key)) removed += 1;
    this.tags.delete(tag);
    this.stats.invalidations += removed;
    return removed;
  }

  invalidateTags(tags = []) {
    return tags.reduce((total, tag) => total + this.invalidateTag(tag), 0);
  }

  evictOldest() {
    const oldest = this.entries.keys().next().value;
    if (oldest !== undefined) {
      this.delete(oldest);
      this.stats.evictions += 1;
    }
  }

  clear() {
    this.entries.clear();
    this.tags.clear();
  }

  /** Retira las entradas caducadas; se llama desde el temporizador de trabajos. */
  prune() {
    const reference = Date.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= reference) {
        this.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  describe() {
    const total = this.stats.hits + this.stats.misses;
    return {
      entries: this.entries.size,
      tags: this.tags.size,
      ...this.stats,
      hitRate: total ? Math.round((this.stats.hits / total) * 1000) / 10 : null,
    };
  }
}
