/**
 * Compatibilidad con la API v0.1 (M-0173 … M-0190).
 *
 * Estas rutas existen para que la SPA actual y las 12 pruebas de regresión sigan
 * funcionando sin tocarlas. Devuelven **exactamente la misma forma** que el monolito
 * y delegan en los módulos nuevos.
 *
 * Diferencia deliberada: los importes viajan en decimales, como en la v0.1, aunque
 * internamente se guarden en unidades mínimas. La conversión ocurre solo aquí, en el
 * borde de la API heredada.
 */
import { rule } from '../../framework/validate.js';
import { NotFoundError, UnauthorizedError } from '../../framework/errors.js';
import { toDecimal } from '../../framework/money.js';
import * as respond from '../../framework/http/respond.js';

/** Mapa de recursos del CRUD genérico heredado (`mapped` en el monolito). */
const LEGACY_RESOURCES = {
  categories: { module: 'catalog', path: 'categories', permission: 'category' },
  merchants: { module: 'affiliate', path: 'merchants', permission: 'merchant' },
  networks: { module: 'affiliate', path: 'networks', permission: 'network' },
  programs: { module: 'affiliate', path: 'programs', permission: 'program' },
  campaigns: { module: 'affiliate', path: 'campaigns', permission: 'affiliateCampaign' },
  placements: { module: 'affiliate', path: 'placements', permission: 'placement' },
  links: { module: 'affiliate', path: 'links', permission: 'affiliateLink' },
  conversions: { module: 'affiliate', path: 'conversions', permission: 'conversion' },
  commissions: { module: 'affiliate', path: 'commissions', permission: 'commission' },
  payouts: { module: 'affiliate', path: 'payouts', permission: 'payout' },
  alerts: { module: 'alert', path: 'alerts', permission: 'alert' },
  audits: { module: null, path: 'audits', permission: 'audit' },
  events: { module: 'analytics', path: 'events', permission: 'event' },
};

const SERVICE_OF = {
  categories: module => module.categories,
  merchants: module => module.merchants,
  networks: module => module.networks,
  programs: module => module.programs,
  campaigns: module => module.campaigns,
  placements: module => module.placements,
  links: module => module.links,
  conversions: module => module.conversions,
  commissions: module => module.commissions,
  payouts: module => module.payouts,
  alerts: module => module,
};

/** Importes en decimales, como esperaba la SPA v0.1. */
function legacyPrice(price) {
  if (!price) return { amount: null, previousAmount: null, currency: 'USD', source: 'unknown', updatedAt: null };
  const currency = price.currency || 'USD';
  return {
    amount: price.amount === null || price.amount === undefined ? null : toDecimal(price.amount, currency),
    previousAmount: price.previousAmount === null || price.previousAmount === undefined
      ? null
      : toDecimal(price.previousAmount, currency),
    currency,
    source: price.source || 'unknown',
    updatedAt: price.updatedAt || null,
  };
}

/**
 * Proyección de producto idéntica a la función `product(d, p)` del monolito:
 * producto + categoría + comercio + programa + enlace resumido.
 */
export function legacyProductView(container, product) {
  const catalog = container.resolve('catalog');
  const affiliate = container.resolve('affiliate');
  const link = affiliate.links.forProduct(product.id)[0]
    || affiliate.links.repository.all({ productId: product.id })[0]
    || null;

  return {
    id: product.id,
    name: product.name,
    description: product.description || '',
    categoryId: product.categoryId || null,
    type: product.type,
    image: product.image || '🔗',
    merchantId: product.merchantId || null,
    programId: product.programId || null,
    campaignId: product.campaignId || null,
    monetizationType: 'AFFILIATE',
    status: product.status === 'published' ? 'published' : 'draft',
    price: legacyPrice(product.price),
    createdAt: product.createdAt,
    handle: product.handle,
    category: product.categoryId ? catalog.categories.repository.byId(product.categoryId) : undefined,
    merchant: product.merchantId ? affiliate.merchants.repository.byId(product.merchantId) : undefined,
    program: product.programId ? affiliate.programs.repository.byId(product.programId) : undefined,
    link: link && { id: link.id, status: link.status, health: link.health, validation: link.validation },
  };
}

/** Resumen del dashboard con los importes en decimales. */
function legacySummary(container) {
  const summary = container.resolve('analytics').reports.summary();
  const currency = container.resolve('settings').settings.get('defaultCurrency', 'USD');
  const decimal = value => (value === null || value === undefined ? value : toDecimal(value, currency));
  return {
    ...summary,
    commissionPending: decimal(summary.commissionPending),
    commissionApproved: decimal(summary.commissionApproved),
    commissionPaid: decimal(summary.commissionPaid),
    salesGenerated: decimal(summary.salesGenerated),
    epc: decimal(summary.epc),
    productPerformance: (summary.productPerformance || []).map(row => ({
      ...row,
      commission: decimal(row.commission),
      epc: decimal(row.epc),
    })),
    revenueSeparation: {
      ...summary.revenueSeparation,
      attributedSales: decimal(summary.revenueSeparation.attributedSales),
      ownIncomeConfirmed: decimal(summary.revenueSeparation.ownIncomeConfirmed),
      pendingNotIncome: decimal(summary.revenueSeparation.pendingNotIncome),
    },
  };
}

/**
 * @param {import('../../framework/container.js').Container} container
 * @returns {Array} definiciones de ruta para el prefijo `/api`
 */
export function legacyRoutes(container) {
  const catalog = () => container.resolve('catalog');
  const affiliate = () => container.resolve('affiliate');
  const settings = () => container.resolve('settings').settings;
  const analytics = () => container.resolve('analytics');

  const requireAdmin = ctx => {
    if (!ctx.actor) throw new UnauthorizedError('Inicia sesión como administrador para continuar.');
    return ctx.actor;
  };

  const resolveService = (resource, ctx) => {
    const definition = LEGACY_RESOURCES[resource];
    if (!definition) throw new NotFoundError('recurso', resource);
    if (resource === 'audits') return null;
    if (resource === 'events') return null;
    const module = container.resolve(definition.module);
    return SERVICE_OF[resource](module);
  };

  return [
    // ---------------------------------------------------------------- catálogo
    {
      method: 'GET',
      path: '/products',
      permission: null,
      summary: 'Catálogo afiliado publicado. Contrato v0.1.',
      tags: ['legacy'],
      bodyless: true,
      handler: ctx => {
        const includeAll = ctx.query.all === 'true' && ctx.actor?.type === 'user';
        const products = includeAll
          ? catalog().products.repository.all()
          : catalog().products.published();
        // La v0.1 devolvía un array plano, no un sobre con `data`.
        return respond.json(ctx.res, 200, products.map(product => legacyProductView(container, product)));
      },
    },
    {
      method: 'GET',
      path: '/store-config',
      permission: null,
      summary: 'Configuración pública de la tienda. Contrato v0.1.',
      tags: ['legacy'],
      bodyless: true,
      handler: () => settings().publicView(),
    },
    {
      method: 'GET',
      path: '/affiliate-summary',
      permission: 'analytics:read',
      summary: 'Resumen del dashboard. Contrato v0.1.',
      tags: ['legacy'],
      bodyless: true,
      handler: () => legacySummary(container),
    },
    {
      method: 'POST',
      path: '/events/view',
      permission: null,
      csrf: false,
      summary: 'Registra una visualización. Contrato v0.1.',
      tags: ['legacy'],
      status: 201,
      body: {
        productId: rule.id({ required: true }),
        sessionId: rule.text(80),
        source: rule.text(50),
        medium: rule.text(50),
        device: rule.text(30),
        page: rule.text(200),
        consent: rule.flag(),
      },
      handler: async ctx => {
        await analytics().tracking.trackView({
          productId: ctx.body.productId,
          sessionId: ctx.body.sessionId,
          source: ctx.body.source,
          medium: ctx.body.medium,
          page: ctx.body.page,
          referrer: ctx.referer,
          userAgent: ctx.userAgent,
          locale: ctx.locale,
          channelId: ctx.channelId,
          // Sin una señal explícita no se registra: los clientes que no ejecutan
          // la SPA pueden usar el cuerpo, la cookie o `?consent=1`.
          consent: ctx.body.consent ?? ctx.consent,
        });
        return { ok: true };
      },
    },

    // ------------------------------------------------------- CRUD heredado
    {
      method: 'GET',
      path: '/admin/products',
      permission: 'product:read',
      summary: 'Todos los productos afiliados. Contrato v0.1.',
      tags: ['legacy'],
      bodyless: true,
      handler: ctx => respond.json(
        ctx.res,
        200,
        catalog().products.repository.all().map(product => legacyProductView(container, product)),
      ),
    },
    {
      method: 'POST',
      path: '/admin/products',
      permission: 'product:create',
      summary: 'Crea un producto afiliado con su enlace. Contrato v0.1.',
      tags: ['legacy'],
      status: 201,
      body: {
        name: rule.text(200, { required: true }),
        description: rule.text(4000),
        categoryId: rule.id(),
        type: rule.text(30),
        image: rule.text(500),
        merchantId: rule.id({ required: true }),
        programId: rule.id({ required: true }),
        campaignId: rule.id(),
        status: rule.text(20),
        affiliateUrl: rule.text(2048, { required: true }),
        productUrl: rule.text(2048),
        price: { type: 'number', coerce: true, min: 0 },
        previousPrice: { type: 'number', coerce: true, min: 0 },
        currency: rule.currency(),
        priceSource: rule.text(20),
      },
      handler: async ctx => {
        const body = ctx.body;
        const currency = (body.currency || settings().get('defaultCurrency', 'USD')).toUpperCase();
        const { toMinor } = await import('../../framework/money.js');

        // Se valida el enlace antes de crear nada: así no queda un producto huérfano
        // si la URL es inválida, como ocurría en la v0.1.
        const validation = affiliate().links.preview({
          affiliateUrl: body.affiliateUrl,
          merchantId: body.merchantId,
          programId: body.programId,
        });
        if (validation.status === 'invalid') {
          return respond.json(ctx.res, 422, { error: validation.messages.join(' '), validation });
        }

        const product = await catalog().products.create({
          name: body.name,
          description: body.description || '',
          categoryId: body.categoryId || null,
          type: ['physical', 'digital', 'service', 'course', 'bundle', 'subscription'].includes(body.type) ? body.type : 'other',
          image: body.image || '🔗',
          merchantId: body.merchantId,
          programId: body.programId,
          campaignId: body.campaignId || null,
          monetizationType: 'AFFILIATE',
          status: body.status === 'published' ? 'draft' : 'draft',
          price: {
            amount: body.price === undefined || body.price === null ? null : toMinor(body.price, currency),
            previousAmount: body.previousPrice === undefined || body.previousPrice === null ? null : toMinor(body.previousPrice, currency),
            currency,
            source: body.priceSource || 'manual',
            updatedAt: body.price === undefined || body.price === null ? null : new Date().toISOString(),
          },
        }, ctx);

        await affiliate().links.create({
          productId: product.id,
          merchantId: body.merchantId,
          programId: body.programId,
          affiliateUrl: body.affiliateUrl,
          productUrl: body.productUrl || null,
        }, ctx);

        // La publicación se aplica al final, cuando el enlace ya existe y se puede
        // comprobar la regla de «no publicar con enlace inválido».
        if (body.status === 'published') {
          await catalog().products.update(product.id, { status: 'published' }, ctx);
        }

        return respond.json(ctx.res, 201, legacyProductView(container, catalog().products.repository.retrieve(product.id)));
      },
    },
    {
      method: 'PATCH',
      path: '/admin/products/:id',
      permission: 'product:update',
      summary: 'Actualiza un producto afiliado. Contrato v0.1 con campos validados.',
      tags: ['legacy'],
      body: {
        name: rule.text(200),
        description: rule.text(4000),
        categoryId: rule.id(),
        type: rule.text(30),
        image: rule.text(500),
        merchantId: rule.id(),
        programId: rule.id(),
        campaignId: rule.id(),
        status: rule.text(20),
        price: { type: 'object', shape: {}, allowUnknown: true },
      },
      handler: async ctx => {
        const changes = { ...ctx.body };
        // `id`, `createdAt` y `monetizationType` no se aceptan desde el cuerpo (M-0186).
        delete changes.id;
        delete changes.createdAt;
        delete changes.monetizationType;
        if (changes.type && !['physical', 'digital', 'service', 'course', 'bundle', 'subscription', 'other'].includes(changes.type)) {
          changes.type = 'other';
        }
        if (changes.price) {
          const { toMinor } = await import('../../framework/money.js');
          const currency = (changes.price.currency || settings().get('defaultCurrency', 'USD')).toUpperCase();
          changes.price = {
            amount: changes.price.amount === null || changes.price.amount === undefined
              ? null
              : toMinor(changes.price.amount, currency),
            previousAmount: changes.price.previousAmount === null || changes.price.previousAmount === undefined
              ? null
              : toMinor(changes.price.previousAmount, currency),
            currency,
            source: changes.price.source || 'manual',
            updatedAt: new Date().toISOString(),
          };
        }
        const updated = await catalog().products.update(ctx.params.id, changes, ctx);
        return legacyProductView(container, updated);
      },
    },
    {
      method: 'DELETE',
      path: '/admin/products/:id',
      permission: 'product:delete',
      summary: 'Borra un producto afiliado y sus enlaces. Contrato v0.1.',
      tags: ['legacy'],
      bodyless: true,
      handler: async ctx => {
        const view = legacyProductView(container, catalog().products.repository.retrieve(ctx.params.id));
        for (const link of affiliate().links.repository.all({ productId: ctx.params.id })) {
          await affiliate().links.delete(link.id, ctx);
        }
        await catalog().products.delete(ctx.params.id, ctx);
        return view;
      },
    },

    // ------------------------------------------------- validación de enlaces
    {
      method: 'POST',
      path: '/admin/links/validate',
      permission: 'affiliateLink:read',
      summary: 'Valida un enlace antes de guardarlo. Contrato v0.1.',
      tags: ['legacy'],
      body: {
        affiliateUrl: rule.text(2048, { required: true }),
        merchantId: rule.id(),
        programId: rule.id(),
        productUrl: rule.text(2048),
      },
      handler: ctx => affiliate().links.preview(ctx.body),
    },
    {
      method: 'POST',
      path: '/admin/links/:id/validate',
      permission: 'affiliateLink:update',
      summary: 'Revalida un enlace guardado sin modificar su URL. Contrato v0.1.',
      tags: ['legacy'],
      handler: ctx => affiliate().links.revalidate(ctx.params.id, ctx),
    },

    // El CRUD genérico se resuelve con una ruta comodín, igual que hacía `mapped`.
    {
      method: 'GET',
      path: '/admin/:resource',
      permission: null,
      summary: 'CRUD genérico heredado: devuelve la colección completa como array plano.',
      tags: ['legacy'],
      bodyless: true,
      handler: ctx => {
        const definition = LEGACY_RESOURCES[ctx.params.resource];
        if (!definition) throw new NotFoundError('ruta', ctx.url.pathname);
        const actor = requireAdmin(ctx);
        container.resolve('rbac').assert(actor, `${definition.permission}:read`);

        if (ctx.params.resource === 'audits') {
          return respond.json(ctx.res, 200, container.resolve('audit').list({ limit: 500 }));
        }
        if (ctx.params.resource === 'events') {
          return respond.json(ctx.res, 200, container.resolve('store').collection('events').slice(-500).reverse());
        }
        const service = resolveService(ctx.params.resource, ctx);
        return respond.json(ctx.res, 200, service.repository.all());
      },
    },
    {
      method: 'POST',
      path: '/admin/:resource',
      permission: null,
      summary: 'CRUD genérico heredado: crea un registro validado.',
      tags: ['legacy'],
      status: 201,
      bodyless: false,
      handler: async ctx => {
        const definition = LEGACY_RESOURCES[ctx.params.resource];
        if (!definition || ['audits', 'events'].includes(ctx.params.resource)) {
          throw new NotFoundError('ruta', ctx.url.pathname);
        }
        const actor = requireAdmin(ctx);
        container.resolve('rbac').assert(actor, `${definition.permission}:create`);
        const service = resolveService(ctx.params.resource, ctx);
        return respond.json(ctx.res, 201, await service.create(ctx.body, ctx));
      },
    },
    {
      method: 'PATCH',
      path: '/admin/:resource/:id',
      permission: null,
      summary: 'CRUD genérico heredado: actualiza un registro validado.',
      tags: ['legacy'],
      handler: async ctx => {
        const definition = LEGACY_RESOURCES[ctx.params.resource];
        if (!definition || ['audits', 'events'].includes(ctx.params.resource)) {
          throw new NotFoundError('ruta', ctx.url.pathname);
        }
        const actor = requireAdmin(ctx);
        container.resolve('rbac').assert(actor, `${definition.permission}:update`);
        const service = resolveService(ctx.params.resource, ctx);
        return service.update(ctx.params.id, ctx.body, ctx);
      },
    },
    {
      method: 'DELETE',
      path: '/admin/:resource/:id',
      permission: null,
      summary: 'CRUD genérico heredado: borra un registro.',
      tags: ['legacy'],
      bodyless: true,
      handler: async ctx => {
        const definition = LEGACY_RESOURCES[ctx.params.resource];
        if (!definition || ['audits', 'events'].includes(ctx.params.resource)) {
          throw new NotFoundError('ruta', ctx.url.pathname);
        }
        const actor = requireAdmin(ctx);
        container.resolve('rbac').assert(actor, `${definition.permission}:delete`);
        const service = resolveService(ctx.params.resource, ctx);
        return service.delete(ctx.params.id, ctx);
      },
    },

    // ------------------------------------------------------------- uploads
    {
      method: 'POST',
      path: '/admin/uploads',
      permission: 'asset:create',
      summary: 'Sube una imagen validando su firma binaria. Contrato v0.1.',
      tags: ['legacy'],
      status: 201,
      maxBodyBytes: 1_200_000,
      body: { data: { type: 'string', required: true, maxLength: 1_200_000 } },
      handler: async ctx => {
        const files = container.resolve('files');
        const stored = await files.store(ctx.body.data);
        // La v0.1 devolvía solo `{url, mime, bytes}`; el activo se registra igual.
        await container.resolve('catalog').assets.create({
          name: stored.filename,
          alt: 'Imagen subida desde el panel',
          url: stored.url,
          filename: stored.filename,
          mime: stored.mime,
          bytes: stored.bytes,
          width: stored.dimensions.width,
          height: stored.dimensions.height,
          hash: stored.hash,
          provider: stored.provider,
        }, ctx).catch(() => null);
        return { url: stored.url, mime: stored.mime, bytes: stored.bytes };
      },
    },
  ];
}

/**
 * Redirección afiliada `/go/:linkId` (M-0180).
 *
 * Reglas que no cambian respecto a la v0.1:
 *  - sin `consent=1` se redirige **sin registrar** el clic;
 *  - el destino es el `affiliateUrl` tal cual, sin añadir ni quitar parámetros.
 */
export function redirectRoute(container) {
  return {
    method: 'GET',
    path: '/go/:linkId',
    permission: null,
    csrf: false,
    bodyless: true,
    summary: 'Registra el clic afiliado y redirige al comercio sin alterar la URL.',
    tags: ['legacy'],
    handler: async ctx => {
      const affiliate = container.resolve('affiliate');
      const link = affiliate.links.repository.byId(ctx.params.linkId);
      if (!link || link.status === 'invalid' || link.active === false) {
        return respond.text(ctx.res, 404, 'Enlace no disponible.');
      }

      const consent = ctx.url.searchParams.get('consent') === '1';
      const sessionId = String(
        ctx.url.searchParams.get('sid') || ctx.cookies.ndivepa_visitor || `ses_${Date.now().toString(36)}`,
      ).slice(0, 80);

      const result = await container.resolve('analytics').tracking.registerClick({
        linkId: link.id,
        sessionId,
        source: ctx.url.searchParams.get('source'),
        medium: ctx.url.searchParams.get('medium'),
        campaign: ctx.url.searchParams.get('campaign'),
        placementId: ctx.url.searchParams.get('placement'),
        page: ctx.url.searchParams.get('page'),
        referrer: ctx.referer,
        userAgent: ctx.userAgent,
        channelId: ctx.channelId,
        consent,
      });

      if (!result) return respond.text(ctx.res, 404, 'Enlace no disponible.');

      const headers = { Location: result.destination };
      if (consent) {
        headers['Set-Cookie'] = `ndivepa_visitor=${sessionId}; SameSite=Lax; Path=/; Max-Age=2592000`;
      }
      ctx.res.writeHead(302, headers);
      ctx.res.end();
    },
  };
}
