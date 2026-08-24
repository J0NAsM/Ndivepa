/**
 * Registro estructurado (M-0122 … M-0124).
 * En desarrollo imprime una línea legible; en producción JSON por línea, apto
 * para cualquier recolector sin necesidad de un agente.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export class Logger {
  constructor({ level = 'info', pretty = false, context = {}, sink = console } = {}) {
    this.level = LEVELS[level] ? level : 'info';
    this.pretty = pretty;
    this.context = context;
    this.sink = sink;
    this.metrics = new Map();
  }

  /** Logger hijo que arrastra contexto (por ejemplo el `requestId`). */
  child(context = {}) {
    const child = new Logger({ level: this.level, pretty: this.pretty, context: { ...this.context, ...context }, sink: this.sink });
    child.metrics = this.metrics;
    return child;
  }

  write(level, message, data = {}) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const entry = { time: new Date().toISOString(), level, message, ...this.context, ...data };
    const target = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    if (this.pretty) {
      const extras = { ...this.context, ...data };
      const tail = Object.keys(extras).length ? ` ${JSON.stringify(extras)}` : '';
      this.sink[target](`[${level}] ${message}${tail}`);
    } else {
      this.sink[target](JSON.stringify(entry));
    }
  }

  debug(message, data) { this.write('debug', message, data); }
  info(message, data) { this.write('info', message, data); }
  warn(message, data) { this.write('warn', message, data); }

  error(message, data = {}) {
    const payload = data instanceof Error
      ? { error: data.message, code: data.code, stack: data.stack }
      : data;
    this.write('error', message, payload);
  }

  /** Métrica acumulada en memoria: conteo, total y máximo por clave (M-0124). */
  measure(key, durationMs) {
    const current = this.metrics.get(key) || { count: 0, totalMs: 0, maxMs: 0 };
    current.count += 1;
    current.totalMs += durationMs;
    current.maxMs = Math.max(current.maxMs, durationMs);
    this.metrics.set(key, current);
  }

  snapshot() {
    return Object.fromEntries(
      [...this.metrics.entries()].map(([key, value]) => [
        key,
        { ...value, avgMs: Math.round((value.totalMs / value.count) * 100) / 100 },
      ]),
    );
  }

  reset() {
    this.metrics.clear();
  }
}

export function createLogger(options) {
  return new Logger(options);
}
