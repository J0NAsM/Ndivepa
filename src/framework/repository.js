/**
 * Repositorio sobre el documento del `Store` (M-0062 … M-0077).
 *
 * Da a los servicios de dominio una API estable: filtros con operadores, orden,
 * paginación, proyección, borrado lógico, unicidad e integridad referencial. El
 * día que detrás haya SQLite o PostgreSQL, cambia esta clase y ningún módulo se
 * entera.
 */
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { id as generateId } from './ids.js';
import { now } from './dates.js';

const BLOCKED_PATH_PARTS = new Set(['__proto__', 'prototype', 'constructor']);

/** Solo admite rutas de propiedades simples; evita proyección/prototype pollution. */
export function isSafePath(path) {
  const parts = String(path ?? '').split('.');
  return parts.length > 0 && parts.every(part => /^[A-Za-z][A-Za-z0-9_]*$/.test(part) && !BLOCKED_PATH_PARTS.has(part));
}

/** Lee `a.b.c` sobre un objeto anidado (M-0066). */
export function getPath(source, path) {
  if (!isSafePath(path)) return undefined;
  if (!path.includes('.')) return source?.[path];
  return path.split('.').reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), source);
}

const OPERATORS = {
  $eq: (value, expected) => value === expected,
  $ne: (value, expected) => value !== expected,
  $in: (value, expected) => Array.isArray(expected) && expected.includes(value),
  $nin: (value, expected) => Array.isArray(expected) && !expected.includes(value),
  $gt: (value, expected) => value !== null && value !== undefined && value > expected,
  $gte: (value, expected) => value !== null && value !== undefined && value >= expected,
  $lt: (value, expected) => value !== null && value !== undefined && value < expected,
  $lte: (value, expected) => value !== null && value !== undefined && value <= expected,
  $like: (value, expected) => String(value ?? '').includes(String(expected)),
  $ilike: (value, expected) => String(value ?? '').toLowerCase().includes(String(expected).toLowerCase()),
  $exists: (value, expected) => (value !== undefined && value !== null) === Boolean(expected),
  $null: (value, expected) => (value === null || value === undefined) === Boolean(expected),
  $contains: (value, expected) => Array.isArray(value)
    && (Array.isArray(expected) ? expected.every(item => value.includes(item)) : value.includes(expected)),
  $overlaps: (value, expected) => Array.isArray(value) && Array.isArray(expected)
    && expected.some(item => value.includes(item)),
  $between: (value, expected) => Array.isArray(expected) && expected.length === 2
    && value >= expected[0] && value <= expected[1],
};

/** Evalúa un filtro declarativo contra un registro. */
export function matches(record, filter) {
  if (!filter || typeof filter !== 'object') return true;
  for (const [key, expected] of Object.entries(filter)) {
    if (key === '$and') {
      if (!Array.isArray(expected)) throw ValidationError.single(key, 'El operador lógico requiere una lista de filtros.');
      if (!expected.every(inner => matches(record, inner))) return false;
      continue;
    }
    if (key === '$or') {
      if (!Array.isArray(expected)) throw ValidationError.single(key, 'El operador lógico requiere una lista de filtros.');
      if (!expected.some(inner => matches(record, inner))) return false;
      continue;
    }
    if (key === '$not') {
      if (matches(record, expected)) return false;
      continue;
    }
    const value = getPath(record, key);
    if (!isSafePath(key)) throw ValidationError.single(key, 'Ruta de campo no permitida.');
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
      for (const [operator, operand] of Object.entries(expected)) {
        const check = OPERATORS[operator];
        if (!check) throw ValidationError.single(key, `Operador de filtro no soportado: ${operator}.`);
        if (!check(value, operand)) return false;
      }
      continue;
    }
    if (Array.isArray(expected)) {
      if (!expected.includes(value)) return false;
      continue;
    }
    if (value !== expected) return false;
  }
  return true;
}

/** Comparador por varios campos, con dirección independiente (M-0067). */
export function comparator(order) {
  const rules = Object.entries(order || { createdAt: 'desc' }).map(([field, direction]) => ({
    field,
    sign: String(direction).toLowerCase() === 'asc' ? 1 : -1,
  }));
  return (a, b) => {
    for (const { field, sign } of rules) {
      const left = getPath(a, field);
      const right = getPath(b, field);
      if (left === right) continue;
      if (left === null || left === undefined) return 1;
      if (right === null || right === undefined) return -1;
      return left > right ? sign : -sign;
    }
    // Desempate estable: la paginación no cambia si dos valores ordenados son iguales.
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  };
}

/** Proyección `select` (M-0070). */
export function project(record, fields) {
  if (!fields?.length) return record;
  const output = {};
  for (const field of fields) {
    if (!isSafePath(field)) throw ValidationError.single('fields', `Campo no permitido: ${field}.`);
    const value = getPath(record, field);
    if (value !== undefined) {
      if (field.includes('.')) {
        const parts = field.split('.');
        let cursor = output;
        parts.slice(0, -1).forEach(part => {
          cursor[part] = cursor[part] || {};
          cursor = cursor[part];
        });
        cursor[parts.at(-1)] = value;
      } else {
        output[field] = value;
      }
    }
  }
  if (record.id && !output.id) output.id = record.id;
  return output;
}

export class Repository {
  /**
   * @param {object} options
   * @param {import('./store.js').Store} options.store
   * @param {string} options.collection nombre de la colección en el documento
   * @param {string} options.prefix prefijo de identificador
   * @param {string[]} options.unique campos con unicidad declarada (M-0074)
   * @param {boolean} options.softDelete usa `deletedAt` en lugar de borrar (M-0071)
   * @param {Array<{collection:string,field:string,onDelete:'cascade'|'restrict'|'null'}>} options.references
   */
  constructor({ store, collection, prefix, unique = [], softDelete = true, references = [], indexes = ['id'] }) {
    this.store = store;
    this.collection = collection;
    this.prefix = prefix || collection.slice(0, 4);
    this.unique = unique;
    this.softDelete = softDelete;
    this.references = references;
    this.indexes = indexes;
    this.indexCache = new Map();
    this.indexVersion = null;
  }

  raw(state = this.store.read()) {
    const value = state[this.collection];
    return Array.isArray(value) ? value : [];
  }

  /** Índice en memoria por campo, invalidado por checksum de longitud + updatedAt (M-0073). */
  index(field, state = this.store.read()) {
    const rows = this.raw(state);
    const version = `${rows.length}:${state.updatedAt || ''}`;
    if (this.indexVersion !== version) {
      this.indexCache.clear();
      this.indexVersion = version;
    }
    const key = `${field}`;
    if (!this.indexCache.has(key)) {
      const map = new Map();
      for (const row of rows) {
        const value = getPath(row, field);
        if (value === undefined || value === null) continue;
        if (!map.has(value)) map.set(value, row);
      }
      this.indexCache.set(key, map);
    }
    return this.indexCache.get(key);
  }

  /**
   * Lista con filtros, orden, paginación y proyección.
   * @returns {{data:object[], count:number, limit:number|null, offset:number, hasMore:boolean, cursor:string|null}}
   */
  list({ filter = {}, order, limit = null, offset = 0, select = null, withDeleted = false, after = null } = {}) {
    let rows = this.raw();
    if (this.softDelete && !withDeleted) rows = rows.filter(row => !row.deletedAt);
    rows = rows.filter(row => matches(row, filter));
    rows = [...rows].sort(comparator(order));

    // Paginación por cursor: estable aunque se inserten registros nuevos (M-0069).
    if (after) {
      const position = rows.findIndex(row => row.id === after);
      if (position < 0) throw ValidationError.single('after', 'El cursor no existe en este conjunto de resultados.');
      rows = rows.slice(position + 1);
    }

    const count = rows.length;
    const start = after ? 0 : Math.max(0, Number(offset) || 0);
    const size = limit === null || limit === undefined ? null : Math.max(0, Number(limit));
    const page = size === null ? rows.slice(start) : rows.slice(start, start + size);

    return {
      data: select ? page.map(row => project(row, select)) : page,
      count,
      limit: size,
      offset: start,
      hasMore: size !== null && start + page.length < count,
      cursor: page.length ? page.at(-1).id : null,
    };
  }

  all(filter = {}, options = {}) {
    return this.list({ filter, limit: null, ...options }).data;
  }

  count(filter = {}) {
    return this.list({ filter, limit: null }).count;
  }

  find(filter = {}, options = {}) {
    return this.list({ filter, limit: 1, ...options }).data[0] || null;
  }

  byId(identifier, { withDeleted = false } = {}) {
    if (!identifier) return null;
    const row = this.index('id').get(identifier) || null;
    if (!row) return null;
    if (!withDeleted && this.softDelete && row.deletedAt) return null;
    return row;
  }

  retrieve(identifier, options = {}) {
    const row = this.byId(identifier, options);
    if (!row) throw new NotFoundError(this.collection, identifier);
    return row;
  }

  exists(identifier) {
    return Boolean(this.byId(identifier));
  }

  // --- Escrituras. Siempre dentro de una transacción del Store. ---

  assertUnique(state, record, ignoreId = null) {
    for (const field of this.unique) {
      const value = getPath(record, field);
      if (value === undefined || value === null || value === '') continue;
      const clash = this.raw(state).find(row => row.id !== ignoreId && !row.deletedAt && getPath(row, field) === value);
      if (clash) {
        throw new ConflictError(`Ya existe un registro de ${this.collection} con ${field} "${value}".`, {
          collection: this.collection,
          field,
          value,
          conflictWith: clash.id,
        });
      }
    }
  }

  insert(state, data) {
    const record = {
      id: data.id || generateId(this.prefix),
      ...data,
      createdAt: data.createdAt || now(),
      updatedAt: now(),
    };
    if (this.softDelete && record.deletedAt === undefined) record.deletedAt = null;
    this.assertUnique(state, record);
    if (!Array.isArray(state[this.collection])) state[this.collection] = [];
    state[this.collection].unshift(record);
    this.indexVersion = null;
    return record;
  }

  patch(state, identifier, changes) {
    const rows = this.raw(state);
    const position = rows.findIndex(row => row.id === identifier);
    if (position < 0) throw new NotFoundError(this.collection, identifier);
    const before = rows[position];
    const after = { ...before, ...changes, id: before.id, createdAt: before.createdAt, updatedAt: now() };
    this.assertUnique(state, after, identifier);
    rows[position] = after;
    this.indexVersion = null;
    return { before, after };
  }

  /** Borra respetando la integridad referencial declarada (M-0075). */
  remove(state, identifier, { force = false } = {}) {
    const rows = this.raw(state);
    const position = rows.findIndex(row => row.id === identifier);
    if (position < 0) throw new NotFoundError(this.collection, identifier);

    for (const reference of this.references) {
      const dependents = (state[reference.collection] || []).filter(
        row => !row.deletedAt && getPath(row, reference.field) === identifier,
      );
      if (!dependents.length) continue;
      if (reference.onDelete === 'restrict') {
        throw new ConflictError(
          `No se puede borrar ${this.collection} ${identifier}: ${dependents.length} registro(s) de ${reference.collection} dependen de él.`,
          { collection: reference.collection, count: dependents.length },
        );
      }
      if (reference.onDelete === 'cascade') {
        state[reference.collection] = (state[reference.collection] || []).filter(
          row => getPath(row, reference.field) !== identifier,
        );
      }
      if (reference.onDelete === 'null') {
        for (const row of dependents) {
          setPath(row, reference.field, null);
          row.updatedAt = now();
        }
      }
    }

    this.indexVersion = null;
    if (this.softDelete && !force) {
      rows[position] = { ...rows[position], deletedAt: now(), updatedAt: now() };
      return rows[position];
    }
    const [removed] = rows.splice(position, 1);
    return removed;
  }

  /** Restaura un registro borrado lógicamente (M-0072). */
  restore(state, identifier) {
    const rows = this.raw(state);
    const position = rows.findIndex(row => row.id === identifier);
    if (position < 0) throw new NotFoundError(this.collection, identifier);
    if (!rows[position].deletedAt) throw new ConflictError(`El registro ${identifier} no está borrado.`);
    const restored = { ...rows[position], deletedAt: null, updatedAt: now() };
    this.assertUnique(state, restored, identifier);
    rows[position] = restored;
    this.indexVersion = null;
    return rows[position];
  }

  /** Inserta o actualiza según una clave natural. Útil para semillas idempotentes. */
  upsert(state, key, data) {
    const existing = this.raw(state).find(row => getPath(row, key) === getPath(data, key));
    if (!existing) return this.insert(state, data);
    return this.patch(state, existing.id, data).after;
  }
}

function setPath(target, path, value) {
  if (!isSafePath(path)) throw ValidationError.single(path, 'Ruta de campo no permitida.');
  const parts = path.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}
