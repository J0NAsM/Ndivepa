/**
 * Pipeline HTTP (M-0129, M-0159).
 *
 * Reemplazo directo del monkey-patch de `Server.prototype.emit`. El orden es
 * explícito y se lee de arriba abajo:
 *
 *   cabeceras -> cors -> preflight -> límite de tamaño -> contexto ->
 *   autenticación -> rate limit -> ruta -> cuerpo -> CSRF -> permiso -> manejador
 *
 * Lo que no coincide con ninguna ruta cae en los `fallbacks` (SEO server-side y
 * estáticos), en el mismo orden en que se registraron.
 */
import { BadRequestError, MethodNotAllowedError, NotFoundError, PayloadTooLargeError, UnauthorizedError } from '../errors.js';
import { RequestContext, readJsonBody } from './context.js';
import { applyCors, assertCsrf, decorateWriteHead, enforceRateLimit, securityHeaders } from './middlewares.js';
import * as respond from './respond.js';

export class HttpApp {
  constructor({ router, config, container, logger, rateLimiter, i18n, rbac }) {
    this.router = router;
    this.config = config;
    this.container = container;
    this.logger = logger;
    this.rateLimiter = rateLimiter;
    this.i18n = i18n;
    this.rbac = rbac;
    this.authenticators = [];
    this.fallbacks = [];
    this.rateRules = [];
    this.stats = { requests: 0, errors: 0 };
  }

  /** Estrategia de autenticación: sesión por cookie, clave de API, token de canal… */
  useAuthenticator(authenticator) {
    this.authenticators.push(authenticator);
    return this;
  }

  /** Manejador para lo que no resuelve el router (SEO, estáticos). */
  useFallback(handler) {
    this.fallbacks.push(handler);
    return this;
  }

  /**
   * Regla de rate limit.
   * @param {(ctx:RequestContext)=>boolean} test
   * @param {(ctx:RequestContext)=>string} keyOf
   * @param {{windowMs:number,max:number}} limit
   */
  useRateLimit(test, keyOf, limit) {
    this.rateRules.push({ test, keyOf, limit });
    return this;
  }

  async authenticate(ctx) {
    for (const authenticator of this.authenticators) {
      const result = await authenticator(ctx);
      if (result) {
        ctx.actor = result.actor || ctx.actor;
        ctx.session = result.session || ctx.session;
        ctx.apiKey = result.apiKey || ctx.apiKey;
        ctx.channelId = result.channelId || ctx.channelId;
        if (result.stop) break;
      }
    }
    return ctx.actor;
  }

  /** Manejador para `createServer`. */
  handler() {
    return (req, res) => {
      res.req = req;
      this.handle(req, res).catch(error => {
        this.stats.errors += 1;
        this.logger?.error('Fallo no controlado en el pipeline', error);
        if (!res.headersSent) respond.fail(res, error, { exposeInternals: !this.config.isProduction });
      });
    };
  }

  async handle(req, res) {
    this.stats.requests += 1;
    securityHeaders(res, { isProduction: this.config.isProduction });
    let url = null;
    let ctx = null;
    try {
      const rawUrl = req.url || '/';
      if (rawUrl.length > this.config.security.maxUrlLength) {
        throw new BadRequestError(`La URL supera el máximo de ${this.config.security.maxUrlLength} caracteres.`);
      }
      // El Host del cliente no forma parte de la resolución interna. Usarlo como
      // base hacía que una cabecera Host malformada pudiera tumbar la petición.
      url = new URL(rawUrl, 'http://localhost');
      ctx = new RequestContext({
        req,
        res,
        url,
        config: this.config,
        container: this.container,
        logger: this.logger,
        i18n: this.i18n,
      });
      decorateWriteHead(req, res, { isProduction: this.config.isProduction, requestId: ctx.requestId });
      applyCors(req, res, { origins: this.config.security.corsOrigins });

      if (ctx.method === 'OPTIONS') {
        const allowed = this.router.allowedFor(url.pathname);
        if (!allowed.length) throw new NotFoundError('ruta', url.pathname);
        const requested = String(req.headers['access-control-request-method'] || '').toUpperCase();
        if (requested && !allowed.includes(requested)) throw new MethodNotAllowedError(allowed);
        res.writeHead(204, { Allow: allowed.join(', '), 'Content-Length': '0' });
        res.end();
        return;
      }

      const lengthHeader = req.headers['content-length'];
      const declaredLength = lengthHeader === undefined ? 0 : Number(lengthHeader);
      if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) throw new BadRequestError('Content-Length no es válido.');
      if (declaredLength > this.config.security.maxBodyBytes) {
        return respond.fail(res, new PayloadTooLargeError(this.config.security.maxBodyBytes));
      }

      // La autenticación va **antes** del rate limit a propósito. Las reglas de
      // escritura se cuentan por actor (`write:<userId>`) y al revés `ctx.actor`
      // siempre era `null`: todo el panel compartía el cupo de una sola IP, y dos
      // administradores detrás del mismo NAT se bloqueaban entre ellos.
      await this.authenticate(ctx);

      for (const entry of this.rateRules) {
        if (entry.test(ctx)) enforceRateLimit(this.rateLimiter, entry.keyOf(ctx), entry.limit, res);
      }

      let resolved;
      try {
        resolved = this.router.resolve(ctx.method, url.pathname);
      } catch (error) {
        if (error instanceof NotFoundError) return await this.runFallbacks(ctx);
        throw error;
      }

      const { route, params } = resolved;
      ctx.params = params;
      ctx.route = route;

      // Los esquemas declarados por la ruta son el perímetro HTTP: rechazan
      // parámetros y campos desconocidos antes de que lleguen al dominio.
      if (route.query) ctx.query = ctx.validateQuery(route.query);

      if (route.bodyless !== true) {
        ctx.body = await readJsonBody(req, {
          maxBytes: route.maxBodyBytes || this.config.security.maxBodyBytes,
          maxDepth: this.config.security.maxJsonDepth,
        });
      }
      if (route.body) ctx.validateBody(route.body);

      if (route.csrf !== false) assertCsrf(ctx);
      if (route.permission) {
        // Sin actor la respuesta es 401 (falta autenticarse); con actor pero sin el
        // permiso, 403. Confundirlos hace que el cliente no sepa si debe iniciar
        // sesión o pedir permisos, y rompe el contrato de la v0.1.
        if (!ctx.actor) throw new UnauthorizedError('Inicia sesión como administrador para continuar.');
        this.rbac.assert(ctx.actor, route.permission);
      }

      const result = await route.handler(ctx);
      this.logger?.measure(`${route.method} ${route.path}`, ctx.durationMs);

      // Si el manejador ya escribió (redirección, HTML, fichero), no se toca la respuesta.
      if (res.writableEnded || res.headersSent) return;
      if (result === undefined || result === null) return respond.noContent(res);
      if (result && typeof result === 'object' && Array.isArray(result.data) && 'count' in result) {
        return respond.list(res, result);
      }
      return respond.json(res, route.status || 200, result);
    } catch (error) {
      this.stats.errors += 1;
      const status = error?.status || 500;
      if (status >= 500) this.logger?.error('Error atendiendo la petición', { path: url?.pathname || req.url, error: error.message });
      else this.logger?.debug('Petición rechazada', { path: url?.pathname || req.url, code: error.code, status });
      if (res.headersSent) return;
      return respond.fail(res, error, { exposeInternals: !this.config.isProduction });
    }
  }

  async runFallbacks(ctx) {
    for (const fallback of this.fallbacks) {
      const served = await fallback(ctx);
      if (served) return;
    }
    if (ctx.url.pathname.startsWith('/api/')) {
      return respond.fail(ctx.res, new NotFoundError('ruta', ctx.url.pathname));
    }
    return respond.html(ctx.res, 404, NOT_FOUND_PAGE);
  }
}

const NOT_FOUND_PAGE = '<!doctype html><html lang="es"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Página no encontrada | Ndivepa</title>'
  + '</head><body style="font-family:system-ui;max-width:640px;margin:80px auto;padding:0 20px;color:#15213a">'
  + '<h1>Página no encontrada</h1><p>El recurso solicitado no existe o dejó de estar publicado.</p>'
  + '<p><a href="/">Volver a Ndivepa</a></p></body></html>';

export { MethodNotAllowedError };
