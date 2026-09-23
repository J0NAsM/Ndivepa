/**
 * Publicidad interna (v4).
 *
 * Una tienda paga por visibilidad adicional: producto destacado, tienda
 * destacada, banner o posición promocionada. Tres reglas:
 *
 *  1. **Separado del ranking orgánico.** Los anuncios se sirven en su propia
 *     lista (`/marketplace/sponsored`); la búsqueda y la portada no los mezclan.
 *  2. **Siempre etiquetado.** Todo anuncio sale con `sponsored: true` y
 *     `label: 'Patrocinado'`.
 *  3. **Revisión y cobro antes de servir.** Pendiente -> aprobado -> pagado ->
 *     activo dentro de sus fechas y su presupuesto. El ingreso se registra en el
 *     libro contable como `advertising`, separado de las comisiones.
 */
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule } from '../../framework/validate.js';
import { ConflictError, NotFoundError, ValidationError } from '../../framework/errors.js';
import { isActiveNow } from '../../framework/dates.js';
import { normalizeForSearch } from '../../framework/strings.js';

export const AD_TYPES = ['featured_product', 'featured_store', 'banner', 'promoted_position'];
export const AD_PLACEMENTS = ['home', 'search', 'category', 'store', 'feed'];

export const adCampaignResource = defineResource({
  name: 'adCampaign', collection: 'adCampaigns', prefix: 'adc', route: 'ad-campaigns', searchable: ['title'],
  fields: {
    sellerId: rule.id(),
    type: rule.enumOf(AD_TYPES, { required: true }),
    placement: rule.enumOf(AD_PLACEMENTS, { required: true }),
    productId: rule.id(),
    categoryId: rule.id(),
    keywords: rule.list({ type: 'string', maxLength: 40 }, { default: [], maxItems: 20 }),
    title: rule.text(120, { required: true }),
    body: rule.text(240),
    imageUrl: rule.text(500),
    // Solo rutas internas: un anuncio no puede sacar al usuario a otro sitio.
    linkPath: { type: 'string', maxLength: 300, pattern: /^\/[A-Za-z0-9/_\-?=&.%]*$/, patternMessage: 'Debe ser una ruta interna.' },
    startsAt: rule.date({ required: true }),
    endsAt: rule.date({ required: true }),
    pricingModel: rule.enumOf(['flat', 'cpc', 'cpm'], { default: 'flat' }),
    // `flat`: importe total; `cpc`: por clic; `cpm`: por mil impresiones.
    rate: rule.minor({ required: true, min: 0 }),
    budget: rule.minor({ min: 0 }),
    currencyCode: rule.currency({ default: 'PYG' }),
    spent: rule.minor({ default: 0 }),
    impressions: rule.quantity({ default: 0 }),
    clicks: rule.quantity({ default: 0 }),
    status: rule.enumOf(['pending_review', 'approved', 'rejected', 'paused', 'finished'], { default: 'pending_review' }),
    paymentStatus: rule.enumOf(['unpaid', 'paid', 'waived'], { default: 'unpaid' }),
    paidAmount: rule.minor({ default: 0 }),
    reviewNote: rule.text(300),
    metadata: rule.metadata(),
  },
});

export const adEventResource = defineResource({
  name: 'adEvent', collection: 'adEvents', prefix: 'ade', route: 'ad-events', softDelete: false, searchable: [],
  fields: {
    campaignId: rule.id({ required: true }),
    type: rule.enumOf(['impression', 'click'], { required: true }),
    placement: rule.text(40),
    // Solo con consentimiento de analítica; sin él se cuenta sin identificador.
    sessionId: rule.text(80),
  },
});

export class AdvertisingService {
  constructor(deps) {
    this.store = deps.store;
    this.settings = deps.settings;
    this.catalog = deps.catalog;
    this.channel = deps.channel;
    this.marketplace = deps.marketplace;
    this.campaigns = new BaseService(deps, adCampaignResource);
    this.adEvents = new BaseService(deps, adEventResource);
  }

  /** ¿Puede servirse ahora? Aprobado, cobrado (o exento), en fechas y con presupuesto. */
  isLive(campaign) {
    if (campaign.status !== 'approved') return false;
    if (!['paid', 'waived'].includes(campaign.paymentStatus)) return false;
    if (!isActiveNow(campaign)) return false;
    if (campaign.pricingModel !== 'flat' && campaign.budget && campaign.spent >= campaign.budget) return false;
    if (campaign.productId && !this.marketplace.discovery.isVisible(this.catalog.products.repository.byId(campaign.productId))) return false;
    if (campaign.sellerId && this.channel.sellers.repository.byId(campaign.sellerId)?.status !== 'active') return false;
    return true;
  }

  validateTarget(input, sellerId = null) {
    if (['featured_product', 'promoted_position'].includes(input.type)) {
      if (!input.productId) throw ValidationError.single('productId', 'Indica el producto a destacar.');
      const product = this.catalog.products.repository.byId(input.productId);
      if (!product || (sellerId && product.sellerId !== sellerId)) throw ValidationError.single('productId', 'El producto no pertenece a la tienda.');
    }
    if (input.type === 'banner' && input.imageUrl && !/^\/uploads\//.test(input.imageUrl)) {
      throw ValidationError.single('imageUrl', 'La imagen del banner debe estar subida a la plataforma.');
    }
    if (new Date(input.endsAt) <= new Date(input.startsAt)) throw ValidationError.single('endsAt', 'La fecha de fin debe ser posterior al inicio.');
  }

  /** Solicitud de una tienda: nace pendiente de revisión y sin cobrar. */
  async request(sellerId, input, ctx) {
    this.validateTarget(input, sellerId);
    return this.campaigns.create({
      ...input, sellerId, status: 'pending_review', paymentStatus: 'unpaid', spent: 0, impressions: 0, clicks: 0,
      currencyCode: this.settings.get('marketplace.currencyCode', 'PYG'),
    }, ctx);
  }

  async review(campaignId, { decision, note = null }, ctx) {
    const campaign = this.campaigns.repository.retrieve(campaignId);
    if (campaign.status !== 'pending_review') throw new ConflictError('La campaña ya fue revisada.');
    const updated = await this.campaigns.update(campaignId, { status: decision === 'approve' ? 'approved' : 'rejected', reviewNote: note }, ctx);
    const seller = campaign.sellerId ? this.channel.sellers.repository.byId(campaign.sellerId) : null;
    if (seller) {
      await this.marketplace.accounts.notifyOwners(seller, {
        type: 'ad_reviewed', title: `Tu anuncio «${campaign.title}» fue ${decision === 'approve' ? 'aprobado' : 'rechazado'}`,
        body: note, link: `/mi-tienda/${seller.id}/publicidad`,
      });
    }
    return updated;
  }

  /** Cobro del anuncio: ingreso de publicidad en el libro contable. */
  async recordPayment(campaignId, { amount, reference = null, waive = false }, ctx) {
    const campaign = this.campaigns.repository.retrieve(campaignId);
    if (waive) return this.campaigns.update(campaignId, { paymentStatus: 'waived' }, ctx);
    if (!(amount > 0)) throw ValidationError.single('amount', 'Indica el importe cobrado.');
    await this.marketplace.finance.recordRevenue({
      type: 'advertising', amount, currencyCode: campaign.currencyCode, sellerId: campaign.sellerId || null,
      campaignId: campaign.id, reference: reference || `AD-${campaign.id}`, note: campaign.title,
    });
    return this.campaigns.update(campaignId, { paymentStatus: 'paid', paidAmount: (campaign.paidAmount || 0) + amount }, ctx);
  }

  /**
   * Anuncios para un contexto. Nunca se mezclan con los resultados orgánicos: la
   * interfaz los muestra en su bloque, etiquetados.
   */
  serve({ placement, q = null, category = null, sellerId = null, limit = 3 }) {
    const needle = q ? normalizeForSearch(q) : null;
    const categoryIds = category ? new Set(this.marketplace.discovery.categorySubtree(category) || []) : null;
    const eligible = this.campaigns.repository.all().filter(campaign => campaign.placement === placement && this.isLive(campaign))
      .filter(campaign => placement !== 'search' || !campaign.keywords?.length || (needle && campaign.keywords.some(keyword => needle.includes(normalizeForSearch(keyword)))))
      .filter(campaign => placement !== 'category' || !campaign.categoryId || categoryIds?.has(campaign.categoryId))
      .filter(campaign => placement !== 'store' || !sellerId || campaign.sellerId === sellerId)
      // Rotación determinística: mayor tarifa primero y, a igualdad, el menos mostrado.
      .sort((a, b) => b.rate - a.rate || a.impressions - b.impressions)
      .slice(0, limit);
    return eligible.map(campaign => this.view(campaign));
  }

  view(campaign) {
    const product = campaign.productId ? this.catalog.products.repository.byId(campaign.productId) : null;
    const seller = campaign.sellerId ? this.channel.sellers.repository.byId(campaign.sellerId) : null;
    return {
      id: campaign.id,
      sponsored: true,
      label: 'Patrocinado',
      type: campaign.type,
      placement: campaign.placement,
      title: campaign.title,
      body: campaign.body || null,
      imageUrl: campaign.imageUrl || null,
      linkPath: campaign.linkPath || (product ? `/producto/${product.handle}` : seller ? `/tienda/${seller.code}` : '/'),
      product: product ? this.marketplace.discovery.card(product) : null,
      store: seller && campaign.type === 'featured_store' ? this.marketplace.discovery.storeCard(seller) : null,
    };
  }

  /** Impresiones y clics. El gasto por CPC/CPM se acumula; el cobro lo registra administración. */
  async track(type, campaignIds, { placement = null, sessionId = null, consent = false } = {}) {
    const ids = [...new Set(campaignIds)].slice(0, 12);
    const campaigns = ids.map(id => this.campaigns.repository.byId(id)).filter(campaign => campaign && this.isLive(campaign));
    if (!campaigns.length) return { tracked: 0 };
    await this.store.transaction(state => {
      for (const campaign of campaigns) {
        const row = this.campaigns.repository.raw(state).find(item => item.id === campaign.id);
        if (!row) continue;
        if (type === 'impression') {
          row.impressions = (row.impressions || 0) + 1;
          if (row.pricingModel === 'cpm') row.spent = Math.round(((row.impressions) / 1000) * row.rate);
        } else {
          row.clicks = (row.clicks || 0) + 1;
          if (row.pricingModel === 'cpc') row.spent = (row.spent || 0) + row.rate;
        }
        this.adEvents.repository.insert(state, { campaignId: row.id, type, placement, sessionId: consent ? sessionId : null });
      }
    });
    return { tracked: campaigns.length };
  }

  report(campaign) {
    return {
      ...campaign,
      live: this.isLive(campaign),
      ctr: campaign.impressions ? Math.round((campaign.clicks / campaign.impressions) * 1000) / 10 : null,
    };
  }
}

const REQUEST_BODY = {
  type: rule.enumOf(AD_TYPES, { required: true }),
  placement: rule.enumOf(AD_PLACEMENTS, { required: true }),
  productId: rule.id(),
  categoryId: rule.id(),
  keywords: rule.list({ type: 'string', maxLength: 40 }, { maxItems: 20 }),
  title: rule.text(120, { required: true }),
  body: rule.text(240),
  imageUrl: rule.text(500),
  linkPath: { type: 'string', maxLength: 300, pattern: /^\/[A-Za-z0-9/_\-?=&.%]*$/, patternMessage: 'Debe ser una ruta interna.' },
  startsAt: rule.date({ required: true }),
  endsAt: rule.date({ required: true }),
  pricingModel: rule.enumOf(['flat', 'cpc', 'cpm'], { default: 'flat' }),
  rate: rule.minor({ required: true, min: 0 }),
  budget: rule.minor({ min: 0 }),
};

export default {
  name: 'advertising',
  requires: ['store', 'events', 'audit', 'config', 'customFields', 'settings', 'catalog', 'channel', 'marketplace'],
  resources: [adCampaignResource, adEventResource],
  permissions: [
    { resource: 'adCampaign', description: 'Campañas de publicidad interna.' },
    { resource: 'adEvent', actions: ['read'], description: 'Impresiones y clics de anuncios.' },
  ],

  register(deps) {
    return new AdvertisingService(deps);
  },

  jobs: container => [
    {
      name: 'advertising.finish-expired',
      everyMs: 60 * 60_000,
      handler: async () => {
        const service = container.resolve('advertising');
        const expired = service.campaigns.repository.all({ status: 'approved' }).filter(row => new Date(row.endsAt).getTime() < Date.now());
        for (const row of expired) await service.campaigns.update(row.id, { status: 'finished' });
        return { finished: expired.length };
      },
    },
  ],

  routes: {
    store: container => {
      const service = () => container.resolve('advertising');
      const member = ctx => container.resolve('marketplace').accounts.requireMember(ctx, ctx.params.sellerId);
      const tags = ['publicidad'];
      return [
        {
          method: 'GET', path: '/marketplace/sponsored', permission: null, bodyless: true, tags,
          query: { placement: rule.enumOf(AD_PLACEMENTS, { required: true }), q: rule.text(120), category: rule.text(120), seller: rule.id(), limit: { type: 'integer', coerce: true, min: 1, max: 6 } },
          summary: 'Anuncios vigentes para una ubicación, siempre separados del ranking orgánico.',
          handler: ctx => {
            const data = service().serve({ placement: ctx.query.placement, q: ctx.query.q, category: ctx.query.category, sellerId: ctx.query.seller, limit: ctx.query.limit || 3 });
            return { data, count: data.length };
          },
        },
        {
          method: 'POST', path: '/marketplace/sponsored/events', permission: null, csrf: false, tags,
          body: {
            type: rule.enumOf(['impression', 'click'], { required: true }), campaignIds: rule.list({ type: 'string' }, { required: true, maxItems: 12 }),
            placement: rule.text(40), sessionId: rule.text(80), consent: rule.flag({ default: false }),
          },
          summary: 'Registra impresiones o clics de anuncios.',
          handler: ctx => service().track(ctx.body.type, ctx.body.campaignIds, ctx.body),
        },
        {
          method: 'GET', path: '/marketplace/seller/stores/:sellerId/ads', permission: null, bodyless: true, tags,
          summary: 'Anuncios de la tienda con su rendimiento.',
          handler: ctx => {
            const { seller } = member(ctx);
            const data = service().campaigns.repository.all({ sellerId: seller.id }).map(row => service().report(row));
            return { data, count: data.length };
          },
        },
        {
          method: 'POST', path: '/marketplace/seller/stores/:sellerId/ads', permission: null, status: 201, tags, body: REQUEST_BODY,
          summary: 'La tienda solicita un anuncio (queda pendiente de revisión y cobro).',
          handler: ctx => {
            const { seller, actorCtx } = member(ctx);
            if (seller.status !== 'active') throw new ConflictError('La tienda debe estar aprobada para anunciar.');
            return service().request(seller.id, ctx.body, actorCtx);
          },
        },
        {
          method: 'POST', path: '/marketplace/seller/stores/:sellerId/ads/:id/pause', permission: null, tags,
          body: { paused: rule.flag({ required: true }) },
          summary: 'La tienda pausa o reanuda su anuncio aprobado.',
          handler: ctx => {
            const { seller, actorCtx } = member(ctx);
            const campaign = service().campaigns.repository.byId(ctx.params.id);
            if (!campaign || campaign.sellerId !== seller.id) throw new NotFoundError('anuncio', ctx.params.id);
            if (!['approved', 'paused'].includes(campaign.status)) throw new ConflictError('Solo se pausa un anuncio aprobado.');
            return service().campaigns.update(campaign.id, { status: ctx.body.paused ? 'paused' : 'approved' }, actorCtx);
          },
        },
      ];
    },

    admin: container => {
      const service = () => container.resolve('advertising');
      const tags = ['publicidad'];
      return [
        ...crudRoutes(adCampaignResource, () => service().campaigns, { tags }),
        {
          method: 'POST', path: '/ad-campaigns/:id/review', permission: 'adCampaign:update', tags,
          body: { decision: rule.enumOf(['approve', 'reject'], { required: true }), note: rule.text(300) },
          summary: 'Aprueba o rechaza un anuncio.',
          handler: ctx => service().review(ctx.params.id, ctx.body, ctx),
        },
        {
          method: 'POST', path: '/ad-campaigns/:id/payment', permission: 'adCampaign:update', tags,
          body: { amount: rule.minor({ min: 0 }), reference: rule.text(120), waive: rule.flag({ default: false }) },
          summary: 'Registra el cobro del anuncio (ingreso de publicidad) o lo exime.',
          handler: ctx => service().recordPayment(ctx.params.id, ctx.body, ctx),
        },
        {
          method: 'GET', path: '/advertising/report', permission: 'adCampaign:read', bodyless: true, tags,
          summary: 'Rendimiento de todos los anuncios.',
          handler: () => {
            const data = service().campaigns.repository.all().map(row => service().report(row));
            return { data, count: data.length };
          },
        },
      ];
    },
  },
};

