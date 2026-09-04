/**
 * Analítica y tracking (M-0144, M-0150, M-0748 … M-0755, M-0967 … M-0969).
 *
 * Tres garantías que este módulo no puede romper:
 *
 *  1. **Sin consentimiento no se registra nada.** El clic redirige igual; simplemente
 *     no se guarda el evento (M-0317).
 *  2. **La URL de afiliado no se toca.** La redirección usa exactamente el destino
 *     configurado, sin añadir parámetros (M-0314).
 *  3. **La venta atribuida no es ingreso.** El resumen las devuelve en claves
 *     distintas y nunca las suma (M-0318, M-0732).
 */
import { defineResource } from '../base.js';
import { rule } from '../../framework/validate.js';
import { detectDevice, detectSource } from '../../framework/analytics.js';
import { id as generateId } from '../../framework/ids.js';
import { GROUPERS, lastDaysRange, now, previousRange, seriesKeys, toDate, withinRange } from '../../framework/dates.js';
import { NotFoundError } from '../../framework/errors.js';

export const eventResource = defineResource({
  name: 'event',
  collection: 'events',
  prefix: 'evt',
  route: 'events',
  softDelete: false,
  searchable: ['type', 'source', 'clickId'],
  fields: {
    type: rule.text(60, { required: true }),
    productId: rule.id(),
    variantId: rule.id(),
    clickId: rule.text(40),
    linkId: rule.id(),
    merchantId: rule.id(),
    networkId: rule.id(),
    programId: rule.id(),
    campaignId: rule.id(),
    placementId: rule.id(),
    channelId: rule.id(),
    contentId: rule.id(),
    promotionId: rule.id(),
    sessionId: rule.text(80),
    customerId: rule.id(),
    source: rule.text(50),
    medium: rule.text(50),
    campaign: rule.text(80),
    term: rule.text(120),
    referrer: rule.text(500),
    device: rule.text(30),
    country: rule.text(60),
    locale: rule.text(10),
    page: rule.text(200),
    fraudFlag: rule.flag({ default: false }),
    fraudReason: rule.text(200),
    metadata: rule.metadata(),
  },
});

export class TrackingService {
  constructor({ store, events, analytics, settings, catalog, affiliate, alerts, config }) {
    this.store = store;
    this.events = events;
    this.analytics = analytics;
    this.settings = settings;
    this.catalog = catalog;
    this.affiliate = affiliate;
    this.alerts = alerts;
    this.config = config;
  }

  /** Registro de vista de producto. Devuelve `null` si no hay consentimiento. */
  async trackView({ productId, variantId = null, sessionId, source, medium, page, referrer, userAgent, locale, channelId, consent }) {
    const product = this.catalog.products.repository.byId(productId);
    if (!product || product.status !== 'published') throw new NotFoundError('producto', productId);

    const event = await this.analytics.track({
      type: 'product_view',
      consent,
      productId,
      variantId,
      sessionId: safeTrackingId(sessionId),
      channelId,
      source: detectSource(referrer, source),
      medium,
      page,
      referrer,
      device: detectDevice(userAgent),
      locale,
    });
    if (event) await this.catalog.products.incrementCounter(productId, 'viewCount');
    return event;
  }

  async trackSearch({ term, results, sessionId, consent, channelId }) {
    return this.analytics.track({ type: 'search', consent, term, sessionId, channelId, metadata: { results } });
  }

  async trackContentClick({ contentId, productId, sessionId, consent }) {
    return this.analytics.track({ type: 'content_click', consent, contentId, productId, sessionId });
  }

  async trackCouponClick({ linkId, productId, sessionId, consent }) {
    return this.analytics.track({ type: 'coupon_click', consent, linkId, productId, sessionId });
  }

  /**
   * Registra un clic afiliado y devuelve el destino **sin modificarlo**.
   *
   * @returns {{destination:string, clickId:string|null, tracked:boolean}}
   */
  async registerClick({ linkId, sessionId, source, medium, campaign, placementId, page, referrer, userAgent, consent, channelId }) {
    const link = this.affiliate.links.repository.byId(linkId);
    if (!link || link.status === 'invalid' || !link.active) return null;

    const product = this.catalog.products.repository.byId(link.productId);
    // Un enlace huérfano, borrado o de un borrador nunca funciona como redirección
    // pública, incluso si alguien conservó la URL `/go/...`.
    if (!product || product.status !== 'published') return null;
    sessionId = safeTrackingId(sessionId);
    const program = link.programId ? this.store.collection('programs').find(row => row.id === link.programId) : null;

    // Sin consentimiento se redirige igual, pero no se registra el evento.
    if (!consent) {
      return { destination: link.affiliateUrl, clickId: null, tracked: false };
    }

    const clickId = `CLK-${generateId('c').split('_')[1].toUpperCase().slice(0, 10)}`;
    const recent = this.store.collection('events').find(event => (
      event.type === 'affiliate_click'
      && event.sessionId === sessionId
      && event.productId === link.productId
      && Date.now() - (toDate(event.timestamp)?.getTime() ?? 0) < 2500
    ));

    await this.analytics.track({
      type: 'affiliate_click',
      consent: true,
      clickId,
      linkId: link.id,
      productId: link.productId,
      merchantId: link.merchantId || product?.merchantId || null,
      networkId: program?.networkId || null,
      programId: link.programId || product?.programId || null,
      campaignId: product?.campaignId || null,
      placementId,
      channelId,
      sessionId,
      source: detectSource(referrer, source),
      medium,
      campaign,
      referrer,
      device: detectDevice(userAgent),
      page,
      // Clics muy seguidos de la misma sesión sobre el mismo producto: sospechoso (M-0748).
      fraudFlag: Boolean(recent),
      fraudReason: recent ? 'clics_repetidos_en_menos_de_2500ms' : null,
    });

    if (recent) {
      await this.alerts.raise({
        type: 'rapid_clicks',
        severity: 'warning',
        message: `Clics muy rápidos detectados para ${product?.name || link.productId}; requiere revisión.`,
        entityId: clickId,
        entityType: 'event',
      });
    }
    if (product) await this.catalog.products.incrementCounter(product.id, 'clickCount');

    return { destination: link.affiliateUrl, clickId, tracked: true };
  }
}

function safeTrackingId(value) {
  const candidate = String(value || '').trim().slice(0, 80);
  return /^[A-Za-z0-9._:-]{1,80}$/.test(candidate) ? candidate : generateId('visitor');
}

export class AnalyticsReportService {
  constructor({ store, settings, catalog, affiliate }) {
    this.store = store;
    this.settings = settings;
    this.catalog = catalog;
    this.affiliate = affiliate;
  }

  eventsIn(range) {
    const rows = this.store.collection('events');
    if (!range) return rows;
    return rows.filter(event => withinRange(event.timestamp, range));
  }

  /** Clics válidos: los marcados como fraude no cuentan para conversión (M-0750). */
  clicksIn(range, { includeFraud = false } = {}) {
    return this.eventsIn(range).filter(event => event.type === 'affiliate_click' && (includeFraud || !event.fraudFlag));
  }

  viewsIn(range) {
    return this.eventsIn(range).filter(event => event.type === 'product_view');
  }

  conversionsIn(range) {
    const rows = this.store.collection('conversions');
    if (!range) return rows;
    return rows.filter(row => withinRange(row.date || row.createdAt, range));
  }

  commissionsIn(range) {
    const rows = this.store.collection('commissions');
    if (!range) return rows;
    return rows.filter(row => withinRange(row.createdAt, range));
  }

  /**
   * Resumen del panel. Mantiene todas las claves de la v0.1 para no romper la SPA
   * (M-0175) y añade las nuevas.
   */
  summary({ days = null } = {}) {
    const range = days ? lastDaysRange(days) : null;
    const views = this.viewsIn(range);
    const clicks = this.clicksIn(range);
    const allClicks = this.clicksIn(range, { includeFraud: true });
    const conversions = this.conversionsIn(range);
    const commissions = this.commissionsIn(range);
    const products = this.catalog.products.repository.all();

    const sumAmount = rows => rows.reduce((total, row) => total + Number(row.amount ?? row.commission ?? 0), 0);
    const commissionBy = status => sumAmount(commissions.filter(row => (Array.isArray(status) ? status.includes(row.status) : row.status === status)));

    const perf = products.map(product => {
      const productViews = views.filter(event => event.productId === product.id).length;
      const productClicks = clicks.filter(event => event.productId === product.id).length;
      const productConversions = conversions.filter(row => row.productId === product.id);
      const commission = sumAmount(commissions.filter(row => row.productId === product.id));
      return {
        id: product.id,
        name: product.name,
        views: productViews,
        clicks: productClicks,
        ctr: productViews ? round(productClicks / productViews * 100) : 0,
        conversions: productConversions.length,
        conversionRate: productClicks ? round(productConversions.length / productClicks * 100) : 0,
        commission,
        epc: productClicks ? Math.round(commission / productClicks) : 0,
      };
    }).sort((a, b) => b.commission - a.commission);

    const sessions = new Set(this.eventsIn(range).map(event => event.sessionId).filter(Boolean));
    const activeWindow = Date.now() - 1_800_000;

    return {
      // Claves heredadas de la v0.1.
      activeUsers: new Set(
        this.store.collection('events')
          .filter(event => (toDate(event.timestamp)?.getTime() ?? 0) > activeWindow)
          .map(event => event.sessionId),
      ).size,
      sessions: sessions.size,
      productViews: views.length,
      affiliateClicks: clicks.length,
      conversions: conversions.length,
      ctr: views.length ? round(clicks.length / views.length * 100) : 0,
      conversionRate: clicks.length ? round(conversions.length / clicks.length * 100) : 0,
      commissionPending: commissionBy('pending'),
      commissionApproved: commissionBy(['approved', 'confirmed']),
      commissionPaid: commissionBy('paid'),
      // Ventas atribuidas: del comercio, nunca ingreso propio (M-0318).
      salesGenerated: conversions.reduce((total, row) => total + Number(row.saleAmount || 0), 0),
      epc: clicks.length ? Math.round(sumAmount(commissions) / clicks.length) : 0,
      funnel: {
        visits: sessions.size,
        views: views.length,
        clicks: clicks.length,
        conversions: conversions.length,
        approved: conversions.filter(row => ['approved', 'paid'].includes(row.status)).length,
        paid: conversions.filter(row => row.status === 'paid').length,
      },
      productPerformance: perf,
      alerts: this.store.collection('alerts').filter(row => !row.resolved),
      sources: groupCount(this.eventsIn(range), event => event.source || 'direct'),

      // Añadidos de la v0.2.
      range,
      fraudulentClicks: allClicks.length - clicks.length,
      revenueSeparation: {
        note: 'Las ventas atribuidas pertenecen al comercio externo. El ingreso propio proviene solo de comisiones pagadas.',
        attributedSales: conversions.reduce((total, row) => total + Number(row.saleAmount || 0), 0),
        ownIncomeConfirmed: commissionBy('paid'),
        pendingNotIncome: commissionBy('pending') + commissionBy(['approved', 'confirmed']),
      },
    };
  }

  /** Comparación con el período anterior de la misma duración (M-0754). */
  compare({ days = 30 } = {}) {
    const current = lastDaysRange(days);
    const previous = previousRange(current);
    const build = range => {
      const views = this.viewsIn(range);
      const clicks = this.clicksIn(range);
      const conversions = this.conversionsIn(range);
      const commissions = this.commissionsIn(range);
      return {
        range,
        views: views.length,
        clicks: clicks.length,
        conversions: conversions.length,
        ctr: views.length ? round(clicks.length / views.length * 100) : 0,
        conversionRate: clicks.length ? round(conversions.length / clicks.length * 100) : 0,
        commission: commissions.reduce((total, row) => total + Number(row.amount || 0), 0),
        attributedSales: conversions.reduce((total, row) => total + Number(row.saleAmount || 0), 0),
      };
    };
    const currentValues = build(current);
    const previousValues = build(previous);
    const delta = {};
    for (const key of ['views', 'clicks', 'conversions', 'ctr', 'conversionRate', 'commission', 'attributedSales']) {
      const before = previousValues[key];
      delta[key] = before ? round(((currentValues[key] - before) / before) * 100) : null;
    }
    return { current: currentValues, previous: previousValues, deltaPercent: delta };
  }

  /** Serie temporal continua, con los días vacíos incluidos (M-0968). */
  series({ days = 30, granularity = 'day' } = {}) {
    const range = lastDaysRange(days);
    const keys = seriesKeys(range, granularity);
    const grouper = GROUPERS[granularity] || GROUPERS.day;
    const views = this.viewsIn(range);
    const clicks = this.clicksIn(range);
    const conversions = this.conversionsIn(range);
    const commissions = this.commissionsIn(range);

    return keys.map(key => ({
      key,
      views: views.filter(event => grouper(event.timestamp) === key).length,
      clicks: clicks.filter(event => grouper(event.timestamp) === key).length,
      conversions: conversions.filter(row => grouper(row.date || row.createdAt) === key).length,
      commission: commissions
        .filter(row => grouper(row.createdAt) === key)
        .reduce((total, row) => total + Number(row.amount || 0), 0),
      attributedSales: conversions
        .filter(row => grouper(row.date || row.createdAt) === key)
        .reduce((total, row) => total + Number(row.saleAmount || 0), 0),
    }));
  }

  /** Rendimiento por dimensión: comercio, programa, campaña, ubicación o fuente. */
  byDimension(dimension, { days = 30 } = {}) {
    const range = lastDaysRange(days);
    const clicks = this.clicksIn(range);
    const conversions = this.conversionsIn(range);
    const commissions = this.store.collection('commissions');

    const keyOf = {
      merchant: event => event.merchantId,
      program: event => event.programId,
      network: event => event.networkId,
      campaign: event => event.campaignId,
      placement: event => event.placementId,
      source: event => event.source || 'direct',
      device: event => event.device || 'unknown',
      channel: event => event.channelId,
    }[dimension];
    if (!keyOf) return [];

    const buckets = new Map();
    for (const click of clicks) {
      const key = keyOf(click) || 'sin_asignar';
      const bucket = buckets.get(key) || { key, clicks: 0, conversions: 0, commission: 0, attributedSales: 0 };
      bucket.clicks += 1;
      buckets.set(key, bucket);
    }
    for (const conversion of conversions) {
      const click = clicks.find(event => event.clickId === conversion.clickId);
      const key = (click ? keyOf(click) : conversion[`${dimension}Id`]) || 'sin_asignar';
      const bucket = buckets.get(key) || { key, clicks: 0, conversions: 0, commission: 0, attributedSales: 0 };
      bucket.conversions += 1;
      bucket.attributedSales += Number(conversion.saleAmount || 0);
      bucket.commission += commissions
        .filter(row => row.conversionId === conversion.id)
        .reduce((total, row) => total + Number(row.amount || 0), 0);
      buckets.set(key, bucket);
    }

    return [...buckets.values()]
      .map(bucket => ({
        ...bucket,
        label: this.labelFor(dimension, bucket.key),
        conversionRate: bucket.clicks ? round(bucket.conversions / bucket.clicks * 100) : 0,
        epc: bucket.clicks ? Math.round(bucket.commission / bucket.clicks) : 0,
      }))
      .sort((a, b) => b.clicks - a.clicks);
  }

  labelFor(dimension, key) {
    if (key === 'sin_asignar') return 'Sin asignar';
    const collection = {
      merchant: 'merchants', program: 'programs', network: 'networks',
      campaign: 'campaigns', placement: 'placements', channel: 'channels',
    }[dimension];
    if (!collection) return key;
    return this.store.collection(collection).find(row => row.id === key)?.name || key;
  }

  /** Calidad del tráfico por fuente (M-0751). */
  trafficQuality({ days = 30 } = {}) {
    const range = lastDaysRange(days);
    const all = this.clicksIn(range, { includeFraud: true });
    const bySource = new Map();
    for (const click of all) {
      const key = click.source || 'direct';
      const bucket = bySource.get(key) || { source: key, clicks: 0, flagged: 0, sessions: new Set(), bots: 0 };
      bucket.clicks += 1;
      if (click.fraudFlag) bucket.flagged += 1;
      if (click.device === 'bot') bucket.bots += 1;
      if (click.sessionId) bucket.sessions.add(click.sessionId);
      bySource.set(key, bucket);
    }
    return [...bySource.values()]
      .map(bucket => ({
        source: bucket.source,
        clicks: bucket.clicks,
        flagged: bucket.flagged,
        flaggedPercent: round(bucket.flagged / bucket.clicks * 100),
        bots: bucket.bots,
        sessions: bucket.sessions.size,
        clicksPerSession: round(bucket.clicks / Math.max(1, bucket.sessions.size)),
      }))
      .sort((a, b) => b.clicks - a.clicks);
  }

  /** Filas para exportar el rendimiento por producto. */
  exportRows({ days = null } = {}) {
    return this.summary({ days }).productPerformance;
  }
}

function round(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function groupCount(rows, keyOf) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count);
}

export default {
  name: 'analytics',
  requires: ['store', 'events', 'audit', 'config', 'customFields', 'settings', 'catalog', 'affiliate', 'alert', 'analyticsProvider'],
  resources: [eventResource],
  permissions: [
    { resource: 'event', actions: ['read', 'delete'], description: 'Eventos de tracking.' },
    { resource: 'analytics', actions: ['read'], description: 'Informes y métricas.' },
  ],

  register(deps) {
    const tracking = new TrackingService({
      store: deps.store,
      events: deps.events,
      analytics: deps.analyticsProvider,
      settings: deps.settings,
      catalog: deps.catalog,
      affiliate: deps.affiliate,
      alerts: deps.alert,
      config: deps.config,
    });
    const reports = new AnalyticsReportService({
      store: deps.store,
      settings: deps.settings,
      catalog: deps.catalog,
      affiliate: deps.affiliate,
    });
    return { tracking, reports };
  },

  routes: {
    admin: container => {
      const module = () => container.resolve('analytics');
      return [
        {
          method: 'GET',
          path: '/events',
          permission: 'event:read',
          summary: 'Eventos de tracking con filtros.',
          tags: ['analítica'],
          bodyless: true,
          handler: ctx => {
            const limit = Math.min(500, Number(ctx.query.limit) || 100);
            const rows = container.resolve('store').collection('events');
            const filtered = ctx.query.type ? rows.filter(row => row.type === ctx.query.type) : rows;
            return {
              data: filtered.slice(-limit).reverse(),
              count: filtered.length,
              limit,
              offset: 0,
              hasMore: filtered.length > limit,
            };
          },
        },
        {
          method: 'GET',
          path: '/analytics/summary',
          permission: 'analytics:read',
          summary: 'Resumen del panel con las métricas separadas por naturaleza.',
          tags: ['analítica'],
          bodyless: true,
          handler: ctx => module().reports.summary({ days: ctx.query.days ? Number(ctx.query.days) : null }),
        },
        {
          method: 'GET',
          path: '/analytics/compare',
          permission: 'analytics:read',
          summary: 'Comparación con el período anterior de la misma duración.',
          tags: ['analítica'],
          bodyless: true,
          handler: ctx => module().reports.compare({ days: Number(ctx.query.days) || 30 }),
        },
        {
          method: 'GET',
          path: '/analytics/series',
          permission: 'analytics:read',
          summary: 'Serie temporal de vistas, clics, conversiones y comisión.',
          tags: ['analítica'],
          bodyless: true,
          handler: ctx => ({
            data: module().reports.series({
              days: Number(ctx.query.days) || 30,
              granularity: ['day', 'week', 'month'].includes(ctx.query.granularity) ? ctx.query.granularity : 'day',
            }),
          }),
        },
        {
          method: 'GET',
          path: '/analytics/by/:dimension',
          permission: 'analytics:read',
          summary: 'Rendimiento por comercio, programa, red, campaña, ubicación, fuente, dispositivo o canal.',
          tags: ['analítica'],
          bodyless: true,
          handler: ctx => {
            const data = module().reports.byDimension(ctx.params.dimension, { days: Number(ctx.query.days) || 30 });
            return { data, count: data.length };
          },
        },
        {
          method: 'GET',
          path: '/analytics/traffic-quality',
          permission: 'analytics:read',
          summary: 'Calidad del tráfico por fuente, con clics marcados y bots.',
          tags: ['analítica'],
          bodyless: true,
          handler: ctx => ({ data: module().reports.trafficQuality({ days: Number(ctx.query.days) || 30 }) }),
        },
      ];
    },

    store: container => {
      const module = () => container.resolve('analytics');
      return [
        {
          method: 'POST',
          path: '/events/view',
          permission: null,
          csrf: false,
          summary: 'Registra una visualización de producto si hay consentimiento.',
          tags: ['store'],
          status: 201,
          body: {
            productId: rule.id({ required: true }),
            variantId: rule.id(),
            sessionId: rule.text(80),
            source: rule.text(50),
            medium: rule.text(50),
            page: rule.text(200),
            consent: rule.flag(),
            locale: rule.text(10),
          },
          handler: async ctx => {
            const event = await module().tracking.trackView({
              ...ctx.body,
              consent: ctx.body.consent ?? ctx.consent,
              referrer: ctx.referer,
              userAgent: ctx.userAgent,
              channelId: ctx.channelId,
            });
            return { ok: true, tracked: Boolean(event) };
          },
        },
        {
          method: 'POST',
          path: '/events/search',
          permission: null,
          csrf: false,
          summary: 'Registra una búsqueda si hay consentimiento.',
          tags: ['store'],
          status: 201,
          body: {
            term: rule.text(120, { required: true }),
            results: rule.quantity(),
            sessionId: rule.text(80),
            consent: rule.flag(),
          },
          handler: async ctx => {
            const event = await module().tracking.trackSearch({
              ...ctx.body,
              consent: ctx.body.consent ?? ctx.consent,
              channelId: ctx.channelId,
            });
            return { ok: true, tracked: Boolean(event) };
          },
        },
        {
          method: 'POST',
          path: '/events/content-click',
          permission: null,
          csrf: false,
          summary: 'Registra un clic saliente desde una pieza de contenido.',
          tags: ['store'],
          status: 201,
          body: {
            contentId: rule.id({ required: true }),
            productId: rule.id(),
            sessionId: rule.text(80),
            consent: rule.flag(),
          },
          handler: async ctx => {
            const event = await module().tracking.trackContentClick({ ...ctx.body, consent: ctx.body.consent ?? ctx.consent });
            return { ok: true, tracked: Boolean(event) };
          },
        },
      ];
    },
  },
};
