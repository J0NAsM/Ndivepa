/**
 * Middlewares (M-0129, M-0134, M-0135, M-0192, M-0195, M-0196).
 *
 * Aquí vive lo que antes hacía el monkey-patch de `Server.prototype.emit`: cabeceras,
 * caché de estáticos, cookies `Secure`, límites y rate limiting. La diferencia es que
 * ahora el orden es explícito y se puede leer de arriba abajo.
 */
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
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

const STATIC_ASSET = /\.(?:css|js|mjs|map|svg|png|jpe?g|webp|avif|gif|ico|woff2?|ttf)$/i;

export function securityHeaders(res, { isProduction } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; "
    + "object-src 'none'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; "
    + "script-src 'self'; connect-src 'self'; font-src 'self' data:; upgrade-insecure-requests",
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

    const isStatic = req.method === 'GET' && STATIC_ASSET.test((req.url || '').split('?')[0]);
    if (isStatic && !merged['Cache-Control'] && !merged['cache-control']) {
      merged['Cache-Control'] = 'public, max-age=3600, stale-while-revalidate=86400';
    }

    const cookies = merged['Set-Cookie'] || merged['set-cookie'];
    if (isProduction && cookies) {
      const secure = value => (value.includes('Secure') ? value : `${value}; Secure`);
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
  res.setHeader('Vary', 'Origin');
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
 */
export function assertCsrf(ctx) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(ctx.method)) return;
  if (ctx.apiKey || ctx.req.headers.authorization) return;
  const { csrfCookie, csrfHeader } = ctx.config.security;
  const cookieToken = ctx.cookies[csrfCookie];
  if (!cookieToken) return; // No hay sesión con cookie: nada que proteger todavía.
  const sent = ctx.req.headers[csrfHeader] || ctx.body?._csrf;
  if (!sent || !safeEqual(cookieToken, sent)) {
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
 */
export async function serveStatic(req, res, { pathname, root, index = 'index.html' }) {
  const relative = pathname === '/' ? index : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = resolvePath(join(root, relative));
  // La comprobación de prefijo es la que impide `../../etc/passwd`.
  if (target !== resolvePath(root) && !target.startsWith(resolvePath(root) + sep)) {
    respond.text(res, 403, 'Acceso no permitido.');
    return true;
  }

  try {
    await access(target, constants.R_OK);
    const info = await stat(target);
    if (info.isDirectory()) return false;

    const lastModified = info.mtime.toUTCString();
    const etag = `W/"${info.size.toString(36)}-${info.mtimeMs.toString(36)}"`;
    if (req.headers['if-none-match'] === etag || req.headers['if-modified-since'] === lastModified) {
      res.writeHead(304, { ETag: etag, 'Last-Modified': lastModified });
      res.end();
      return true;
    }

    const type = MIME_TYPES[extname(target).toLowerCase()] || 'application/octet-stream';
    const baseHeaders = { 'Content-Type': type, ETag: etag, 'Last-Modified': lastModified, 'Accept-Ranges': 'bytes' };

    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
        if (start > end || start >= info.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
          res.end();
          return true;
        }
        const buffer = await readFile(target);
        res.writeHead(206, {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${info.size}`,
          'Content-Length': String(end - start + 1),
        });
        res.end(req.method === 'HEAD' ? undefined : buffer.subarray(start, end + 1));
        return true;
      }
    }

    const buffer = await readFile(target);
    res.writeHead(200, { ...baseHeaders, 'Content-Length': String(buffer.length) });
    res.end(req.method === 'HEAD' ? undefined : buffer);
    return true;
  } catch {
    return false;
  }
}
