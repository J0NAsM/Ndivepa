/**
 * Respuestas HTTP (M-0132 … M-0136, M-0894 … M-0896).
 *
 * Un solo lugar decide la forma de la respuesta: sobre coherente para listas, error
 * con `code` estable, `ETag` para lecturas cacheables y `304` cuando corresponde.
 */
import { createHash } from 'node:crypto';
import { serializeError } from '../errors.js';

const JSON_TYPE = 'application/json; charset=utf-8';

export function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': JSON_TYPE,
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(payload)),
    ...headers,
  });
  res.end(res.req?.method === 'HEAD' ? undefined : payload);
  return payload.length;
}

export function noContent(res, headers = {}) {
  res.writeHead(204, headers);
  res.end();
}

export function text(res, status, body, headers = {}) {
  const payload = String(body ?? '');
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(Buffer.byteLength(payload)), ...headers });
  res.end(res.req?.method === 'HEAD' ? undefined : payload);
}

export function html(res, status, body, headers = {}) {
  const payload = String(body ?? '');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(payload)),
    ...headers,
  });
  res.end(res.req?.method === 'HEAD' ? undefined : payload);
}

export function xml(res, status, body, headers = {}) {
  const payload = String(body ?? '');
  res.writeHead(status, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': String(Buffer.byteLength(payload)), ...headers });
  res.end(res.req?.method === 'HEAD' ? undefined : payload);
}

export function redirect(res, location, { status = 302, headers = {} } = {}) {
  res.writeHead(status, { Location: location, 'Content-Length': '0', ...headers });
  res.end();
}

/** Sobre coherente para listas (M-0132). */
export function list(res, result, headers = {}) {
  return json(
    res,
    200,
    {
      data: result.data,
      count: result.count,
      limit: result.limit,
      offset: result.offset,
      hasMore: Boolean(result.hasMore),
      cursor: result.cursor ?? null,
    },
    headers,
  );
}

export function fail(res, error, { exposeInternals = false, headers = {} } = {}) {
  const { status, body } = serializeError(error, { exposeInternals });
  const extra = { ...headers };
  if (error?.retryAfter) extra['Retry-After'] = String(error.retryAfter);
  if (error?.allowed?.length) extra.Allow = error.allowed.join(', ');
  return json(res, status, body, extra);
}

export function etagFor(body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return `W/"${createHash('sha1').update(payload).digest('base64url')}"`;
}

/**
 * Respuesta cacheable con validación por `ETag` (M-0895, M-0896).
 * Devuelve `true` si respondió 304, para que el llamador no siga escribiendo.
 */
export function cacheable(req, res, body, { maxAge = 0, headers = {} } = {}) {
  const etag = etagFor(body);
  const cacheControl = maxAge > 0 ? `private, max-age=${maxAge}` : 'no-cache';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl, ...headers });
    res.end();
    return true;
  }
  json(res, 200, body, { ETag: etag, 'Cache-Control': cacheControl, ...headers });
  return false;
}

/** Cookie con los valores por defecto seguros del proyecto. */
export function cookie(name, value, { maxAge = null, httpOnly = true, secure = false, sameSite = 'Lax', path = '/' } = {}) {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(String(name))) throw new TypeError('Nombre de cookie inválido.');
  if (!['Lax', 'Strict', 'None'].includes(sameSite)) throw new TypeError('SameSite inválido.');
  if (!String(path).startsWith('/') || /[;\r\n]/.test(String(path))) throw new TypeError('Path de cookie inválido.');
  const encoded = encodeURIComponent(String(value ?? ''));
  const parts = [`${name}=${encoded}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (maxAge !== null) {
    if (!Number.isFinite(Number(maxAge))) throw new TypeError('Max-Age de cookie inválido.');
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  }
  return parts.join('; ');
}

export function clearCookie(name, options = {}) {
  return `${cookie(name, '', { ...options, maxAge: 0 })}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
