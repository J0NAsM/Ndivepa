/**
 * Base común de todos los módulos (M-0277 … M-0284).
 *
 * Un recurso se declara una vez con `defineResource` y obtiene gratis: repositorio,
 * validación de creación y de parche, comprobación de unicidad, integridad
 * referencial, eventos de dominio, auditoría con antes/después, permisos y rutas
 * CRUD con filtros, orden, paginación, `fields` y `expand`.
 *
 * Esto es lo que sustituye al `mapped` del monolito, que aceptaba cualquier clave
 * del cuerpo sin validar nada.
 */
import { isSafePath, Repository } from '../framework/repository.js';
import { validate, rule } from '../framework/validate.js';
import { ValidationError } from '../framework/errors.js';
import { now } from '../framework/dates.js';
import { id as generateId } from '../framework/ids.js';

/** Campos que ningún cliente puede escribir nunca (M-0186). */
const PROTECTED_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt']);

/**
 * @typedef {object} ResourceDefinition
 * @property {string} name              nombre singular en camelCase (`product`)
 * @property {string} collection        colección en el documento (`products`)
 * @property {string} prefix            prefijo de identificador
 * @property {string} route             segmento de ruta (`products`)
 * @property {object} fields            esquema de validación
 * @property {string[]} [unique]        campos con unicidad
 * @property {object[]} [references]    integridad referencial
 * @property {string[]} [translatable]  campos traducibles
 * @property {boolean} [softDelete]
 * @property {string[]} [searchable]    campos usados por `?q=`
 * @property {object} [defaults]        valores por defecto al crear
 * @property {string[]} [expand]        relaciones expandibles
 * @property {boolean} [publicRead]     expuesto en la API de tienda
 */

export function defineResource(definition) {
  return {
    softDelete: true,
    unique: [],
    references: [],
    translatable: [],
    searchable: ['name'],
    defaults: {},
    expand: [],
    publicRead: false,
    ...definition,
  };
}

/** Esquema de query común a todos los listados (M-0878 … M-0880). */
export const LIST_QUERY = {
  q: rule.text(120),
  limit: { type: 'integer', coerce: true, min: 1, max: 200, default: 50 },
  offset: { type: 'integer', coerce: true, min: 0, default: 0 },
  after: rule.id(),
  order: rule.text(120),
  fields: rule.text(500),
  expand: rule.text(300),
  locale: rule.text(10),
  withDeleted: rule.flag(),
  filter: { type: 'object', shape: {}, allowUnknown: true },
};

/** Traduce `?order=-createdAt,name` a `{createdAt:'desc', name:'asc'}`. */
export function parseOrder(input, fallback = { createdAt: 'desc' }) {
  if (!input) return fallback;
  const order = {};
  for (const part of String(input).split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const field = trimmed.replace(/^[-+]/, '');
    if (!isSafePath(field)) throw ValidationError.single('order', `Campo de orden no permitido: ${field || '(vacío)'}.`);
    order[field] = trimmed.startsWith('-') ? 'desc' : 'asc';
  }
  return Object.keys(order).length ? order : fallback;
}

/**
 * Traduce los parámetros de query a un filtro del repositorio.
 * Admite `filter[status]=published`, `filter[price.amount][$gte]=1000` y `?q=texto`.
 */
export function buildFilter(query, resource) {
  const filter = {};
  const allowed = listableFields(resource);
  for (const [key, raw] of Object.entries(query.filter || {})) {
    const operatorMatch = /^(.+?)\[(\$[a-z]+)\]$/.exec(key);
    if (operatorMatch) {
      const [, field, operator] = operatorMatch;
      if (!allowed.has(field) || !isSafePath(field)) throw ValidationError.single(`filter.${field}`, 'Campo de filtro no permitido.');
      filter[field] = filter[field] || {};
      filter[field][operator] = coerceScalar(raw);
      continue;
    }
    if (!allowed.has(key) || !isSafePath(key)) throw ValidationError.single(`filter.${key}`, 'Campo de filtro no permitido.');
    if (String(raw).includes(',')) {
      filter[key] = { $in: String(raw).split(',').map(coerceScalar) };
      continue;
    }
    filter[key] = coerceScalar(raw);
  }
  if (query.q && resource.searchable?.length) {
    filter.$or = resource.searchable.map(field => ({ [field]: { $ilike: query.q } }));
  }
  return filter;
}

const SYSTEM_FIELDS = ['id', 'createdAt', 'updatedAt', 'deletedAt'];

/** Campos públicos que se pueden filtrar, ordenar o proyectar en un listado. */
function listableFields(resource) {
  const fields = new Set([...SYSTEM_FIELDS, ...(resource.searchable || [])]);
  const visit = (shape, prefix = '') => {
    for (const [name, definition] of Object.entries(shape || {})) {
      const path = prefix ? `${prefix}.${name}` : name;
      fields.add(path);
      if (definition?.type === 'object' && definition.shape && !definition.allowUnknown) visit(definition.shape, path);
    }
  };
  visit(resource.fields);
  return fields;
}

function coerceScalar(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value !== '' && !Number.isNaN(Number(value)) && /^-?\d+(\.\d+)?$/.test(String(value))) return Number(value);
  return value;
}

/**
 * Servicio con CRUD, validación, eventos y auditoría.
 * Los módulos de dominio lo extienden y añaden sus reglas propias.
 */
export class BaseService {
  /**
   * @param {object} deps
   * @param {ResourceDefinition} resource
   */
  constructor(deps, resource) {
    this.deps = deps;
    this.resource = resource;
    this.store = deps.store;
    this.events = deps.events;
    this.audit = deps.audit || null;
    this.customFields = deps.customFields || null;
    this.translations = deps.translations || null;
    this.repository = new Repository({
      store: deps.store,
      collection: resource.collection,
      prefix: resource.prefix,
      unique: resource.unique,
      softDelete: resource.softDelete,
      references: resource.references,
    });
  }

  get name() {
    return this.resource.name;
  }

  /** Esquema de creación: rechaza campos protegidos y desconocidos. */
  schema() {
    return this.resource.fields;
  }

  sanitize(input, { partial = false } = {}) {
    const cleaned = { ...input };
    for (const field of PROTECTED_FIELDS) delete cleaned[field];
    const customFields = cleaned.customFields;
    delete cleaned.customFields;
    const value = validate(cleaned, this.schema(), { partial });
    if (customFields !== undefined && this.customFields) {
      value.customFields = this.customFields.validate(this.resource.name, customFields);
    }
    return value;
  }

  list(query = {}, { locale = null } = {}) {
    const parsed = validate(query, LIST_QUERY, { partial: true });
    const allowed = listableFields(this.resource);
    const order = parseOrder(parsed.order);
    for (const field of Object.keys(order)) {
      if (!allowed.has(field)) throw ValidationError.single('order', `No se puede ordenar por ${field}.`);
    }
    const select = parsed.fields ? String(parsed.fields).split(',').map(field => field.trim()).filter(Boolean) : null;
    for (const field of select || []) {
      if (!allowed.has(field) || !isSafePath(field)) throw ValidationError.single('fields', `No se puede proyectar ${field}.`);
    }
    const expand = parsed.expand ? String(parsed.expand).split(',').map(field => field.trim()).filter(Boolean) : [];
    const unknownExpansions = expand.filter(field => !this.resource.expand.includes(field));
    if (unknownExpansions.length) throw ValidationError.single('expand', `Relaciones no expandibles: ${unknownExpansions.join(', ')}.`);
    const result = this.repository.list({
      filter: buildFilter(parsed, this.resource),
      order,
      limit: parsed.limit ?? 50,
      offset: parsed.offset ?? 0,
      after: parsed.after || null,
      select,
      withDeleted: Boolean(parsed.withDeleted),
    });
    let data = result.data;
    if (locale && this.translations && this.resource.translatable.length) {
      data = this.translations.applyAll(data, this.resource.name, locale);
    }
    if (expand.length) data = data.map(record => this.expand(record, expand));
    return { ...result, data };
  }

  retrieve(identifier, { expand = [], locale = null } = {}) {
    let record = this.repository.retrieve(identifier);
    if (locale && this.translations && this.resource.translatable.length) {
      record = this.translations.apply(record, this.resource.name, locale);
    }
    return expand.length ? this.expand(record, expand) : record;
  }

  find(filter, options = {}) {
    return this.repository.find(filter, options);
  }

  count(filter = {}) {
    return this.repository.count(filter);
  }

  /** Los módulos sobrescriben esto para resolver sus relaciones (M-0876). */
  expand(record, _relations) {
    return record;
  }

  /** Gancho antes de crear: los módulos añaden reglas de negocio. */
  async beforeCreate(data) {
    return data;
  }

  async afterCreate(_record, _ctx) {}

  async beforeUpdate(_existing, changes) {
    return changes;
  }

  async afterUpdate(_before, _after, _ctx) {}

  async beforeDelete(_record) {}

  async create(input, ctx = null) {
    const data = await this.beforeCreate({ ...this.resource.defaults, ...this.sanitize(input) }, ctx);
    const record = await this.store.transaction(state => this.repository.insert(state, data));
    await this.emit('created', record, ctx);
    await this.afterCreate(record, ctx);
    return record;
  }

  async update(identifier, input, ctx = null) {
    const existing = this.repository.retrieve(identifier);
    const changes = await this.beforeUpdate(existing, this.sanitize(input, { partial: true }), ctx);
    if (!changes || !Object.keys(changes).length) throw ValidationError.single('body', 'Envía al menos un campo para actualizar.');
    const { before, after } = await this.store.transaction(state => this.repository.patch(state, identifier, changes));
    await this.emit('updated', after, ctx, before);
    await this.afterUpdate(before, after, ctx);
    return after;
  }

  async delete(identifier, ctx = null, options = {}) {
    const existing = this.repository.retrieve(identifier);
    await this.beforeDelete(existing, ctx);
    const removed = await this.store.transaction(state => this.repository.remove(state, identifier, options));
    await this.emit('deleted', removed, ctx);
    return removed;
  }

  async restore(identifier, ctx = null) {
    const record = await this.store.transaction(state => this.repository.restore(state, identifier));
    await this.emit('restored', record, ctx);
    return record;
  }

  /** Evento de dominio + auditoría, siempre en pareja (M-0283, M-0284). */
  async emit(action, record, ctx = null, before = null) {
    const eventName = `${this.resource.name}.${action}`;
    await this.events.emit(eventName, {
      id: record?.id,
      record,
      before,
      actor: ctx?.actor?.id || null,
      requestId: ctx?.requestId || null,
    });
    if (this.audit && action !== 'read') {
      await this.audit.record({
        action: `${this.resource.name}_${action}`,
        entity: this.resource.name,
        entityId: record?.id || null,
        before: action === 'created' ? null : before,
        after: action === 'deleted' ? null : record,
        ctx,
      });
    }
  }

  /** Operaciones en lote (M-0881). Devuelve un informe por elemento. */
  async bulk(operation, items, ctx = null) {
    const report = { ok: 0, failed: 0, results: [] };
    for (const [index, item] of items.entries()) {
      try {
        const result = await operation(item, ctx);
        report.ok += 1;
        report.results.push({ index, status: 'ok', id: result?.id || null });
      } catch (error) {
        report.failed += 1;
        report.results.push({
          index,
          status: 'error',
          code: error.code || 'error',
          message: error.message,
          issues: error.issues || null,
        });
      }
    }
    return report;
  }

  /** Semilla idempotente por clave natural (M-0285). */
  async seed(rows, key = 'id') {
    return this.store.transaction(state => {
      const created = [];
      for (const row of rows) {
        const existing = this.repository.raw(state).find(item => item[key] === row[key]);
        if (existing) continue;
        created.push(this.repository.insert(state, { ...this.resource.defaults, ...row }));
      }
      return created;
    });
  }
}

/**
 * Genera las rutas CRUD de administración de un recurso (M-0279).
 * Cada ruta declara su permiso: una ruta administrativa sin permiso es un defecto
 * que la prueba de conformidad detecta (M-0298, M-0299).
 */
export function crudRoutes(resource, getService, { permissionResource = resource.name, tags = [] } = {}) {
  const base = `/${resource.route}`;
  const service = ctx => getService(ctx);

  return [
    {
      method: 'GET',
      path: base,
      permission: `${permissionResource}:read`,
      summary: `Lista ${resource.route} con filtros, orden y paginación.`,
      tags,
      query: LIST_QUERY,
      bodyless: true,
      handler: ctx => service(ctx).list(ctx.query, { locale: ctx.locale }),
    },
    {
      method: 'GET',
      path: `${base}/:id`,
      permission: `${permissionResource}:read`,
      summary: `Recupera un registro de ${resource.route}.`,
      tags,
      bodyless: true,
      handler: ctx => service(ctx).retrieve(ctx.params.id, {
        expand: ctx.query.expand ? String(ctx.query.expand).split(',') : [],
        locale: ctx.locale,
      }),
    },
    {
      method: 'POST',
      path: base,
      permission: `${permissionResource}:create`,
      summary: `Crea un registro de ${resource.route}.`,
      tags,
      status: 201,
      body: resource.fields,
      bodyRequired: true,
      handler: ctx => service(ctx).create(ctx.body, ctx),
    },
    {
      method: 'PATCH',
      path: `${base}/:id`,
      permission: `${permissionResource}:update`,
      summary: `Actualiza un registro de ${resource.route}.`,
      tags,
      body: resource.fields,
      handler: ctx => service(ctx).update(ctx.params.id, ctx.body, ctx),
    },
    {
      method: 'DELETE',
      path: `${base}/:id`,
      permission: `${permissionResource}:delete`,
      summary: `Borra un registro de ${resource.route}.`,
      tags,
      bodyless: true,
      handler: ctx => service(ctx).delete(ctx.params.id, ctx),
    },
    {
      method: 'POST',
      path: `${base}/:id/restore`,
      permission: `${permissionResource}:update`,
      summary: `Restaura un registro borrado de ${resource.route}.`,
      tags,
      handler: ctx => service(ctx).restore(ctx.params.id, ctx),
    },
    {
      method: 'POST',
      path: `${base}/bulk`,
      permission: `${permissionResource}:create`,
      summary: `Crea varios registros de ${resource.route} e informa fila por fila.`,
      tags,
      body: { items: { type: 'array', required: true, maxItems: 500, items: { type: 'object', shape: {}, allowUnknown: true } } },
      handler: async ctx => {
        const svc = service(ctx);
        if (!Array.isArray(ctx.body.items)) throw ValidationError.single('items', 'Envía un array en `items`.');
        return svc.bulk((item, context) => svc.create(item, context), ctx.body.items, ctx);
      },
    },
  ];
}

/** Registro de auditoría compartido por todos los módulos. */
export class AuditService {
  constructor({ store, collection = 'audits', limit = 5000 }) {
    this.store = store;
    this.collection = collection;
    this.limit = limit;
  }

  async record({ action, entity, entityId = null, before = null, after = null, ctx = null, note = null }) {
    const entry = {
      id: generateId('audit'),
      action,
      entity,
      entityId,
      before: trim(before),
      after: trim(after),
      note,
      actorId: ctx?.actor?.id || 'system',
      actorType: ctx?.actor?.type || 'system',
      ip: ctx?.ip || null,
      requestId: ctx?.requestId || null,
      timestamp: now(),
    };
    await this.store.transaction(state => {
      if (!Array.isArray(state[this.collection])) state[this.collection] = [];
      state[this.collection].unshift(entry);
      if (state[this.collection].length > this.limit) state[this.collection].length = this.limit;
    });
    return entry;
  }

  list({ limit = 100, entity = null, entityId = null, actorId = null } = {}) {
    return this.store
      .collection(this.collection)
      .filter(row => (!entity || row.entity === entity) && (!entityId || row.entityId === entityId) && (!actorId || row.actorId === actorId))
      .slice(0, limit);
  }
}

/** Evita que la auditoría guarde documentos enormes. */
function trim(value) {
  if (value === null || value === undefined) return null;
  const text = JSON.stringify(value);
  if (text.length <= 4000) return value;
  return { truncated: true, preview: `${text.slice(0, 4000)}…`, bytes: text.length };
}
