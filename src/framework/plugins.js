/**
 * Cargador de extensiones (M-0121).
 *
 * Al estilo `VendurePlugin`: un plugin declara módulos, estrategias, suscriptores,
 * trabajos, rutas y campos personalizados. El orden de aplicación es determinista
 * (por `order` y luego por nombre) para que dos plugins que tocan la misma
 * estrategia no dependan del orden de lectura del disco.
 */
import { NdivepaError } from './errors.js';

export class PluginRegistry {
  constructor({ logger } = {}) {
    this.logger = logger;
    this.plugins = [];
    this.applied = [];
  }

  /**
   * @param {{name:string, order?:number, modules?:Array, strategies?:object,
   *          subscribers?:Array, jobs?:Array, routes?:object, customFields?:Array,
   *          permissions?:Array, setup?:Function}} plugin
   */
  register(plugin) {
    if (!plugin?.name) throw new NdivepaError('Un plugin debe declarar `name`.', { code: 'plugin_invalid', status: 500 });
    if (this.plugins.some(entry => entry.name === plugin.name)) {
      throw new NdivepaError(`El plugin "${plugin.name}" ya está registrado.`, { code: 'plugin_duplicate', status: 500 });
    }
    this.plugins.push({ order: 100, ...plugin });
    return this;
  }

  ordered() {
    return [...this.plugins].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }

  /**
   * Aplica los plugins sobre el contenedor y los registros del framework.
   * @param {{container:object, strategies:object, events:object, jobs:object,
   *          customFields:object, permissions:object, routes:{admin:Array,store:Array}}} context
   */
  async apply(context) {
    for (const plugin of this.ordered()) {
      const summary = { name: plugin.name, modules: 0, strategies: 0, subscribers: 0, jobs: 0, routes: 0 };

      for (const module of plugin.modules || []) {
        context.container.module(module);
        summary.modules += 1;
      }
      for (const [name, implementation] of Object.entries(plugin.strategies || {})) {
        context.strategies.replace(name, implementation);
        summary.strategies += 1;
      }
      for (const subscriber of plugin.subscribers || []) {
        context.events.subscribe(subscriber.event, subscriber.handler, { name: `${plugin.name}:${subscriber.event}` });
        summary.subscribers += 1;
      }
      for (const job of plugin.jobs || []) {
        context.jobs.register(job.name, job.handler, job.options);
        if (job.everyMs) context.jobs.schedule(job.name, { everyMs: job.everyMs, payload: job.payload || {} });
        summary.jobs += 1;
      }
      for (const field of plugin.customFields || []) {
        context.customFields.declare(field.entity, field);
      }
      for (const permission of plugin.permissions || []) {
        context.permissions.declare(permission.resource, permission);
      }
      for (const [scope, routes] of Object.entries(plugin.routes || {})) {
        if (!context.routes[scope]) context.routes[scope] = [];
        context.routes[scope].push(...routes);
        summary.routes += routes.length;
      }
      if (typeof plugin.setup === 'function') await plugin.setup(context);

      this.applied.push(summary);
      this.logger?.info('Plugin aplicado', summary);
    }
    return this.applied;
  }

  describe() {
    return { registered: this.ordered().map(plugin => plugin.name), applied: this.applied };
  }
}
