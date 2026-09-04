/**
 * Middlewares (M-0129, M-0134, M-0135, M-0192, M-0195, M-0196).
 *
 * Aquí vive lo que antes hacía el monkey-patch de `Server.prototype.emit`: cabeceras,
 * caché de estáticos, cookies `Secure`, límites y rate limiting. La diferencia es que
 * ahora el orden es explícito y se puede leer de arriba abajo.
 */
import { access, realpath, stat } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { extname, join, resolve as resolvePath, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ForbiddenError, RateLimitError } from '../errors.js';
import { safeEqual } from '../strings.js';
import * as respond from './respond.js';

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.webmanifest': 'application/manifest+json',
};

// Un byte nulo escrito sin ambigüedad: en una ruta trunca el nombre del fichero
// en las llamadas al sistema, así que la petición se rechaza antes de tocar disco.
const NULL_BYTE = String.fromCharCode(0);

const STATIC_ASSET = /\.(?:css|js|mjs|map|svg|png|jpe?g|webp|avif|gif|ico|woff2?|ttf)$/i;

export function securityHeaders(res, { isProduction } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Origin-Agent-Cluster', '?1');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; "
    + "object-src 'none'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; "
    + `script-src 'self'; connect-src 'self'; font-src 'self' data:${isProduction ? '; upgrade-insecure-requests' : ''}`,
  );
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/**
 * Envuelve `writeHead` para aplicar tres reglas transversales sin repetirlas en
 * cada respuesta: caché de estáticos, cookie `Secure` en producción y `X-Request-Id`.
 */
export function decorateWriteHead(req, res, { isProduction, requestId }) {
  const original = res.writeHead.bind(res);
  res.writeHead = (status, headers = {}) => {
    const merged = { ...headers };
    if (requestId && !merged['X-Request-Id']) merged['X-Request-Id'] = requestId;

    const isStatic = ['GET', 'HEAD'].includes(req.method) && STATIC_ASSET.test((req.url || '').split('?')[0]);
    if (isStatic && !merged['Cache-Control'] && !merged['cache-control']) {
      merged['Cache-Control'] = 'public, max-age=3600, stale-while-revalidate=86400';
    }

    const cookies = merged['Set-Cookie'] || merged['set-cookie'];
    if (isProduction && cookies) {
      const secure = value => (/(?:^|;\s*)Secure(?:;|$)/i.test(value) ? value : `${value}; Secure`);
      merged['Set-Cookie'] = Array.isArray(cookies) ? cookies.map(secure) : secure(cookies);
    }
    return original(status, merged);
  };
  return res;
}

export function applyCors(req, res, { origins = [] }) {
  const origin = req.headers.origin;
  if (!origin || !origins.length) return;
  const wildcard = origins.includes('*');
  const allowed = wildcard || origins.includes(origin);
  if (!allowed) return;
  res.setHeader('Access-Control-Allow-Origin', wildcard ? '*' : origin);
  const currentVary = res.getHeader?.('Vary') ?? res.headers?.Vary ?? res.headers?.vary;
  const vary = new Set(String(currentVary || '').split(',').map(value => value.trim()).filter(Boolean));
  vary.add('Origin');
  res.setHeader('Vary', [...vary].join(', '));
  // El estándar prohíbe combinar credenciales con `*`; además evita exponer
  // sesiones por accidente si una instalación habilita CORS abierto.
  if (!wildcard) res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Ndivepa-Csrf, X-Request-Id, X-Publishable-Key');
  res.setHeader('Access-Control-Max-Age', '600');
}

/**
 * CSRF por doble envío (M-0135). Solo se exige cuando la autenticación viene de
 * cookie: con clave de API o cabecera `Authorization` no hay riesgo de envío
 * automático por el navegador.
 *
 * La comprobación se hace **después** de autenticar, así que `ctx.session` dice
 * si esta petición está autenticada por cookie. Eso importa: antes la regla era
 * «si no llega la cookie CSRF, no hay nada que proteger», de modo que una
 * petición con sesión válida y sin cookie CSRF se colaba sin token. Ahora una
 * sesión de cookie exige token siempre, y el par de cookies se emite junto en el
 * inicio de sesión, así que ningún cliente legítimo pierde nada.
 */
export function assertCsrf(ctx) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(ctx.method)) return;
  if (ctx.apiKey || ctx.req.headers.authorization) return;
  const { csrfCookie, csrfHeader } = ctx.config.security;
  const cookieToken = ctx.cookies[csrfCookie];
  // Una sesión del panel llega resuelta en `ctx.session`; la del cliente de tienda
  // la leen los propios manejadores, así que aquí se comprueba su cookie.
  const cookieAuthenticated = Boolean(ctx.session)
    || Boolean(ctx.cookies[ctx.config.session.cookieName])
    || Boolean(ctx.cookies[ctx.config.session.customerCookieName]);
  // Sin sesión de cookie ni cookie CSRF no hay nada que un tercero pueda
  // aprovechar: la petición no lleva credenciales enviadas por el navegador.
  if (!cookieToken && !cookieAuthenticated) return;
  const sent = ctx.req.headers[csrfHeader] || ctx.body?._csrf;
  if (!cookieToken || !sent || !safeEqual(cookieToken, sent)) {
    throw new ForbiddenError('Falta el token CSRF o no coincide.');
  }
}

export function issueCsrfToken() {
  return randomBytes(24).toString('base64url');
}

/** Consume una ventana del limitador y lanza si se pasa. */
export function enforceRateLimit(limiter, key, limit, res) {
  const result = limiter.consume(key, limit);
  for (const [header, value] of Object.entries(limiter.headers(result))) res.setHeader(header, value);
  if (!result.allowed) throw new RateLimitError(result.retryAfter, result.limit);
  return result;
}

/**
 * Servidor de estáticos con protección de traversal, `Range`, `Last-Modified` y 304
 * (M-0191, M-0192, M-0195, M-0196).
 *
 * El contenido se envía en flujo, no cargado en memoria: una imagen subida al
 * panel puede pesar cientos de kilobytes y `readFile` reservaba el fichero
 * completo por cada petición concurrente, incluida la parte de un `Range` que
 * el cliente nunca iba a recibir.
 *
 * @returns {Promise<boolean>} `true` si esta función ya atendió la respuesta.
 */
export async function serveStatic(req, res, { pathname, root, index = 'index.html' }) {
  let relative;
  try {
    relative = pathname === '/' ? index : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    // Porcentaje mal formado (`/%`): es una petición inválida, no un 500.
    respond.text(res, 400, 'Ruta mal codificada.');
    return true;
  }
  // Un byte nulo en la ruta trunca el nombre en las llamadas al sistema.
  if (relative.includes(NULL_BYTE)) {
    respond.text(res, 400, 'Ruta no válida.');
    return true;
  }
  // Los ficheros de configuración y control (`.env`, `.git`, mapas ocultos) no
  // forman parte del sitio aunque alguien los copie por accidente bajo `public`.
  if (relative.split(/[\\/]/).some(segment => segment.startsWith('.') && !['.', '..', '.well-known'].includes(segment))) {
    respond.text(res, 404, 'Recurso no encontrado.');
    return true;
  }

  const base = resolvePath(root);
  const target = resolvePath(join(base, relative));
  // La comprobación de prefijo es la que impide `../../etc/passwd`.
  if (target !== base && !target.startsWith(base + sep)) {
    respond.text(res, 403, 'Acceso no permitido.');
    return true;
  }

  let info;
  try {
    await access(target, constants.R_OK);
    info = await stat(target);
  } catch {
    return false;
  }
  if (info.isDirectory()) return false;

  // `resolve()` bloquea `../`, pero un enlace simbólico dentro de `public` puede
  // apuntar fuera. Se compara también la ruta física resuelta.
  try {
    const [realBase, realTarget] = await Promise.all([realpath(base), realpath(target)]);
    if (realTarget !== realBase && !realTarget.startsWith(realBase + sep)) {
      respond.text(res, 403, 'Acceso no permitido.');
      return true;
    }
  } catch {
    return false;
  }

  const lastModified = info.mtime.toUTCString();
  const etag = `W/"${info.size.toString(36)}-${info.mtimeMs.toString(36)}"`;
  const ifNoneMatch = req.headers['if-none-match'];
  const etagMatches = ifNoneMatch && (ifNoneMatch === '*' || String(ifNoneMatch).split(',').some(value => value.trim() === etag));
  const modifiedSince = Date.parse(req.headers['if-modified-since'] || '');
  // If-None-Match tiene precedencia: un ETag distinto no puede quedar anulado por
  // una fecha coincidente de una representación anterior.
  const dateMatches = !ifNoneMatch && Number.isFinite(modifiedSince) && Math.floor(info.mtimeMs / 1000) * 1000 <= modifiedSince;
  if (etagMatches || dateMatches) {
    res.writeHead(304, { ETag: etag, 'Last-Modified': lastModified, 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400' });
    res.end();
    return true;
  }

  const type = MIME_TYPES[extname(target).toLowerCase()] || 'application/octet-stream';
  const baseHeaders = { 'Content-Type': type, ETag: etag, 'Last-Modified': lastModified, 'Accept-Ranges': 'bytes' };

  let start = 0;
  let end = info.size - 1;
  let status = 200;
  const rangeHeader = req.headers.range;
  let range = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim()) : null;
  if (rangeHeader && !range) {
    res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
    res.end();
    return true;
  }
  // If-Range distinto obliga a devolver la representación completa.
  if (range && req.headers['if-range']) {
    const ifRange = String(req.headers['if-range']);
    const asDate = Date.parse(ifRange);
    const valid = ifRange === etag || (Number.isFinite(asDate) && Math.floor(info.mtimeMs / 1000) * 1000 <= asDate);
    if (!valid) range = null;
  }
  if (range) {
    if (range[1] === '') {
      // Rango por sufijo (`bytes=-500`): los últimos N bytes. Antes se leía como
      // «desde 0 hasta 500», así que un visor de PDF que pide la cola del fichero
      // recibía la cabecera y no encontraba el índice.
      const suffix = Number(range[2] || 0);
      start = suffix > 0 ? Math.max(0, info.size - suffix) : info.size;
      end = info.size - 1;
    } else {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
      res.end();
      return true;
    }
    status = 206;
    baseHeaders['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }

  const length = info.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, { ...baseHeaders, 'Content-Length': String(length) });
  if (req.method === 'HEAD' || length === 0) {
    res.end();
    return true;
  }

  try {
    await pipeline(createReadStream(target, { start, end }), res);
  } catch {
    // El cliente cortó la descarga o el fichero desapareció a mitad: las
    // cabeceras ya salieron, así que solo queda cerrar la respuesta.
    res.destroy();
  }
  return true;
}
