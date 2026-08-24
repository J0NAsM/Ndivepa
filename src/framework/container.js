/**
 * Contenedor y registro de módulos (M-0093 … M-0095, M-0286 … M-0295).
 *
 * Sustituye el acoplamiento por `globalThis` del monolito. Cada módulo declara qué
 * necesita; el contenedor calcula el orden topológico, detecta ciclos y arranca en
 * el orden correcto. Un módulo nunca importa el servicio de otro (M-0291).
 */
import { NdivepaError } from './errors.js';

export class Container {
  constructor({ logger } = {}) {
    this.logger = logger;
    this.definitions = new Map();
    this.instances = new Map();
    this.modules = new Map();
    this.bootOrder = [];
    this.timings = new Map();
  }

  /** Registra un valor ya construido (config, store, bus…). */
  value(name, instance) {
    if (this.instances.has(name)) {
      throw new NdivepaError(`El servicio "${name}" ya está registrado.`, { code: 'container_conflict', status: 500 });
    }
    this.instances.set(name, instance);
    return this;
  }

  /** Registra una fábrica perezosa. */
  factory(name, requires, build) {
    if (this.definitions.has(name) || this.instances.has(name)) {
      throw new NdivepaError(`El servicio "${name}" ya está registrado.`, { code: 'container_conflict', status: 500 });
    }
    this.definitions.set(name, { requires, build });
    return this;
  }

  /**
   * Registra un módulo de dominio con el contrato único del proyecto.
   * @param {{name:string, requires?:string[], models?:object, migrations?:Array, register:Function,
   *          routes?:object, subscribers?:Array, jobs?:Array, seed?:Function, permissions?:Array}} definition
   */
  module(definition) {
    if (!definition?.name) throw new NdivepaError('Un módulo debe declarar `name`.', { code: 'module_invalid', status: 500 });
    if (this.modules.has(definition.name)) {
      // Nombres duplicados detectados en el arranque (M-0289).
      throw new NdivepaError(`El módulo "${definition.name}" está registrado dos veces.`, { code: 'module_duplicate', status: 500 });
    }
    if (typeof definition.register !== 'function') {
      throw new NdivepaError(`El módulo "${definition.name}" debe exportar \`register\`.`, { code: 'module_invalid', status: 500 });
    }
    this.modules.set(definition.name, definition);
    this.definitions.set(definition.name, { requires: definition.requires || [], build: definition.register });
    return this;
  }

  has(name) {
    return this.instances.has(name) || this.definitions.has(name);
  }

  resolve(name, chain = []) {
    if (this.instances.has(name)) return this.instances.get(name);
    const definition = this.definitions.get(name);
    if (!definition) {
      // Dependencia no satisfecha con mensaje claro (M-0290).
      const path = chain.length ? ` (requerido por ${chain.join(' -> ')})` : '';
      throw new NdivepaError(`No hay servicio registrado con el nombre "${name}"${path}.`, {
        code: 'dependency_missing',
        status: 500,
        details: { name, chain },
      });
    }
    if (chain.includes(name)) {
      throw new NdivepaError(`Dependencia circular detectada: ${[...chain, name].join(' -> ')}.`, {
        code: 'dependency_cycle',
        status: 500,
        details: { cycle: [...chain, name] },
      });
    }

    const startedAt = Date.now();
    const dependencies = {};
    for (const requirement of definition.requires || []) {
      dependencies[requirement] = this.resolve(requirement, [...chain, name]);
    }
    const instance = definition.build({ ...dependencies, container: this, resolve: key => this.resolve(key, [...chain, name]) });
    this.instances.set(name, instance);
    this.timings.set(name, Date.now() - startedAt);
    return instance;
  }

  /** Orden topológico de arranque (M-0094). */
  topologicalOrder() {
    const visited = new Set();
    const visiting = new Set();
    const order = [];
    const visit = name => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new NdivepaError(`Dependencia circular en el arranque: ${[...visiting, name].join(' -> ')}.`, {
          code: 'dependency_cycle',
          status: 500,
        });
      }
      visiting.add(name);
      for (const requirement of this.modules.get(name)?.requires || []) {
        if (this.modules.has(requirement)) visit(requirement);
      }
      visiting.delete(name);
      visited.add(name);
      order.push(name);
    };
    for (const name of this.modules.keys()) visit(name);
    return order;
  }

  /** Ciclo de vida `register` -> `boot` -> `shutdown` (M-0095). */
  async boot(context = {}) {
    this.bootOrder = this.topologicalOrder();
    for (const name of this.bootOrder) {
      const startedAt = Date.now();
      const service = this.resolve(name);
      const definition = this.modules.get(name);
      if (typeof definition.boot === 'function') await definition.boot({ ...context, service, container: this });
      if (typeof service?.boot === 'function') await service.boot(context);
      this.timings.set(name, Date.now() - startedAt);
    }
    this.logger?.info('Módulos arrancados', { count: this.bootOrder.length, order: this.bootOrder });
    return this.bootOrder;
  }

  async shutdown() {
    for (const name of [...this.bootOrder].reverse()) {
      const service = this.instances.get(name);
      try {
        if (typeof service?.shutdown === 'function') await service.shutdown();
      } catch (error) {
        this.logger?.error('Fallo al apagar un módulo', { module: name, error: error.message });
      }
    }
  }

  /** Todos los módulos que declaran una propiedad concreta (rutas, jobs, permisos…). */
  collect(property) {
    const output = [];
    for (const definition of this.modules.values()) {
      const value = definition[property];
      if (!value) continue;
      output.push({ module: definition.name, value });
    }
    return output;
  }

  /** Diagnóstico: qué hay registrado y cuánto tardó en construirse (M-0287, M-0294). */
  describe() {
    return {
      services: [...this.instances.keys()].sort(),
      modules: [...this.modules.keys()].sort(),
      bootOrder: this.bootOrder,
      timingsMs: Object.fromEntries([...this.timings.entries()].sort((a, b) => b[1] - a[1])),
    };
  }
}
