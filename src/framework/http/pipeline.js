/**
 * Pipeline HTTP (M-0129, M-0159).
 *
 * Reemplazo directo del monkey-patch de `Server.prototype.emit`. El orden es
 * explícito y se lee de arriba abajo:
 *
 *   cabeceras -> cors -> preflight -> límite de tamaño -> rate limit ->
 *   contexto -> autenticación -> ruta -> CSRF -> permiso -> cuerpo -> manejador
 *
 * Lo que no coincide con ninguna ruta cae en los `fallbacks` (SEO server-side y
 * estáticos), en el mismo orden en que se registraron.
 */
import { MethodNotAllowedError, NotFoundError, PayloadTooLargeError, UnauthorizedError } from '../errors.js';
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
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const ctx = new RequestContext({
      req,
      res,
      url,
      config: this.config,
      container: this.container,
      logger: this.logger,
      i18n: this.i18n,
    });

    securityHeaders(res, { isProduction: this.config.isProduction });
    decorateWriteHead(req, res, { isProduction: this.config.isProduction, requestId: ctx.requestId });
    applyCors(req, res, { origins: this.config.security.corsOrigins });

    try {
      if (ctx.method === 'OPTIONS') {
        const allowed = this.router.allowedFor(url.pathname);
        res.writeHead(204, { Allow: allowed.length ? allowed.join(', ') : 'GET, HEAD, OPTIONS' });
        res.end();
        return;
      }

      if (Number(req.headers['content-length'] || 0) > this.config.security.maxBodyBytes) {
        return respond.fail(res, new PayloadTooLargeError(this.config.security.maxBodyBytes));
      }

      for (const entry of this.rateRules) {
        if (entry.test(ctx)) enforceRateLimit(this.rateLimiter, entry.keyOf(ctx), entry.limit, res);
      }

      await this.authenticate(ctx);

      let resolved;
      try {
        resolved = this.router.resolve(ctx.method, url.pathname);
      } catch (error) {
        if (error instanceof NotFoundError) return await this.runFallbacks(ctx);
        throw error;
      }

      const { route, params, headOnly } = resolved;
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
      if (headOnly) return respond.json(res, 200, {});
      if (result && typeof result === 'object' && Array.isArray(result.data) && 'count' in result) {
        return respond.list(res, result);
      }
      return respond.json(res, route.status || 200, result);
    } catch (error) {
      this.stats.errors += 1;
      const status = error?.status || 500;
      if (status >= 500) this.logger?.error('Error atendiendo la petición', { path: url.pathname, error: error.message });
      else this.logger?.debug('Petición rechazada', { path: url.pathname, code: error.code, status });
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
