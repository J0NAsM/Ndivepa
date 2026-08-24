/**
 * Motor de workflows con compensación (M-0089 … M-0092).
 *
 * Idea tomada de `@medusajs/orchestration`: un proceso de negocio que toca varios
 * dominios se declara como pasos, y **cada paso declara cómo deshacerse**. Si el
 * cobro falla después de reservar stock, la compensación libera la reserva; nadie
 * tiene que acordarse de hacerlo en un `catch`.
 */
import { NdivepaError } from './errors.js';
import { id as generateId } from './ids.js';
import { now } from './dates.js';

export class WorkflowDefinition {
  constructor(name) {
    this.name = name;
    this.steps = [];
  }

  /**
   * @param {string} name nombre del paso
   * @param {(context:object)=>any} invoke acción
   * @param {(output:any, context:object)=>any} [compensate] cómo deshacerla
   */
  step(name, invoke, compensate = null) {
    this.steps.push({ name, invoke, compensate });
    return this;
  }
}

export class WorkflowEngine {
  constructor({ logger, store, collection = 'workflowRuns', historyLimit = 200 } = {}) {
    this.logger = logger;
    this.store = store;
    this.collection = collection;
    this.historyLimit = historyLimit;
    this.definitions = new Map();
    this.idempotency = new Map();
    this.history = [];
  }

  define(name, build) {
    const definition = new WorkflowDefinition(name);
    build(definition);
    this.definitions.set(name, definition);
    return definition;
  }

  list() {
    return [...this.definitions.keys()].sort();
  }

  /**
   * Ejecuta un workflow.
   * @param {string} name
   * @param {object} input
   * @param {{idempotencyKey?:string, actor?:object}} options
   */
  async run(name, input = {}, { idempotencyKey = null, actor = null } = {}) {
    const definition = this.definitions.get(name);
    if (!definition) {
      throw new NdivepaError(`No existe el workflow "${name}".`, { code: 'workflow_missing', status: 500 });
    }

    // Idempotencia (M-0091): el mismo pago reintentado no cobra dos veces.
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      const cached = this.idempotency.get(idempotencyKey);
      return { ...cached, idempotent: true };
    }

    const runId = generateId('wfrun');
    const trace = [];
    const completed = [];
    const context = { input, actor, runId, results: {}, workflow: name };

    for (const step of definition.steps) {
      const startedAt = Date.now();
      try {
        const output = await step.invoke(context);
        context.results[step.name] = output;
        completed.push({ step, output });
        trace.push({ step: step.name, status: 'done', durationMs: Date.now() - startedAt });
      } catch (error) {
        trace.push({ step: step.name, status: 'failed', error: error.message, durationMs: Date.now() - startedAt });
        const compensations = await this.compensate(completed, context, trace);
        await this.record({ runId, name, status: 'compensated', trace, actor, error: error.message });
        this.logger?.warn('Workflow compensado', { workflow: name, step: step.name, error: error.message, compensations });
        throw error;
      }
    }

    const result = { runId, workflow: name, status: 'completed', results: context.results, trace };
    await this.record({ runId, name, status: 'completed', trace, actor, error: null });
    if (idempotencyKey) {
      this.idempotency.set(idempotencyKey, result);
      // Se olvida al cabo de una hora: es una red contra el doble clic, no un almacén.
      setTimeout(() => this.idempotency.delete(idempotencyKey), 3_600_000).unref?.();
    }
    return result;
  }

  /** Compensa en orden inverso (M-0090). Un fallo al compensar se registra y no detiene el resto. */
  async compensate(completed, context, trace) {
    let count = 0;
    for (const entry of [...completed].reverse()) {
      if (!entry.step.compensate) continue;
      try {
        await entry.step.compensate(entry.output, context);
        trace.push({ step: entry.step.name, status: 'compensated' });
        count += 1;
      } catch (error) {
        trace.push({ step: entry.step.name, status: 'compensation_failed', error: error.message });
        this.logger?.error('La compensación falló y requiere revisión manual', {
          workflow: context.workflow,
          step: entry.step.name,
          error: error.message,
        });
      }
    }
    return count;
  }

  /** Registro del recorrido para depuración (M-0092). */
  async record(entry) {
    const record = { ...entry, finishedAt: now() };
    this.history.unshift(record);
    if (this.history.length > this.historyLimit) this.history.length = this.historyLimit;
    if (!this.store) return record;
    try {
      await this.store.transaction(state => {
        if (!Array.isArray(state[this.collection])) state[this.collection] = [];
        state[this.collection].unshift(record);
        if (state[this.collection].length > this.historyLimit) state[this.collection].length = this.historyLimit;
      });
    } catch {
      /* la traza no debe impedir que el workflow devuelva su resultado */
    }
    return record;
  }

  runs({ limit = 50 } = {}) {
    return this.history.slice(0, limit);
  }
}
