/**
 * Cola de trabajos y programación (M-0082 … M-0086, M-0305).
 *
 * Sin Redis ni proceso aparte: la cola vive en el documento, de modo que sobrevive
 * a un reinicio, y un temporizador la va vaciando. El objetivo no es procesar
 * millones de mensajes, es que reindexar el catálogo o revisar precios no bloquee
 * una petición HTTP.
 */
import { id as generateId } from './ids.js';
import { now, toDate } from './dates.js';

export const JOB_STATES = ['pending', 'running', 'done', 'failed', 'cancelled'];

export class JobQueue {
  constructor({ store, logger, collection = 'jobs', tickMs = 30_000, enabled = true } = {}) {
    this.store = store;
    this.logger = logger;
    this.collection = collection;
    this.tickMs = tickMs;
    this.enabled = enabled;
    this.handlers = new Map();
    this.schedules = [];
    this.running = new Map();
    this.timer = null;
    this.stats = { processed: 0, failed: 0, scheduled: 0 };
  }

  /**
   * @param {string} name identificador del trabajo
   * @param {(payload:object, meta:object)=>any} handler
   * @param {{concurrency?:number, maxAttempts?:number}} options
   */
  register(name, handler, { concurrency = 1, maxAttempts = 3 } = {}) {
    this.handlers.set(name, { handler, concurrency, maxAttempts });
    return this;
  }

  /** Programa un trabajo recurrente por intervalo (M-0084). */
  schedule(name, { everyMs, payload = {} }) {
    this.schedules.push({ name, everyMs, payload, lastRunAt: null });
    return this;
  }

  /** Encola un trabajo. `runAt` permite diferirlo. */
  async enqueue(name, payload = {}, { runAt = null, maxAttempts = null, dedupeKey = null } = {}) {
    return this.store.transaction(state => {
      if (!Array.isArray(state[this.collection])) state[this.collection] = [];
      if (dedupeKey) {
        const duplicate = state[this.collection].find(
          job => job.dedupeKey === dedupeKey && ['pending', 'running'].includes(job.status),
        );
        if (duplicate) return duplicate;
      }
      const job = {
        id: generateId('job'),
        name,
        payload,
        status: 'pending',
        attempts: 0,
        maxAttempts: maxAttempts ?? this.handlers.get(name)?.maxAttempts ?? 3,
        runAt: runAt || now(),
        dedupeKey,
        lastError: null,
        startedAt: null,
        finishedAt: null,
        createdAt: now(),
      };
      state[this.collection].unshift(job);
      if (state[this.collection].length > 5000) state[this.collection].length = 5000;
      return job;
    });
  }

  pending() {
    const reference = Date.now();
    return this.store
      .collection(this.collection)
      .filter(job => job.status === 'pending' && (toDate(job.runAt)?.getTime() ?? 0) <= reference)
      .sort((a, b) => String(a.runAt).localeCompare(String(b.runAt)));
  }

  async cancel(jobId) {
    return this.store.transaction(state => {
      const job = (state[this.collection] || []).find(entry => entry.id === jobId);
      if (!job || job.status !== 'pending') return null;
      job.status = 'cancelled';
      job.finishedAt = now();
      return job;
    });
  }

  async markStatus(jobId, changes) {
    return this.store.transaction(state => {
      const job = (state[this.collection] || []).find(entry => entry.id === jobId);
      if (!job) return null;
      Object.assign(job, changes);
      return job;
    });
  }

  /** Procesa un lote respetando la concurrencia declarada por nombre (M-0085). */
  async processBatch(limit = 10) {
    const queue = this.pending().slice(0, limit);
    const results = [];
    for (const job of queue) {
      const definition = this.handlers.get(job.name);
      if (!definition) {
        await this.markStatus(job.id, { status: 'failed', lastError: `Sin manejador registrado para "${job.name}".`, finishedAt: now() });
        results.push({ id: job.id, status: 'failed' });
        continue;
      }
      const active = this.running.get(job.name) || 0;
      if (active >= definition.concurrency) continue;

      this.running.set(job.name, active + 1);
      await this.markStatus(job.id, { status: 'running', startedAt: now(), attempts: job.attempts + 1 });
      const startedAt = Date.now();
      try {
        const output = await definition.handler(job.payload, { job, logger: this.logger });
        await this.markStatus(job.id, { status: 'done', finishedAt: now(), lastError: null, output: summarize(output) });
        this.stats.processed += 1;
        results.push({ id: job.id, status: 'done', durationMs: Date.now() - startedAt });
      } catch (error) {
        const attempts = job.attempts + 1;
        const exhausted = attempts >= job.maxAttempts;
        await this.markStatus(job.id, {
          status: exhausted ? 'failed' : 'pending',
          lastError: error.message,
          finishedAt: exhausted ? now() : null,
          // Backoff exponencial antes de volver a intentarlo.
          runAt: exhausted ? job.runAt : new Date(Date.now() + 2 ** attempts * 1000).toISOString(),
        });
        if (exhausted) this.stats.failed += 1;
        this.logger?.warn('Trabajo fallido', { job: job.name, attempts, error: error.message });
        results.push({ id: job.id, status: exhausted ? 'failed' : 'retry' });
      } finally {
        this.running.set(job.name, Math.max(0, (this.running.get(job.name) || 1) - 1));
      }
    }
    return results;
  }

  async runSchedules() {
    const reference = Date.now();
    for (const entry of this.schedules) {
      const last = entry.lastRunAt ? toDate(entry.lastRunAt)?.getTime() ?? 0 : 0;
      if (reference - last < entry.everyMs) continue;
      entry.lastRunAt = new Date(reference).toISOString();
      this.stats.scheduled += 1;
      await this.enqueue(entry.name, entry.payload, { dedupeKey: `schedule:${entry.name}` });
    }
  }

  start() {
    if (!this.enabled || this.timer) return this;
    const tick = async () => {
      try {
        await this.runSchedules();
        await this.processBatch();
      } catch (error) {
        this.logger?.error('Fallo al procesar la cola de trabajos', error);
      }
    };
    this.timer = setInterval(tick, this.tickMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Catálogo de trabajos para el diagnóstico (M-0305). */
  catalog() {
    const jobs = this.store.collection(this.collection);
    const byStatus = {};
    for (const state of JOB_STATES) byStatus[state] = jobs.filter(job => job.status === state).length;
    return {
      handlers: [...this.handlers.keys()].sort(),
      schedules: this.schedules.map(entry => ({ name: entry.name, everyMs: entry.everyMs, lastRunAt: entry.lastRunAt })),
      byStatus,
      stats: { ...this.stats },
    };
  }
}

function summarize(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    const text = JSON.stringify(value);
    return text.length > 500 ? `${text.slice(0, 500)}…` : value;
  }
  return String(value).slice(0, 500);
}
