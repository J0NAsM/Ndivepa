/**
 * Validador declarativo (M-0044 … M-0049).
 *
 * Recorre el esquema completo y devuelve **todos** los problemas, no solo el primero:
 * corregir un formulario campo a campo es una mala experiencia y multiplica los
 * viajes al servidor. Los campos desconocidos se rechazan (allowlist, M-0047) porque
 * el CRUD genérico heredado permitía escribir cualquier clave del cuerpo.
 */
import { ValidationError } from './errors.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const CURRENCY = /^[A-Z]{3}$/;
const COUNTRY = /^[A-Za-z]{2}$/;
const HANDLE = /^[a-z0-9][a-z0-9-]*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function cloneExtensibleObject(value, path, issues) {
  if (Array.isArray(value)) return value.map((item, index) => cloneExtensibleObject(item, `${path}[${index}]`, issues));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, inner] of Object.entries(value)) {
    const field = path ? `${path}.${key}` : key;
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      issues.push({ field, message: 'Clave de objeto no permitida.' });
      continue;
    }
    output[key] = cloneExtensibleObject(inner, field, issues);
  }
  return output;
}

function isRealIsoDate(value) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!parts) return false;
  const [, year, month, day] = parts.map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return false;
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  return !Number.isNaN(parsed.getTime());
}

const TYPE_CHECKS = {
  string: value => typeof value === 'string',
  number: value => typeof value === 'number' && Number.isFinite(value),
  integer: value => Number.isInteger(value),
  boolean: value => typeof value === 'boolean',
  object: value => value !== null && typeof value === 'object' && !Array.isArray(value),
  array: value => Array.isArray(value),
  any: () => true,
};

/** Coerción explícita y controlada (M-0046): solo donde el esquema la pide. */
function coerce(value, rule) {
  if (!rule.coerce || value === null || value === undefined || value === '') return value;
  switch (rule.type) {
    case 'number': {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : value;
    }
    case 'integer': {
      // `parseInt('12px')` y `parseInt('1.9')` aceptaban valores parciales.
      if (typeof value === 'number') return value;
      if (!/^-?\d+$/.test(String(value).trim())) return value;
      const numeric = Number(value);
      return Number.isSafeInteger(numeric) ? numeric : value;
    }
    case 'boolean': {
      if (value === 'true' || value === '1' || value === 1) return true;
      if (value === 'false' || value === '0' || value === 0) return false;
      return value;
    }
    case 'array':
      return Array.isArray(value) ? value : String(value).split(',').map(item => item.trim()).filter(Boolean);
    case 'string':
      return typeof value === 'string' ? value : String(value);
    default:
      return value;
  }
}

function checkFormat(value, format) {
  switch (format) {
    case 'email': return EMAIL.test(value) ? null : 'Debe ser un correo electrónico válido.';
    case 'currency': return CURRENCY.test(value) ? null : 'Debe ser un código de moneda ISO-4217 de tres letras.';
    case 'country': return COUNTRY.test(value) ? null : 'Debe ser un código de país ISO-3166 de dos letras.';
    case 'handle': return HANDLE.test(value) ? null : 'Solo minúsculas, números y guiones, empezando por letra o número.';
    case 'date': {
      if (!ISO_DATE.test(value)) return 'Debe ser una fecha ISO-8601.';
      return isRealIsoDate(value) ? null : 'Debe ser una fecha ISO-8601 real.';
    }
    case 'url':
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)) return 'Solo se admiten URLs http o https.';
        if (url.username || url.password) return 'La URL no puede incluir credenciales.';
        return null;
      } catch {
        return 'Debe ser una URL válida.';
      }
    default:
      return null;
  }
}

function validateValue(value, rule, path, issues) {
  const fail = message => issues.push({ field: path, message });

  if (value === null || value === undefined || value === '') {
    if (rule.required) fail(rule.requiredMessage || 'Este campo es obligatorio.');
    return rule.default !== undefined && (value === undefined || value === '') ? structuredClone(rule.default) : value;
  }

  const type = rule.type || 'any';
  const check = TYPE_CHECKS[type];
  if (check && !check(value)) {
    fail(`Se esperaba un valor de tipo ${type}.`);
    return value;
  }
  if (!check) throw new TypeError(`Tipo de validación no soportado: ${type}.`);

  if (type === 'string') {
    if (rule.trim !== false) value = value.trim();
    if (rule.lowercase) value = value.toLowerCase();
    if (rule.uppercase) value = value.toUpperCase();
    if (rule.minLength && value.length < rule.minLength) fail(`Debe tener al menos ${rule.minLength} caracteres.`);
    if (rule.maxLength && value.length > rule.maxLength) fail(`No puede superar ${rule.maxLength} caracteres.`);
    if (rule.pattern) {
      rule.pattern.lastIndex = 0;
      if (!rule.pattern.test(value)) fail(rule.patternMessage || 'El formato no es válido.');
    }
    if (rule.format) {
      const problem = checkFormat(value, rule.format);
      if (problem) fail(problem);
    }
  }

  if (type === 'number' || type === 'integer') {
    if (rule.min !== undefined && value < rule.min) fail(`No puede ser menor que ${rule.min}.`);
    if (rule.max !== undefined && value > rule.max) fail(`No puede ser mayor que ${rule.max}.`);
  }

  if (rule.enum && !rule.enum.includes(value)) {
    fail(`Debe ser uno de: ${rule.enum.join(', ')}.`);
  }

  if (type === 'array') {
    if (rule.minItems && value.length < rule.minItems) fail(`Debe incluir al menos ${rule.minItems} elemento(s).`);
    if (rule.maxItems && value.length > rule.maxItems) fail(`No puede incluir más de ${rule.maxItems} elemento(s).`);
    if (rule.items) {
      value = value.map((item, index) => validateValue(item, rule.items, `${path}[${index}]`, issues));
    }
    if (rule.unique && new Set(value.map(item => JSON.stringify(item))).size !== value.length) {
      fail('No puede contener valores duplicados.');
    }
  }

  if (type === 'object' && rule.shape) {
    value = runSchema(value, rule.shape, {
      path,
      issues,
      partial: rule.partial,
      allowUnknown: rule.allowUnknown,
    });
  }

  if (typeof rule.validate === 'function') {
    const problem = rule.validate(value);
    if (problem) fail(problem);
  }

  return value;
}

function runSchema(input, schema, { path = '', issues, partial = false, allowUnknown = false } = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  // `allowUnknown` se usa para metadatos y mapas de opciones. Antes se limitaba
  // a no reportar las claves, pero luego devolvía `{}` y destruía silenciosamente
  // todo el contenido. Se conserva una copia propia, rechazando claves que puedan
  // alterar prototipos cuando esos objetos se combinen más adelante.
  const output = allowUnknown ? cloneExtensibleObject(source, path, issues) : {};

  if (!allowUnknown) {
    for (const key of Object.keys(source)) {
      if (!Object.hasOwn(schema, key)) {
        issues.push({ field: path ? `${path}.${key}` : key, message: 'Campo no reconocido.' });
      }
    }
  }

  for (const [key, rule] of Object.entries(schema)) {
    const field = path ? `${path}.${key}` : key;
    const present = Object.hasOwn(source, key);
    if (partial && !present) continue;
    const raw = coerce(present ? source[key] : undefined, rule);
    const value = validateValue(raw, rule, field, issues);
    if (value !== undefined) output[key] = value;
    else if (present) output[key] = source[key];
  }

  return output;
}

/**
 * Valida y devuelve el objeto saneado. Lanza `ValidationError` con todos los problemas.
 * @param {object} input datos crudos
 * @param {object} schema definición por campo
 * @param {{partial?:boolean, allowUnknown?:boolean}} options `partial` para PATCH
 */
export function validate(input, schema, options = {}) {
  const issues = [];
  const output = runSchema(input, schema, { ...options, issues });
  if (issues.length) throw new ValidationError(issues);
  return output;
}

/** Igual que `validate` pero sin lanzar: útil para informes de importación por filas. */
export function check(input, schema, options = {}) {
  const issues = [];
  const value = runSchema(input, schema, { ...options, issues });
  return { valid: issues.length === 0, issues, value };
}

/** Atajos de regla para no repetir literales por todo el código. */
export const rule = {
  id: (extra = {}) => ({ type: 'string', maxLength: 80, pattern: SAFE_ID, patternMessage: 'Debe ser un identificador válido.', ...extra }),
  text: (max = 255, extra = {}) => ({ type: 'string', maxLength: max, ...extra }),
  longText: (extra = {}) => ({ type: 'string', maxLength: 20000, ...extra }),
  handle: (extra = {}) => ({ type: 'string', maxLength: 120, format: 'handle', ...extra }),
  email: (extra = {}) => ({ type: 'string', maxLength: 254, format: 'email', lowercase: true, ...extra }),
  url: (extra = {}) => ({ type: 'string', maxLength: 2048, format: 'url', ...extra }),
  currency: (extra = {}) => ({ type: 'string', format: 'currency', uppercase: true, ...extra }),
  country: (extra = {}) => ({ type: 'string', format: 'country', lowercase: true, ...extra }),
  date: (extra = {}) => ({ type: 'string', format: 'date', ...extra }),
  minor: (extra = {}) => ({ type: 'integer', coerce: true, min: -100_000_000_000, ...extra }),
  quantity: (extra = {}) => ({ type: 'integer', coerce: true, min: 0, max: 1_000_000, ...extra }),
  percent: (extra = {}) => ({ type: 'number', coerce: true, min: 0, max: 100, ...extra }),
  flag: (extra = {}) => ({ type: 'boolean', coerce: true, ...extra }),
  enumOf: (values, extra = {}) => ({ type: 'string', enum: values, ...extra }),
  list: (items, extra = {}) => ({ type: 'array', coerce: true, items, unique: true, ...extra }),
  metadata: () => ({ type: 'object', shape: {}, allowUnknown: true, validate: value => (
    value && typeof value === 'object' && !Array.isArray(value) ? null : 'Los metadatos deben ser un objeto.'
  ) }),
};

/** Comprueba la profundidad de un JSON de entrada (M-0904). */
export function jsonDepth(value, depth = 0) {
  if (depth > 64) return depth;
  if (Array.isArray(value)) return value.reduce((max, item) => Math.max(max, jsonDepth(item, depth + 1)), depth);
  if (value && typeof value === 'object') {
    return Object.values(value).reduce((max, item) => Math.max(max, jsonDepth(item, depth + 1)), depth);
  }
  return depth;
}
