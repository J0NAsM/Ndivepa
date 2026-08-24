/**
 * Arranque de la aplicación (M-0093 … M-0095, M-0159 … M-0161).
 *
 * Este fichero sustituye al monolito: compone el framework, registra los módulos de
 * dominio, monta los routers y devuelve un manejador HTTP. `server.js` solo lo llama.
 *
 * Superficies HTTP montadas:
 *
 *   /api/...                contrato v0.1 congelado (compatibilidad)
 *   /api/auth/...           autenticación
 *   /api/v1/admin/...       API de administración nueva
 *   /api/v1/store/...       API de tienda nueva
 *   /producto, /campana...  páginas SEO renderizadas en el servidor
 *   /...                    estáticos de `public/`
 */
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, redactConfig, StrategyRegistry } from './framework/config.js';
import { createLogger } from './framework/logger.js';
import { Store } from './framework/store.js';
import { Container } from './framework/container.js';
import { EventBus } from './framework/events.js';
import { JobQueue } from './framework/jobs.js';
import { Cache } from './framework/cache.js';
import { LockService } from './framework/locks.js';
import { WorkflowEngine } from './framework/workflow.js';
import { PermissionRegistry, Rbac } from './framework/rbac.js';
import { I18n, TranslationStore } from './framework/i18n.js';
import { CustomFieldRegistry } from './framework/customfields.js';
import { SearchIndex } from './framework/search.js';
import { FileService, LocalFileProvider } from './framework/files.js';
import { NotificationService } from './framework/notifications.js';
import { AnalyticsService, LocalAnalyticsProvider } from './framework/analytics.js';
import { WebhookService } from './framework/webhooks.js';
import { RateLimiter } from './framework/ratelimit.js';
import { PluginRegistry } from './framework/plugins.js';
import { Router } from './framework/http/router.js';
import { HttpApp } from './framework/http/pipeline.js';
import { buildOpenApi, renderDocsPage } from './framework/http/openapi.js';
import { serveStatic } from './framework/http/middlewares.js';
import * as respond from './framework/http/respond.js';

import { registerMigrations, COLLECTIONS } from './migrations.js';
import { AuditService } from './modules/base.js';
import { legacyRoutes, redirectRoute } from './api/legacy/index.js';
import { seoRoutes } from './api/seo/index.js';
import { SPANISH_MESSAGES } from './i18n/es.js';

import settingsModule from './modules/settings/index.js';
import geographyModule from './modules/geography/index.js';
import taxModule from './modules/tax/index.js';
import channelModule from './modules/channel/index.js';
import alertModule from './modules/alert/index.js';
import accessModule from './modules/access/index.js';
import customerModule from './modules/customer/index.js';
import catalogModule from './modules/catalog/index.js';
import pricingModule from './modules/pricing/index.js';
import inventoryModule from './modules/inventory/index.js';
import affiliateModule from './modules/affiliate/index.js';
import analyticsModule from './modules/analytics/index.js';
import promotionModule from './modules/promotion/index.js';
import loyaltyModule from './modules/loyalty/index.js';
import cartModule from './modules/cart/index.js';
import orderModule from './modules/order/index.js';
import paymentModule from './modules/payment/index.js';
import fulfillmentModule from './modules/fulfillment/index.js';
import checkoutModule from './modules/checkout/index.js';
import contentModule from './modules/content/index.js';
import diagnosticsModule from './modules/diagnostics/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Orden de registro. El contenedor recalcula el orden real por dependencias. */
export const MODULES = [
  settingsModule,
  geographyModule,
  taxModule,
  channelModule,
  alertModule,
  accessModule,
  customerModule,
  catalogModule,
  pricingModule,
  inventoryModule,
  affiliateModule,
  analyticsModule,
  promotionModule,
  loyaltyModule,
  cartModule,
  orderModule,
  paymentModule,
  fulfillmentModule,
  checkoutModule,
  contentModule,
  diagnosticsModule,
];

/**
 * Construye la aplicación completa sin escuchar en ningún puerto.
 * Útil para pruebas de dominio que no necesitan HTTP.
 */
export async function createApp({ env = process.env, plugins = [], seed = null } = {}) {
  const config = loadConfig(env);
  const logger = createLogger({ level: config.log.level, pretty: config.log.pretty });

  // --- Persistencia -----------------------------------------------------------
  const store = new Store({
    file: join(root, 'data', 'db.json'),
    snapshotDir: join(root, 'backups', 'snapshots'),
    snapshotKeep: config.storage.snapshotKeep,
    logger,
  });
  registerMigrations(store);
  for (const collection of COLLECTIONS) store.declare(collection);
  store.declare('settings', { singleton: true });
  await store.load();

  // --- Servicios transversales ------------------------------------------------
  const events = new EventBus({ logger });
  const cache = new Cache({ defaultTtlMs: 30_000 });
  const locks = new LockService({ logger });
  const jobs = new JobQueue({ store, logger, tickMs: config.jobs.tickMs, enabled: config.jobs.enabled });
  const workflows = new WorkflowEngine({ logger, store });
  const permissions = new PermissionRegistry();
  const rbac = new Rbac({ registry: permissions, logger });
  const i18n = new I18n({ defaultLocale: config.defaultLocale, supported: config.supportedLocales, logger });
  i18n.register('es', SPANISH_MESSAGES);
  const translations = new TranslationStore({ store, defaultLocale: config.defaultLocale });
  const customFields = new CustomFieldRegistry();
  const search = new SearchIndex({ logger });
  const files = new FileService({
    provider: new LocalFileProvider({ directory: join(root, 'public', 'uploads'), publicPath: '/uploads' }),
    logger,
  });
  const notifications = new NotificationService({ store, logger });
  const analyticsProvider = new AnalyticsService({ provider: new LocalAnalyticsProvider({ store }), logger, requireConsent: true });
  const webhooks = new WebhookService({ store, logger, enabled: config.features.webhooks });
  const rateLimiter = new RateLimiter({ trustProxy: config.security.trustProxy });
  const strategies = new StrategyRegistry();
  const audit = new AuditService({ store });
  const pluginRegistry = new PluginRegistry({ logger });

  // --- Contenedor -------------------------------------------------------------
  const container = new Container({ logger });
  container.value('config', config);
  container.value('logger', logger);
  container.value('store', store);
  container.value('events', events);
  container.value('cache', cache);
  container.value('locks', locks);
  container.value('jobs', jobs);
  container.value('workflows', workflows);
  container.value('permissions', permissions);
  container.value('rbac', rbac);
  container.value('i18n', i18n);
  container.value('translations', translations);
  container.value('customFields', customFields);
  container.value('search', search);
  container.value('files', files);
  container.value('notifications', notifications);
  container.value('analyticsProvider', analyticsProvider);
  container.value('webhooks', webhooks);
  container.value('rateLimiter', rateLimiter);
  container.value('strategies', strategies);
  container.value('audit', audit);
  container.value('plugins', pluginRegistry);
  container.value('container', container);

  for (const module of MODULES) container.module(module);

  // --- Permisos, campos personalizados y estrategias declarados por módulo ----
  for (const module of MODULES) {
    for (const permission of module.permissions || []) {
      permissions.declare(permission.resource, permission);
    }
    for (const field of module.customFields || []) {
      customFields.declare(field.entity, field);
    }
    for (const [name, factory] of Object.entries(module.strategies || {})) {
      strategies.register(name, factory);
    }
  }

  // --- Plugins ----------------------------------------------------------------
  const routeCollections = { admin: [], store: [], auth: [] };
  for (const plugin of plugins) pluginRegistry.register(plugin);
  await pluginRegistry.apply({
    container, strategies, events, jobs, customFields, permissions, routes: routeCollections,
  });

  // --- Arranque de módulos ----------------------------------------------------
  await container.boot({ logger });

  // --- Suscriptores y trabajos declarados por módulo --------------------------
  for (const module of MODULES) {
    const subscribers = typeof module.subscribers === 'function' ? module.subscribers(container) : module.subscribers || [];
    for (const subscriber of subscribers) {
      events.subscribe(subscriber.event, subscriber.handler, { name: `${module.name}:${subscriber.event}` });
    }
    const moduleJobs = typeof module.jobs === 'function' ? module.jobs(container) : module.jobs || [];
    for (const job of moduleJobs) {
      jobs.register(job.name, job.handler, job.options);
      if (job.everyMs) jobs.schedule(job.name, { everyMs: job.everyMs, payload: job.payload || {} });
    }
  }

  // Los eventos confirmados por el `Store` se publican al bus una vez en disco.
  jobs.register('framework.drain-events', async () => {
    const drained = store.drainEvents();
    for (const entry of drained) await events.emit(entry.name, entry.payload);
    return { drained: drained.length };
  });
  jobs.schedule('framework.drain-events', { everyMs: 30_000 });
  jobs.register('framework.prune', async () => ({
    cache: cache.prune(),
    locks: locks.prune(),
    rateLimiter: rateLimiter.prune(),
  }));
  jobs.schedule('framework.prune', { everyMs: 10 * 60_000 });

  // --- Semilla ----------------------------------------------------------------
  if (seed ?? config.seed.enabled) {
    for (const name of container.bootOrder) {
      const module = container.modules.get(name);
      if (typeof module.seed !== 'function') continue;
      try {
        await module.seed(container.resolve(name), container);
      } catch (error) {
        logger.error('Fallo al sembrar un módulo', { module: name, error: error.message });
      }
    }
    await ensureAdminAccount(container, logger);
  }

  // El índice de búsqueda se construye al arrancar, no en la primera petición.
  if (config.features.search) container.resolve('catalog').products.reindex();

  return {
    config, logger, store, container, events, jobs, cache, locks, workflows,
    permissions, rbac, i18n, translations, customFields, search, files,
    notifications, analyticsProvider, webhooks, rateLimiter, strategies, audit,
    routeCollections,
  };
}

/**
 * Cuenta administradora inicial (M-0169).
 * Se crea solo si no hay ninguna. La contraseña inicial se mantiene igual que en la
 * v0.1 para no romper el primer acceso local, y el panel obliga a cambiarla.
 */
async function ensureAdminAccount(container, logger) {
  const access = container.resolve('access');
  if (access.users.repository.count() > 0) return null;
  const { initialAdmin } = container.resolve('config');
  if (!initialAdmin.password) {
    throw new Error('No existe una cuenta administradora. Define INITIAL_ADMIN_PASSWORD antes de iniciar una instancia de producción nueva.');
  }
  const created = await access.users.createWithPassword({
    name: 'Administración Ndivepa',
    email: initialAdmin.email,
    role: 'admin',
    roleCodes: ['superadmin'],
    status: 'active',
    password: initialAdmin.password,
  });
  logger.warn('Cuenta administradora inicial creada. Cambia la contraseña antes de publicar.', { email: created.email });
  return created;
}

/** Monta todos los routers y devuelve el `HttpApp` listo para `createServer`. */
export function buildHttpApp(app) {
  const { config, container, logger, rateLimiter, rbac, i18n } = app;
  const router = new Router();

  // 1. Contrato v0.1 congelado.
  const legacy = new Router({ prefix: '/api' });
  for (const route of legacyRoutes(container)) legacy.add(route);
  for (const route of app.routeCollections.auth) legacy.add(route);

  // 2. Autenticación (también en /api, como en la v0.1).
  const authRoutes = typeof accessModule.routes.auth === 'function' ? accessModule.routes.auth(container) : [];
  for (const route of authRoutes) legacy.add(route);

  // 3. API de administración v1.
  const admin = new Router({ prefix: '/api/v1/admin' });
  for (const module of MODULES) {
    const routes = typeof module.routes?.admin === 'function' ? module.routes.admin(container) : module.routes?.admin || [];
    for (const route of routes) admin.add(route);
  }
  for (const route of app.routeCollections.admin) admin.add(route);
  admin.add({
    method: 'GET',
    path: '/audits',
    permission: 'audit:read',
    summary: 'Auditoría consultable con filtros.',
    tags: ['operación'],
    bodyless: true,
    handler: ctx => {
      const data = container.resolve('audit').list({
        limit: Math.min(500, Number(ctx.query.limit) || 100),
        entity: ctx.query.entity || null,
        entityId: ctx.query.entityId || null,
        actorId: ctx.query.actorId || null,
      });
      return { data, count: data.length, limit: data.length, offset: 0, hasMore: false };
    },
  });

  // 4. API de tienda v1.
  const storeApi = new Router({ prefix: '/api/v1/store' });
  for (const module of MODULES) {
    const routes = typeof module.routes?.store === 'function' ? module.routes.store(container) : module.routes?.store || [];
    for (const route of routes) storeApi.add(route);
  }
  for (const route of app.routeCollections.store) storeApi.add(route);

  // 5. Rutas sin prefijo: SEO, redirección afiliada, contrato OpenAPI.
  const roots = new Router();
  for (const route of seoRoutes(container, config)) roots.add(route);
  roots.add(redirectRoute(container));

  router.merge(legacy).merge(admin).merge(storeApi).merge(roots);

  // Documentación generada desde las rutas ya registradas.
  const spec = buildOpenApi({ router, config, version: '0.2.0' });
  router.add({
    method: 'GET',
    path: '/api/openapi.json',
    permission: null,
    bodyless: true,
    summary: 'Contrato OpenAPI 3.1 generado desde las rutas registradas.',
    tags: ['operación'],
    handler: ctx => respond.cacheable(ctx.req, ctx.res, spec, { maxAge: 60 }),
  });
  const docsHtml = renderDocsPage('/api/openapi.json');
  router.add({
    method: 'GET',
    path: '/api/docs',
    permission: null,
    bodyless: true,
    summary: 'Documentación navegable de la API.',
    tags: ['operación'],
    handler: ctx => respond.html(ctx.res, 200, docsHtml, { 'Cache-Control': 'private, max-age=60' }),
  });
  router.add({
    method: 'GET',
    path: '/api/ready',
    permission: null,
    bodyless: true,
    summary: 'Indica si el arranque, la migración y la semilla han terminado.',
    tags: ['operación'],
    handler: () => ({
      ready: true,
      schemaVersion: app.store.read().schemaVersion,
      modules: container.bootOrder.length,
      routes: router.routes.length,
    }),
  });

  const httpApp = new HttpApp({ router, config, container, logger, rateLimiter, i18n, rbac });

  // --- Autenticadores ---------------------------------------------------------
  for (const authenticator of accessModule.authenticators(container)) httpApp.useAuthenticator(authenticator);
  httpApp.useAuthenticator(channelModule.channelAuthenticator(container));

  // --- Rate limits (los mismos umbrales que la v0.1, más los nuevos) ----------
  const ip = ctx => ctx.ip || 'unknown';
  httpApp.useRateLimit(
    ctx => ctx.method === 'POST' && ctx.url.pathname.endsWith('/auth/login'),
    ctx => `login:${ip(ctx)}`,
    config.rateLimits.login,
  );
  httpApp.useRateLimit(
    ctx => ctx.method === 'POST' && ctx.url.pathname.includes('/events/'),
    ctx => `events:${ip(ctx)}`,
    config.rateLimits.view,
  );
  httpApp.useRateLimit(
    ctx => ctx.method === 'GET' && ctx.url.pathname.startsWith('/go/'),
    ctx => `click:${ip(ctx)}`,
    config.rateLimits.click,
  );
  httpApp.useRateLimit(
    ctx => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(ctx.method) && ctx.url.pathname.startsWith('/api/'),
    ctx => `write:${ctx.actor?.id || ip(ctx)}`,
    config.rateLimits.write,
  );

  // --- Estáticos como último recurso ------------------------------------------
  httpApp.useFallback(async ctx => {
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return false;
    if (ctx.url.pathname.startsWith('/api/')) return false;
    return serveStatic(ctx.req, ctx.res, {
      pathname: ctx.url.pathname,
      root: join(root, 'public'),
      index: 'index.html',
    });
  });

  return { httpApp, router, spec };
}

/** Arranca el servidor HTTP y devuelve todo lo necesario para apagarlo. */
export async function start({ env = process.env, plugins = [] } = {}) {
  const app = await createApp({ env, plugins });
  const { httpApp, router, spec } = buildHttpApp(app);

  const server = createServer(httpApp.handler());
  await new Promise(resolve => server.listen(app.config.port, resolve));
  app.jobs.start();

  app.logger.info('Ndivepa disponible', {
    url: `http://localhost:${app.config.port}`,
    schemaVersion: app.store.read().schemaVersion,
    modules: app.container.bootOrder.length,
    routes: router.routes.length,
    commerceMode: app.container.resolve('settings').settings.mode(),
  });
  app.logger.debug('Configuración efectiva', redactConfig(app.config));

  const shutdown = async () => {
    app.jobs.stop();
    await new Promise(resolve => server.close(resolve));
    await app.store.flush();
    await app.container.shutdown();
  };

  return { ...app, server, router, spec, shutdown };
}
