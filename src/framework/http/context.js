/**
 * Contexto de petición (M-0130, M-0131, M-0137).
 *
 * Un objeto por petición con lo que el dominio necesita: actor, permisos, idioma,
 * canal, cuerpo validado y query normalizada. Los servicios reciben este contexto,
 * nunca `req`/`res`: así se pueden probar sin levantar un servidor.
 */
import { BadRequestError, PayloadTooLargeError, UnsupportedMediaTypeError, ValidationError } from '../errors.js';
import { jsonDepth, validate } from '../validate.js';
import { id as generateId } from '../ids.js';

/** Cookie opcional de consentimiento de analítica, para clientes ajenos a la SPA. */
export const CONSENT_COOKIE = 'ndivepa-analytics-consent';

/** Identificador de correlación aceptable: alfanumérico, guion y punto, 80 caracteres. */
export function safeRequestId(value) {
  const candidate = String(value ?? '').trim().slice(0, 80);
  return /^[A-Za-z0-9._-]+$/.test(candidate) ? candidate : null;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const name = trimmed.slice(0, index);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || Object.hasOwn(out, name)) continue;
    const raw = trimmed.slice(index + 1);
    try { out[name] = decodeURIComponent(raw); } catch { out[name] = raw; }
  }
  return out;
}

/** Lee el cuerpo con límite duro y JSON validado (M-0131, M-0903 … M-0905). */
export async function readJsonBody(req, { maxBytes = 1_000_000, maxDepth = 24 } = {}) {
  const method = req.method?.toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return {};

  const rawLength = req.headers['content-length'];
  const declared = rawLength === undefined ? null : Number(rawLength);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0)) {
    throw new BadRequestError('Content-Length no es válido.');
  }
  if (declared > maxBytes) throw new PayloadTooLargeError(maxBytes);

  const encoding = String(req.headers['content-encoding'] || 'identity').trim().toLowerCase();
  if (encoding !== 'identity') throw new UnsupportedMediaTypeError(`content-encoding: ${encoding}`);

  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType && contentType !== 'application/json' && !contentType.endsWith('+json')) {
    throw new UnsupportedMediaTypeError(contentType);
  }
  if (declared > 0 && !contentType) throw new UnsupportedMediaTypeError(null);

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new PayloadTooLargeError(maxBytes);
    chunks.push(chunk);
  }
  if (!size) return {};
  if (!contentType) throw new UnsupportedMediaTypeError(null);

  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw ValidationError.single('body', 'El cuerpo debe ser JSON válido.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw ValidationError.single('body', 'El cuerpo JSON debe ser un objeto.');
  }
  if (jsonDepth(parsed) > maxDepth) {
    throw ValidationError.single('body', `El JSON supera la profundidad máxima de ${maxDepth} niveles.`);
  }
  return parsed;
}

/** Query normalizada: soporta `a=1&a=2` como array y `filter[status]=x` anidado. */
export function parseQuery(searchParams, { maxParams = 100 } = {}) {
  const out = {};
  let count = 0;
  for (const [key, value] of searchParams) {
    count += 1;
    if (count > maxParams) throw new BadRequestError(`La consulta supera el máximo de ${maxParams} parámetros.`);
    const nested = /^([a-zA-Z0-9_]+)\[([a-zA-Z0-9_.$]+)\]$/.exec(key);
    if (nested) {
      const [, root, child] = nested;
      out[root] = out[root] || {};
      if (out[root][child] === undefined) out[root][child] = value;
      else if (Array.isArray(out[root][child])) out[root][child].push(value);
      else out[root][child] = [out[root][child], value];
      continue;
    }
    if (out[key] === undefined) out[key] = value;
    else if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = [out[key], value];
  }
  return out;
}

export class RequestContext {
  constructor({ req, res, url, config, container, logger, i18n }) {
    this.req = req;
    this.res = res;
    this.url = url;
    this.config = config;
    this.container = container;
    // El identificador que propone el cliente se acepta para poder correlacionar
    // trazas con un proxy, pero saneado: va a las cabeceras de respuesta y a los
    // registros, y un valor con saltos de línea o caracteres de control rompería
    // la respuesta o ensuciaría el log.
    this.requestId = safeRequestId(req.headers['x-request-id']) || generateId('req');
    this.logger = logger?.child({ requestId: this.requestId }) || logger;
    this.i18n = i18n;
    this.cookies = parseCookies(req.headers.cookie);
    this.query = parseQuery(url.searchParams, { maxParams: config?.security?.maxQueryParams || 100 });
    this.params = {};
    this.body = {};
    this.actor = null;
    this.session = null;
    this.apiKey = null;
    this.channelId = null;
    this.locale = i18n?.negotiate(req.headers['accept-language'], this.query.locale) || config?.defaultLocale || 'es';
    this.startedAt = Date.now();
    // Consentimiento de analítica por defecto, para las rutas que no lo reciben
    // en el cuerpo (`ctx.body.consent ?? ctx.consent`). El valor por defecto es
    // «no»: sin señal explícita no se registra nada. La interfaz propia guarda la
    // preferencia en `localStorage` y la envía en cada petición; la cookie y el
    // parámetro existen para integraciones que no ejecutan esa interfaz.
    this.consent = this.cookies[CONSENT_COOKIE] === 'granted' || this.query.consent === '1';
  }

  resolve(name) {
    return this.container.resolve(name);
  }

  get method() {
    return this.req.method?.toUpperCase();
  }

  get ip() {
    if (this.config?.security?.trustProxy) {
      const forwarded = String(this.req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (forwarded) return forwarded;
    }
    return this.req.socket?.remoteAddress || null;
  }

  get userAgent() {
    return String(this.req.headers['user-agent'] || '').slice(0, 300);
  }

  get referer() {
    return this.req.headers.referer || null;
  }

  get permissions() {
    return this.actor?.permissions || new Set();
  }

  /** Valida el cuerpo contra un esquema y lo deja saneado en `ctx.body`. */
  validateBody(schema, options = {}) {
    this.body = validate(this.body, schema, options);
    return this.body;
  }

  validateQuery(schema, options = {}) {
    return validate(this.query, schema, { partial: true, ...options });
  }

  t(key, params) {
    return this.i18n?.t(key, this.locale, params) ?? key;
  }

  /** Datos comunes para auditoría y eventos de dominio. */
  audit() {
    return {
      actorId: this.actor?.id || null,
      actorType: this.actor?.type || 'anonymous',
      ip: this.ip,
      userAgent: this.userAgent,
      requestId: this.requestId,
    };
  }

  get durationMs() {
    return Date.now() - this.startedAt;
  }
}
