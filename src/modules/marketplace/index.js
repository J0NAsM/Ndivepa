/**
 * Marketplace multivendedor (v4).
 *
 * Integra en un único ecosistema productos locales, propios, de dropshipping y
 * afiliados sobre los módulos existentes. El comprador ve un solo marketplace;
 * internamente cada línea conserva su modelo comercial y su responsable.
 *
 * Superficies:
 *   /api/v1/store/marketplace/...          público y comprador
 *   /api/v1/store/marketplace/seller/...   panel de la tienda (cliente miembro)
 *   /api/v1/admin/marketplace/...          administración (RBAC)
 */
import { BaseService, crudRoutes } from '../base.js';
import { rule } from '../../framework/validate.js';
import { ConflictError, NotFoundError, ValidationError } from '../../framework/errors.js';
import { humanCode } from '../../framework/ids.js';
import * as respond from '../../framework/http/respond.js';
import { csvRow } from '../../framework/strings.js';
import { now } from '../../framework/dates.js';
import { COMMERCIAL_MODELS } from '../catalog/index.js';
import {
  commissionRuleResource, DELIVERY_MODE_LABELS, ledgerEntryResource, localityResource, searchSynonymResource, sellerApplicationResource,
  sellerMemberResource, sellerPayoutResource, sellerPlanResource, stockAlertResource, vendorOrderResource, VENDOR_STATUS_LABELS,
  VENDOR_STATUSES, SELLER_STATUS_LABELS,
} from './models.js';
import { InboxService, inboxResource, SellerAccountService, StockAlertService } from './sellers.js';
import { ListingService, LISTING_INPUT } from './listings.js';
import { CommissionResolver } from './commissions.js';
import { FinanceService, VendorOrderService } from './orders.js';
import { DiscoveryService } from './discovery.js';
import { CartShippingService, DeliveryEstimateService } from './shipping.js';
import { defaultAdapters } from './adapters.js';

export const SEARCH_QUERY = {
  q: rule.text(120),
  category: rule.text(120),
  seller: rule.text(120),
  locality: rule.id(),
  area: rule.text(120),
  minPrice: rule.minor({ min: 0 }),
  maxPrice: rule.minor({ min: 0 }),
  delivery: rule.text(120),
  model: rule.text(80),
  inStock: rule.flag(),
  onSale: rule.flag(),
  minRating: { type: 'number', coerce: true, min: 1, max: 5 },
  sort: rule.enumOf(['relevance', 'newest', 'price_asc', 'price_desc', 'popularity', 'rating', 'name']),
  limit: { type: 'integer', coerce: true, min: 1, max: 48 },
  offset: { type: 'integer', coerce: true, min: 0, max: 10_000 },
  consent: rule.flag(),
  sid: rule.text(80),
};

/**
 * Localidades iniciales. Carapeguá opera; el resto aparece como «próximamente».
 * Crecer a otra ciudad es cambiar `launchStatus` a `active`, no tocar código.
 */
const SEED_LOCALITIES = [
  { id: 'loc_py', code: 'paraguay', name: 'Paraguay', type: 'country', countryCode: 'py', launchStatus: 'active', rank: 1 },
  { id: 'loc_dep_paraguari', code: 'departamento-paraguari', name: 'Paraguarí', type: 'department', parentId: 'loc_py', countryCode: 'py', launchStatus: 'active', rank: 10 },
  { id: 'loc_dep_central', code: 'departamento-central', name: 'Central', type: 'department', parentId: 'loc_py', countryCode: 'py', launchStatus: 'coming_soon', rank: 20 },
  {
    id: 'loc_carapegua', code: 'carapegua', name: 'Carapeguá', type: 'city', parentId: 'loc_dep_paraguari', countryCode: 'py', launchStatus: 'active', rank: 10,
    description: 'Comercios, emprendedores y artesanos de Carapeguá.',
    // Zonas genéricas: la administración las reemplaza por las reales.
    areas: ['Centro', 'Zona urbana', 'Zona rural'],
    center: { lat: -25.7667, lng: -57.2333 },
    bounds: { north: -25.70, south: -25.84, east: -57.15, west: -57.32 },
  },
  { id: 'loc_paraguari', code: 'paraguari', name: 'Paraguarí', type: 'city', parentId: 'loc_dep_paraguari', countryCode: 'py', launchStatus: 'coming_soon', rank: 20 },
  { id: 'loc_quiindy', code: 'quiindy', name: 'Quiindy', type: 'city', parentId: 'loc_dep_paraguari', countryCode: 'py', launchStatus: 'coming_soon', rank: 30 },
  { id: 'loc_yaguaron', code: 'yaguaron', name: 'Yaguarón', type: 'city', parentId: 'loc_dep_paraguari', countryCode: 'py', launchStatus: 'coming_soon', rank: 40 },
];

/** Árbol de categorías del marketplace. Se reutiliza la categoría si el `handle` ya existe. */
const SEED_CATEGORY_TREE = [
  { handle: 'artesania', name: 'Artesanía', rank: 10, description: 'Piezas hechas a mano por artesanos locales.' },
  { handle: 'poyvi', name: 'Poyvi', rank: 20, description: 'Tejidos de poyvi: hamacas, mantas y más.' },
  {
    handle: 'hogar', name: 'Hogar', rank: 30, children: [
      { handle: 'decoracion', name: 'Decoración', rank: 10 },
      { handle: 'textiles', name: 'Textiles', rank: 20 },
      { handle: 'cocina', name: 'Cocina', rank: 30 },
    ],
  },
  {
    handle: 'moda', name: 'Moda', rank: 40, children: [
      { handle: 'ropa', name: 'Ropa', rank: 10 },
      { handle: 'calzados', name: 'Calzados', rank: 20 },
      { handle: 'accesorios', name: 'Accesorios', rank: 30 },
    ],
  },
  { handle: 'tecnologia', name: 'Tecnología', rank: 50 },
  { handle: 'gastronomia', name: 'Gastronomía', rank: 60 },
  { handle: 'deportes', name: 'Deportes', rank: 70 },
  { handle: 'belleza', name: 'Belleza', rank: 80 },
  { handle: 'servicios', name: 'Servicios', rank: 90 },
];

const SEARCH_SYNONYMS = [
  ['hamaca', ['hamacas', 'amaca']],
  ['poyvi', ['poyví']],
  ['artesania', ['artesanal', 'artesano', 'hecho a mano']],
  ['aopoi', ['ao poi', "ao po'i"]],
  ['remera', ['camiseta', 'polera']],
  ['celular', ['telefono', 'movil', 'smartphone']],
  ['notebook', ['laptop', 'portatil']],
  ['zapatilla', ['calzado', 'tenis']],
  ['torta', ['pastel', 'tarta']],
];

/**
 * Carga en el índice los sinónimos vigentes de la tabla. Se llama al arrancar y
 * cada vez que alguien los edita desde el panel: un término nuevo funciona sin
 * reiniciar y sin tocar código.
 */
function loadSynonyms(container) {
  const search = container.resolve('search');
  search.clearSynonyms();
  let count = 0;
  for (const row of container.resolve('store').collection('searchSynonyms')) {
    if (row.deletedAt || row.active === false || !row.term) continue;
    search.addSynonyms(row.term, row.equivalents || []);
    count += 1;
  }
  return count;
}

async function seedCategories(catalog) {
  const ensure = async (spec, parentId = null) => {
    let category = catalog.categories.repository.find({ handle: spec.handle });
    if (!category) {
      category = await catalog.categories.create({
        name: spec.name, handle: spec.handle, parentId, rank: spec.rank, description: spec.description || undefined, visible: true,
      });
    }
    for (const child of spec.children || []) await ensure(child, category.id);
  };
  for (const spec of SEED_CATEGORY_TREE) await ensure(spec);
}

export default {
  name: 'marketplace',
  requires: [
    'store', 'events', 'audit', 'config', 'customFields', 'settings', 'catalog', 'pricing', 'inventory',
    'channel', 'customer', 'order', 'cart', 'fulfillment', 'payment', 'promotion', 'affiliate', 'analytics', 'alert',
    'notifications', 'search', 'cache', 'files', 'logger',
  ],
  resources: [
    localityResource, sellerMemberResource, sellerApplicationResource, sellerPlanResource, commissionRuleResource,
    vendorOrderResource, ledgerEntryResource, sellerPayoutResource, inboxResource, searchSynonymResource,
    stockAlertResource,
  ],
  permissions: [
    { resource: 'marketplace', actions: ['read', 'manage'], description: 'Panel y analítica del marketplace.' },
    { resource: 'locality', description: 'Localidades y expansión geográfica.' },
    { resource: 'sellerMember', description: 'Miembros de tiendas.' },
    { resource: 'sellerApplication', description: 'Solicitudes de alta de vendedores.' },
    { resource: 'sellerPlan', description: 'Planes de suscripción de tiendas.' },
    { resource: 'commissionRule', description: 'Reglas de comisión.' },
    { resource: 'searchSynonym', description: 'Sinónimos de búsqueda.' },
    { resource: 'stockAlert', description: 'Avisos de reposición pedidos por compradores.' },
    { resource: 'vendorOrder', description: 'Subpedidos por vendedor.' },
    { resource: 'ledgerEntry', actions: ['read'], description: 'Libro contable del marketplace.' },
    { resource: 'sellerPayout', description: 'Liquidaciones a tiendas.' },
    { resource: 'inboxNotification', actions: ['read', 'update'], description: 'Bandeja de avisos de administración.' },
  ],

  register(deps) {
    const inbox = new InboxService(deps);
    const members = new BaseService(deps, sellerMemberResource);
    const applications = new BaseService(deps, sellerApplicationResource);
    const localities = new BaseService(deps, localityResource);
    const plans = new BaseService(deps, sellerPlanResource);
    const rules = new BaseService(deps, commissionRuleResource);
    const synonyms = new BaseService(deps, searchSynonymResource);
    const stockAlerts = new StockAlertService(deps);
    const vendorOrdersBase = new BaseService(deps, vendorOrderResource);
    const ledger = new BaseService(deps, ledgerEntryResource);
    const payouts = new BaseService(deps, sellerPayoutResource);
    const accounts = new SellerAccountService({ ...deps, inbox, members, applications });
    const listings = new ListingService({ ...deps, accounts });
    const commissions = new CommissionResolver({ rules, store: deps.store });
    const finance = new FinanceService({ store: deps.store, settings: deps.settings, ledger, payouts, events: deps.events });
    const vendorOrders = new VendorOrderService({
      ...deps, accounts, vendorOrders: vendorOrdersBase, finance, commissions, inbox,
    });
    const deliveryEstimates = new DeliveryEstimateService({
      fulfillment: deps.fulfillment, channel: deps.channel, catalog: deps.catalog, store: deps.store, settings: deps.settings,
    });
    const discovery = new DiscoveryService({ ...deps, deliveryEstimates });
    const cartShipping = new CartShippingService({
      cart: deps.cart, fulfillment: deps.fulfillment, channel: deps.channel, customer: deps.customer,
      catalog: deps.catalog, vendorOrders, store: deps.store,
    });
    const adapters = defaultAdapters({ env: process.env });
    return {
      inbox, members, applications, localities, plans, rules, synonyms, ledger, payouts, accounts, listings, commissions,
      finance, vendorOrders, vendorOrdersBase, discovery, cartShipping, deliveryEstimates, stockAlerts, adapters,
    };
  },

  /** El índice de búsqueda del catálogo aprende los datos del marketplace. */
  boot({ service, container }) {
    const catalog = container.resolve('catalog');
    catalog.products.addSearchEnricher((document, product) => service.discovery.enrichSearchDocument(document, product));
    service.loadSynonyms = () => loadSynonyms(container);
    service.loadSynonyms();
  },

  async seed(service, container) {
    const catalog = container.resolve('catalog');
    await service.localities.seed(SEED_LOCALITIES, 'id');
    await seedCategories(catalog);
    await service.rules.seed([{
      id: 'crule_global', name: 'Comisión general de la plataforma', scope: 'global', scopeValue: null,
      percent: 10, flat: 0, currencyCode: 'PYG', priority: 100, active: true,
      notes: 'Valor inicial editable desde el panel. No hay porcentajes fijos en el código.',
    }], 'id');
    await service.synonyms.seed(SEARCH_SYNONYMS.map(([term, equivalents]) => ({
      id: `syn_${term}`, term, equivalents, active: true, notes: 'Sinónimo inicial; se puede editar o desactivar.',
    })), 'term');
    await service.plans.seed([{
      id: 'splan_inicial', code: 'inicial', name: 'Inicial', description: 'Plan de entrada sin cuota mensual.',
      monthlyFee: 0, currencyCode: 'PYG', features: ['Tienda propia', 'Productos ilimitados', 'Panel de ventas'], active: true, rank: 10,
    }], 'id');
    loadSynonyms(container);
    const settings = container.resolve('settings').settings;
    if (!settings.get('marketplace.defaultLocalityId', null)) {
      await settings.update({ marketplace: { defaultLocalityId: 'loc_carapegua' } });
    }
  },

  subscribers: container => {
    const service = () => container.resolve('marketplace');
    const searchOn = () => container.resolve('config').features.search;
    // Invalidar es barato; reindexar todo el catálogo no. Cada evento vuelve a
    // indexar solo lo que cambió de verdad.
    const refresh = () => service().discovery.invalidate();
    const reindexSeller = sellerId => {
      refresh();
      if (searchOn() && sellerId) container.resolve('catalog').products.indexSeller(sellerId);
    };
    const reindexProduct = productId => {
      refresh();
      if (searchOn() && productId) container.resolve('catalog').products.indexProductId(productId);
    };
    return [
      { event: 'order.confirmed', handler: payload => service().vendorOrders.createForOrder(payload.id) },
      { event: 'payment.captured', handler: payload => (payload.orderId ? service().vendorOrders.syncPayment(payload.orderId) : null) },
      {
        event: 'order.cancelled',
        handler: async payload => {
          for (const vendorOrder of service().vendorOrders.forOrder(payload.id)) {
            if (['created', 'payment_pending', 'paid', 'preparing', 'ready_to_ship'].includes(vendorOrder.status)) {
              await service().vendorOrders.transition(vendorOrder.id, 'cancelled', { actorType: 'system', note: 'Pedido principal cancelado' });
            }
          }
        },
      },
      { event: 'marketplace.seller.*', handler: ({ sellerId }) => reindexSeller(sellerId) },
      { event: 'seller.updated', handler: ({ id }) => reindexSeller(id) },
      // Una venta entregada cambia unidades vendidas y reputación de esas fichas.
      {
        event: 'vendorOrder.delivered',
        handler: ({ record }) => {
          refresh();
          for (const item of record?.items || []) reindexProduct(item.productId);
        },
      },
      { event: 'review.*', handler: ({ record, before }) => reindexProduct(record?.productId || before?.productId) },
      { event: 'favorite.*', handler: refresh },
      { event: 'follow.*', handler: refresh },
      { event: 'question.*', handler: refresh },
      { event: 'post.*', handler: refresh },
      {
        event: 'inventory.adjusted',
        handler: async ({ inventoryItemId }) => {
          refresh();
          if (!inventoryItemId) return;
          const catalog = container.resolve('catalog');
          const sku = container.resolve('inventory').items.repository.byId(inventoryItemId)?.sku;
          const variant = sku ? catalog.variants.repository.find({ sku }) : null;
          if (!variant) return;
          if (searchOn()) catalog.products.indexProductId(variant.productId);
          // Si volvió el stock, avisar a quien lo estaba esperando.
          await service().stockAlerts.notifyRestocked([variant.id]);
        },
      },
      { event: 'inventory.consumed', handler: refresh },
      // Devolución solicitada: la tienda se entera por su bandeja.
      {
        event: 'return.created',
        handler: async ({ record }) => {
          for (const vendorOrder of service().vendorOrders.forOrder(record.orderId)) {
            const mine = (record.items || []).some(item => (vendorOrder.items || []).some(line => line.lineItemId === item.lineItemId));
            if (!mine || !vendorOrder.sellerId) continue;
            const seller = container.resolve('channel').sellers.repository.byId(vendorOrder.sellerId);
            if (seller) {
              await service().accounts.notifyOwners(seller, {
                type: 'return_requested',
                title: `Devolución solicitada en ${vendorOrder.code}`,
                body: record.note || null,
                link: `/mi-tienda/${seller.id}/devoluciones`,
                data: { returnId: record.id, vendorOrderId: vendorOrder.id },
              });
            }
          }
        },
      },
      // Devolución recibida: el subpedido totalmente devuelto revierte su contabilidad.
      {
        event: 'return.received',
        handler: async ({ record }) => {
          refresh();
          const returnedByLine = new Map((record.items || []).map(item => [item.lineItemId, item.receivedQuantity ?? item.quantity]));
          for (const vendorOrder of service().vendorOrders.forOrder(record.orderId)) {
            const lines = vendorOrder.items || [];
            const touched = lines.some(line => returnedByLine.has(line.lineItemId));
            if (!touched || vendorOrder.status !== 'delivered') continue;
            const order = container.resolve('order').orders.repository.byId(vendorOrder.orderId);
            const fullyReturned = lines.every(line => {
              const orderLine = (order?.items || []).find(entry => entry.id === line.lineItemId);
              return Number(orderLine?.returnedQuantity || 0) >= line.quantity;
            });
            if (fullyReturned) {
              await service().vendorOrders.transition(vendorOrder.id, 'returned', { actorType: 'system', note: `Devolución ${record.id} recibida` });
            }
          }
        },
      },
      { event: 'promotion.*', handler: refresh },
      { event: 'searchSynonym.*', handler: () => service().loadSynonyms() },
    ];
  },

  routes: {
    store: container => storeRoutes(container),
    admin: container => adminRoutes(container),
  },
};

// ---------------------------------------------------------------------------
// Rutas públicas, de comprador y de tienda
// ---------------------------------------------------------------------------

function storeRoutes(container) {
  const mp = () => container.resolve('marketplace');
  const customers = () => container.resolve('customer').customers;
  const currentCustomer = ctx => customers().customerFromRequest(ctx);
  const tags = ['marketplace'];
  const sellerTags = ['marketplace', 'tienda'];
  const member = (ctx, roles) => mp().accounts.requireMember(ctx, ctx.params.sellerId, roles ? { roles } : undefined);
  // Lectura pública con ETag: el navegador revalida y recibe 304 en vez del cuerpo.
  const cacheable = (ctx, data, maxAge = 60) => respond.cacheable(ctx.req, ctx.res, data, { maxAge });

  return [
    {
      method: 'GET', path: '/marketplace/config', permission: null, bodyless: true, tags,
      summary: 'Configuración pública del marketplace: nombre, moneda, localidad y modelos comerciales.',
      handler: ctx => {
        const settings = container.resolve('settings').settings;
        return {
          ...settings.publicView(),
          marketplace: {
            name: settings.get('marketplace.name'),
            tagline: settings.get('marketplace.tagline'),
            currencyCode: settings.get('marketplace.currencyCode', 'PYG'),
            defaultLocalityId: settings.get('marketplace.defaultLocalityId', null),
            reviewsRequirePurchase: settings.get('marketplace.reviewsRequirePurchase', true),
            sellerTermsVersion: settings.get('marketplace.sellerTermsVersion'),
          },
          commercialModels: Object.fromEntries(Object.entries(COMMERCIAL_MODELS).map(([code, model]) => [code, { label: model.label, cta: model.cta }])),
          // Lo que el comprador necesita saber antes de decidir: cómo puede pagar,
          // cuántos días tiene para devolver y con quién hablar. Todo sale de la
          // configuración real, no de un texto fijo en la interfaz.
          trust: {
            paymentMethods: container.resolve('payment').service
              .eligibleMethods({ currencyCode: settings.get('marketplace.currencyCode', 'PYG') })
              .filter(method => !method.requiresCredentials)
              .map(method => ({ code: method.code, name: method.name, description: method.description || null })),
            returnWindowDays: settings.get('order.returnWindowDays', 30),
            reviewsRequirePurchase: settings.get('marketplace.reviewsRequirePurchase', true),
            storedCardData: false,
            contactEmail: settings.get('contactEmail', '') || null,
            contactPhone: settings.get('contactPhone', '') || null,
          },
          deliveryModes: DELIVERY_MODE_LABELS,
          vendorStatuses: VENDOR_STATUS_LABELS,
          sellerStatuses: SELLER_STATUS_LABELS,
        };
      },
    },
    {
      method: 'GET', path: '/marketplace/home', permission: null, bodyless: true, tags,
      query: { locality: rule.id() },
      summary: 'Portada: categorías, ofertas, populares, tiendas, nuevas tiendas, artesanía y recomendados.',
      handler: ctx => cacheable(ctx, mp().discovery.home({ locality: ctx.query.locality || null }), 60),
    },
    {
      method: 'GET', path: '/marketplace/search', permission: null, bodyless: true, tags, query: SEARCH_QUERY,
      summary: 'Búsqueda tolerante a errores con filtros de categoría, zona, entrega, precio y disponibilidad.',
      handler: async ctx => {
        const result = mp().discovery.search(ctx.query);
        // Analítica de búsqueda solo con consentimiento explícito.
        if (ctx.query.q && ctx.query.consent) {
          await container.resolve('analytics').tracking.trackSearch({
            term: String(ctx.query.q).slice(0, 120), results: result.count, sessionId: ctx.query.sid || null, consent: true, channelId: ctx.channelId || null,
          }).catch(() => {});
        }
        return result;
      },
    },
    {
      method: 'GET', path: '/marketplace/suggest', permission: null, bodyless: true, tags, query: { q: rule.text(80) },
      summary: 'Autocompletado de productos, tiendas y categorías.',
      handler: ctx => mp().discovery.suggest(ctx.query.q),
    },
    {
      method: 'GET', path: '/marketplace/categories', permission: null, bodyless: true, tags,
      summary: 'Árbol de categorías con recuento de productos visibles.',
      handler: ctx => cacheable(ctx, { tree: mp().discovery.categoryTree() }, 120),
    },
    {
      method: 'GET', path: '/marketplace/offers', permission: null, bodyless: true, tags,
      summary: 'Productos con precio rebajado.',
      handler: ctx => cacheable(ctx, mp().discovery.offers(), 60),
    },
    {
      method: 'GET', path: '/marketplace/products/:handle', permission: null, bodyless: true, tags,
      query: { locality: rule.id() },
      summary: 'Ficha pública completa: galería, variantes, tienda, reputación, reseñas, preguntas y entrega estimada.',
      handler: ctx => cacheable(ctx, mp().discovery.detail(ctx.params.handle, { locality: ctx.query.locality || null }), 30),
    },
    {
      method: 'GET', path: '/marketplace/products/:handle/recommendations', permission: null, bodyless: true, tags,
      summary: 'Similares, de la misma tienda, relacionados y populares (reglas determinísticas).',
      handler: ctx => mp().discovery.recommendations(ctx.params.handle),
    },
    {
      method: 'POST', path: '/marketplace/stock-alerts', permission: null, status: 201, tags,
      body: { productId: rule.id({ required: true }), variantId: rule.id(), email: rule.email() },
      summary: 'Avisar a esta persona cuando el producto vuelva a tener stock.',
      handler: async ctx => {
        const customer = currentCustomer(ctx);
        const email = ctx.body.email || customer?.email;
        if (!email) throw new ValidationError([{ field: 'email', message: 'Dejanos un correo para avisarte.' }]);
        return mp().stockAlerts.request({ ...ctx.body, email, customerId: customer?.id || null }, ctx);
      },
    },
    {
      method: 'POST', path: '/marketplace/products/cards', permission: null, csrf: false, tags,
      body: { ids: rule.list({ type: 'string', maxLength: 80 }, { required: true, maxItems: 48 }) },
      summary: 'Tarjetas de una lista de productos (vistos recientemente, favoritos sin cuenta).',
      handler: ctx => {
        const data = mp().discovery.cardsFor(ctx.body.ids);
        return { data, count: data.length };
      },
    },
    {
      method: 'GET', path: '/marketplace/compare', permission: null, bodyless: true, tags, query: { ids: rule.text(400, { required: true }) },
      summary: 'Comparador de hasta cuatro productos.',
      handler: ctx => mp().discovery.compare(String(ctx.query.ids).split(',').map(id => id.trim()).filter(Boolean)),
    },
    {
      method: 'GET', path: '/marketplace/stores', permission: null, bodyless: true, tags,
      query: { locality: rule.id(), type: rule.text(40), category: rule.id(), q: rule.text(80), sort: rule.enumOf(['relevance', 'newest', 'rating', 'name']) },
      summary: 'Tiendas aprobadas con filtros.',
      handler: ctx => mp().discovery.stores(ctx.query),
    },
    {
      method: 'GET', path: '/marketplace/stores/:code', permission: null, bodyless: true, tags,
      summary: 'Página pública de la tienda: perfil, reputación, productos, promociones, publicaciones y reseñas.',
      handler: ctx => cacheable(ctx, mp().discovery.storePage(ctx.params.code), 30),
    },
    {
      method: 'GET', path: '/marketplace/localities', permission: null, bodyless: true, tags,
      summary: 'Localidades habilitadas y próximas, en árbol.',
      handler: ctx => cacheable(ctx, { tree: mp().discovery.localities() }, 300),
    },
    {
      method: 'GET', path: '/marketplace/explore', permission: null, bodyless: true, tags, query: { locality: rule.text(80) },
      summary: 'Mapa de tiendas: solo coordenadas publicadas por cada tienda; el resto por zona general.',
      handler: ctx => mp().discovery.explore(ctx.query.locality || null),
    },
    {
      method: 'GET', path: '/marketplace/carts/:id/shipping-options', permission: null, bodyless: true, tags,
      query: { locality: rule.id() },
      summary: 'Opciones de entrega por tienda o proveedor para el carrito, estimables por ciudad antes del checkout.',
      handler: ctx => {
        const cart = container.resolve('cart').repository.retrieve(ctx.params.id);
        // Sin dirección todavía, la ciudad basta para estimar: el comprador ve el
        // envío en el carrito y no se lo encuentra al final. Si no eligió ciudad,
        // se usa la del marketplace y se dice para cuál se estimó.
        const settings = container.resolve('settings').settings;
        const localityId = ctx.query.locality || settings.get('marketplace.defaultLocalityId', null);
        const estimating = !cart.shippingAddress?.address1 && localityId;
        const target = estimating ? mp().deliveryEstimates.addressFor(localityId) : null;
        const data = mp().cartShipping.optionsFor(cart, { fallbackAddress: target?.address || null });
        return {
          data,
          count: data.length,
          estimatedFor: target?.locality ? { id: target.locality.id, name: target.locality.name } : null,
        };
      },
    },
    {
      method: 'POST', path: '/marketplace/carts/:id/shipping-methods', permission: null, csrf: false, tags,
      body: {
        selections: rule.list({
          type: 'object',
          shape: { group: rule.text(80, { required: true }), shippingOptionId: rule.id({ required: true }) },
        }, { required: true, maxItems: 20 }),
      },
      summary: 'Elige la entrega de cada tienda; el importe sale de la opción configurada.',
      handler: async ctx => {
        await mp().cartShipping.select(ctx.params.id, ctx.body.selections, ctx);
        return cartView(container, ctx.params.id);
      },
    },
    {
      method: 'GET', path: '/marketplace/carts/:id', permission: null, bodyless: true, tags,
      summary: 'Carrito agrupado por tienda o proveedor, con total unificado.',
      handler: ctx => cartView(container, ctx.params.id),
    },

    // --- Cuenta del comprador ---------------------------------------------------
    {
      method: 'GET', path: '/marketplace/me', permission: null, bodyless: true, tags,
      summary: 'Cuenta actual con capacidades (comprador, vendedor, proveedor) y avisos sin leer.',
      handler: ctx => {
        const customer = currentCustomer(ctx);
        if (!customer) return { customer: null, capabilities: [], stores: [], unread: 0 };
        return {
          customer: customers().publicView(customer),
          ...mp().accounts.capabilities(customer.id),
          unread: mp().inbox.unreadCount('customer', customer.id),
        };
      },
    },
    {
      method: 'GET', path: '/marketplace/me/orders', permission: null, bodyless: true, tags,
      summary: 'Pedidos del comprador con el estado de cada subpedido.',
      handler: ctx => {
        const customer = mp().accounts.requireCustomer(ctx);
        const orders = container.resolve('order').orders.repository.all({ customerId: customer.id })
          .sort((a, b) => String(b.placedAt || b.createdAt).localeCompare(String(a.placedAt || a.createdAt)));
        const data = orders.map(order => buyerOrderView(container, order));
        return { data, count: data.length };
      },
    },
    {
      method: 'GET', path: '/marketplace/me/orders/:id', permission: null, bodyless: true, tags,
      summary: 'Detalle de un pedido del comprador.',
      handler: ctx => {
        const customer = mp().accounts.requireCustomer(ctx);
        const order = container.resolve('order').orders.repository.byId(ctx.params.id);
        if (!order || order.customerId !== customer.id) throw new NotFoundError('pedido', ctx.params.id);
        return buyerOrderView(container, order, { full: true });
      },
    },
    {
      method: 'GET', path: '/marketplace/me/notifications', permission: null, bodyless: true, tags,
      query: { unread: rule.flag(), limit: { type: 'integer', coerce: true, min: 1, max: 100 } },
      summary: 'Avisos del comprador y de sus tiendas.',
      handler: ctx => {
        const customer = mp().accounts.requireCustomer(ctx);
        const data = mp().inbox.forRecipient('customer', customer.id, { unreadOnly: Boolean(ctx.query.unread), limit: ctx.query.limit || 50 });
        return { data, count: data.length };
      },
    },
    {
      method: 'POST', path: '/marketplace/me/notifications/read', permission: null, tags,
      body: { ids: rule.list({ type: 'string' }, { maxItems: 200 }) },
      summary: 'Marca avisos como leídos (todos si no se indican).',
      handler: ctx => {
        const customer = mp().accounts.requireCustomer(ctx);
        return mp().inbox.markRead('customer', customer.id, ctx.body.ids?.length ? ctx.body.ids : null);
      },
    },

    // --- Alta y panel de la tienda ------------------------------------------------
    {
      method: 'GET', path: '/marketplace/seller/stores', permission: null, bodyless: true, tags: sellerTags,
      summary: 'Tiendas que administra la cuenta actual.',
      handler: ctx => {
        const customer = mp().accounts.requireCustomer(ctx);
        const data = mp().accounts.membershipsFor(customer.id)
          .map(row => container.resolve('channel').sellers.repository.byId(row.sellerId))
          .filter(Boolean)
          .map(seller => mp().accounts.privateView(seller));
        return { data, count: data.length };
      },
    },
    {
      method: 'POST', path: '/marketplace/seller/stores', permission: null, status: 201, tags: sellerTags,
      body: { name: rule.text(120, { required: true }) , type: rule.text(40), tagline: rule.text(160), description: rule.text(3000), categoryIds: rule.list({ type: 'string' }, { maxItems: 8 }), localityId: rule.id() },
      summary: 'Paso «Crear tienda»: crea la tienda pendiente con su solicitud en borrador.',
      handler: ctx => mp().accounts.createStore(ctx, ctx.body),
    },
    {
      method: 'GET', path: '/marketplace/seller/stores/:sellerId', permission: null, bodyless: true, tags: sellerTags,
      summary: 'Perfil privado de la tienda para sus miembros.',
      handler: ctx => mp().accounts.privateView(member(ctx).seller),
    },
    {
      method: 'PATCH', path: '/marketplace/seller/stores/:sellerId', permission: null, tags: sellerTags,
      summary: 'Paso «Completar información»: actualiza el perfil de la tienda.',
      handler: ctx => mp().accounts.updateProfile(ctx, ctx.params.sellerId, ctx.body),
    },
    {
      method: 'POST', path: '/marketplace/seller/stores/:sellerId/submit', permission: null, tags: sellerTags,
      body: { acceptTerms: rule.flag({ required: true }) },
      summary: 'Pasos «Aceptar términos» y «Enviar solicitud».',
      handler: ctx => mp().accounts.submit(ctx, ctx.params.sellerId, ctx.body),
    },
    {
      method: 'POST', path: '/marketplace/seller/stores/:sellerId/members', permission: null, status: 201, tags: sellerTags,
      body: { email: rule.email({ required: true }), role: rule.enumOf(['manager', 'staff'], { default: 'staff' }) },
      summary: 'Añade un encargado o colaborador a la tienda.',
      handler: ctx => mp().accounts.addMember(ctx, ctx.params.sellerId, ctx.body),
    },
    {
      method: 'GET', path: '/marketplace/seller/stores/:sellerId/dashboard', permission: null, bodyless: true, tags: sellerTags,
      query: { days: { type: 'integer', coerce: true, min: 1, max: 365 } },
      summary: 'Métricas de la tienda: ventas, pedidos, vistas, favoritos, conversión, ingresos y más vendidos.',
      handler: ctx => sellerDashboard(container, member(ctx).seller, ctx.query.days || 30),
    },
    {
      method: 'POST', path: '/marketplace/seller/stores/:sellerId/uploads', permission: null, status: 201, tags: sellerTags,
      maxBodyBytes: 1_200_000,
      body: { data: { type: 'string', required: true, maxLength: 1_200_000 }, alt: rule.text(300) },
      summary: 'Sube una imagen de producto o de tienda (PNG, JPEG o WebP validados por firma).',
      handler: async ctx => {
        const { seller, actorCtx } = member(ctx);
        const asset = await container.resolve('catalog').assets.upload({ data: ctx.body.data, name: `${seller.code}-imagen`, alt: ctx.body.alt || seller.name, tags: ['tienda'] }, actorCtx);
        return { id: asset.id, url: asset.url, alt: asset.alt, width: asset.width, height: asset.height };
      },
    },
    {
      method: 'GET', path: '/marketplace/seller/stores/:sellerId/products', permission: null, bodyless: true, tags: sellerTags,
      query: { status: rule.enumOf(['draft', 'proposed', 'published', 'rejected']) },
      summary: 'Productos de la tienda con precio y stock por variante.',
      handler: ctx => {
        const { seller } = member(ctx);
        const data = mp().listings.sellerProducts(seller.id, { status: ctx.query.status || null }).map(product => mp().listings.managementView(product));
        return { data, count: data.length };
      },
    },
    {
      method: 'POST', path: '/marketplace/seller/stores/:sellerId/products', permission: null, status: 201, tags: sellerTags,
      body: LISTING_INPUT, bodyRequired: true,
      summary: 'Publica un producto local: ficha, variantes, precio y stock en un solo paso.',
      handler: ctx => {
        const { seller, actorCtx } = member(ctx);
        if (seller.status !== 'active' && ctx.body.status === 'published') {
          throw new ConflictError('La tienda debe estar aprobada para publicar. Puedes guardar borradores mientras tanto.');
        }
        return mp().listings.create({ sellerId: seller.id }, ctx.body, actorCtx);
      },
    },
    {
      method: 'GET', path: '/marketplace/seller/stores/:sellerId/products/:productId', permission: null, bodyless: true, tags: sellerTags,
      summary: 'Un producto propio de la tienda.',
      handler: ctx => mp().listings.managementView(mp().listings.ownedProduct(member(ctx).seller.id, ctx.params.productId)),
    },
    {
      method: 'PATCH', path: '/marketplace/seller/stores/:sellerId/products/:productId', permission: null, tags: sellerTags,
      summary: 'Actualiza datos, precio o stock de un producto propio.',
      handler: ctx => {
        const { seller, actorCtx } = member(ctx);
        return mp().listings.update({ sellerId: seller.id }, ctx.params.productId, ctx.body, actorCtx);
      },
    },
    {
      method: 'POST', path: '/marketplace/seller/stores/:sellerId/products/:productId/publish', permission: null, tags: sellerTags,
      summary: 'Publica el producto (o lo envía a moderación si la instalación lo exige).',
      handler: async ctx => {
        const { seller, actorCtx } = member(ctx);
        mp().listings.ownedProduct(seller.id, ctx.params.productId);
        if (seller.status !== 'active') throw new ConflictError('La tienda debe estar aprobada para publicar.');
        await mp().listings.publish(ctx.params.productId, actorCtx);
        return mp().listings.managementView(container.resolve('catalog').products.repository.retrieve(ctx.params.productId));
      },
    },
    {
      method: 'POST', path: '/marketplace/seller/stores/:sellerId/products/:productId/unpublish', permission: null, tags: sellerTags,
      summary: 'Retira el producto del catálogo público.',
      handler: async ctx => {
        const { seller, actorCtx } = member(ctx);
        mp().listings.ownedProduct(seller.id, ctx.params.productId);
        await mp().listings.unpublish(ctx.params.productId, actorCtx);
        return mp().listings.managementView(container.resolve('catalog').products.repository.retrieve(ctx.params.productId));
      },
    },
    {
      method: 'DELETE', path: '/marketplace/seller/stores/:sellerId/products/:productId', permission: null, bodyless: true, tags: sellerTags,
      summary: 'Borra (lógicamente) un producto propio sin pedidos abiertos.',
      handler: async ctx => {
        const { seller, actorCtx } = member(ctx);
        const product = mp().listings.ownedProduct(seller.id, ctx.params.productId);
        const open = mp().vendorOrders.forSeller(seller.id).filter(row => mp().vendorOrders.isOpen(row) && row.items.some(item => item.productId === product.id));
        if (open.length) throw new ConflictError('El producto tiene pedidos abiertos; despublícalo en lugar de borrarlo.');
        await container.resolve('catalog').products.delete(product.id, actorCtx);
        return { deleted: true, id: product.id };
      },
    },
    {
      method: 'POST', path: '/marketplace/seller/stores/:sellerId/products/import', permission: null, tags: sellerTags,
      maxBodyBytes: 900_000,
      body: { csv: { type: 'string', required: true, maxLength: 800_000 }, dryRun: rule.flag({ default: true }), publish: rule.flag({ default: false }) },
      summary: 'Importa productos desde CSV con validación de duplicados y datos incompletos.',
      handler: ctx => {
        const { seller, actorCtx } = member(ctx, ['owner', 'manager']);
        if (ctx.body.publish && seller.status !== 'active') throw new ConflictError('La tienda debe estar aprobada para publicar.');
        return mp().listings.importCsv({ sellerId: seller.id }, ctx.body, actorCtx);
      },
    },
    {
      method: 'GET', path: '/marketplace/seller/stores/:sellerId/orders', permission: null, bodyless: true, tags: sellerTags,
      query: { status: rule.enumOf(VENDOR_STATUSES) },
      summary: 'Subpedidos de la tienda.',
      handler: ctx => {
        const { seller } = member(ctx);
        const data = mp().vendorOrders.forSeller(seller.id, { status: ctx.query.status || null }).map(row => mp().vendorOrders.sellerView(row));
        return { data, count: data.length };
      },
    },
    {
      method: 'GET', path: '/marketplace/seller/stores/:sellerId/orders/:vendorOrderId', permission: null, bodyless: true, tags: sellerTags,
      summary: 'Detalle de un subpedido de la tienda.',
      handler: ctx => {
        const { seller } = member(ctx);
        return mp().vendorOrders.sellerView(mp().vendorOrders.ownedBySeller(seller.id, ctx.params.vendorOrderId));
      },
    },
    {
      method: 'POST', path: '/marketplace/seller/stores/:sellerId/orders/:vendorOrderId/status', permission: null, tags: sellerTags,
      body: {
        status: rule.enumOf(VENDOR_STATUSES, { required: true }),
        note: rule.text(300),
        tracking: { type: 'object', shape: { carrier: rule.text(80), trackingNumber: rule.text(120), trackingUrl: rule.url() } },
      },
      summary: 'La tienda avanza su subpedido: preparación, listo, enviado, en tránsito, entregado o cancelado.',
      handler: async ctx => {
        const { seller, actorCtx } = member(ctx);
        mp().vendorOrders.ownedBySeller(seller.id, ctx.params.vendorOrderId);
        const updated = await mp().vendorOrders.transition(ctx.params.vendorOrderId, ctx.body.status, {
          actorType: 'seller', note: ctx.body.note || null, tracking: ctx.body.tracking || null, ctx: actorCtx,
        });
        return mp().vendorOrders.sellerView(updated);
      },
    },
    {
      method: 'GET', path: '/marketplace/seller/stores/:sellerId/returns', permission: null, bodyless: true, tags: sellerTags,
      summary: 'Devoluciones que afectan a los subpedidos de la tienda.',
      handler: ctx => {
        const { seller } = member(ctx);
        const orderModule = container.resolve('order');
        const mine = mp().vendorOrders.forSeller(seller.id);
        const lineIds = new Set(mine.flatMap(vendorOrder => (vendorOrder.items || []).map(item => item.lineItemId)));
        const data = orderModule.returns.repository.all()
          .filter(record => (record.items || []).some(item => lineIds.has(item.lineItemId)))
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .map(record => {
            const vendorOrder = mine.find(row => (row.items || []).some(item => (record.items || []).some(entry => entry.lineItemId === item.lineItemId)));
            return {
              id: record.id,
              status: record.status,
              createdAt: record.createdAt,
              note: record.note || null,
              rejectionReason: record.rejectionReason || null,
              refundAmount: record.refundAmount || 0,
              vendorOrderCode: vendorOrder?.code || null,
              currencyCode: vendorOrder?.currencyCode || null,
              items: (record.items || [])
                .filter(item => lineIds.has(item.lineItemId))
                .map(item => {
                  const line = (vendorOrder?.items || []).find(entry => entry.lineItemId === item.lineItemId);
                  return { title: line?.title || item.lineItemId, quantity: item.quantity, receivedQuantity: item.receivedQuantity ?? null, condition: item.condition || null };
                }),
            };
          });
        return { data, count: data.length };
      },
    },
    {
      method: 'GET', path: '/marketplace/seller/stores/:sellerId/customers', permission: null, bodyless: true, tags: sellerTags,
      summary: 'Clientes de la tienda: nombre visible, compras e importe. Sin correo ni dirección.',
      handler: ctx => {
        const { seller } = member(ctx);
        const byCustomer = new Map();
        for (const row of mp().vendorOrders.forSeller(seller.id)) {
          if (!row.customerId || row.status === 'cancelled') continue;
          const current = byCustomer.get(row.customerId) || { orders: 0, total: 0, lastOrderAt: null };
          current.orders += 1;
          current.total += row.total;
          current.lastOrderAt = [current.lastOrderAt, row.createdAt].filter(Boolean).sort().at(-1);
          byCustomer.set(row.customerId, current);
        }
        const { displayName } = discoveryHelpers;
        const data = [...byCustomer.entries()].map(([customerId, stats]) => ({
          name: displayName(customers().repository.byId(customerId)), ...stats,
        })).sort((a, b) => b.total - a.total);
        return { data, count: data.length };
      },
    },
    {
      method: 'GET', path: '/marketplace/seller/stores/:sellerId/promotions', permission: null, bodyless: true, tags: sellerTags,
      summary: 'Promociones de la tienda.',
      handler: ctx => {
        const { seller } = member(ctx);
        const promotion = container.resolve('promotion');
        const data = promotion.promotions.repository.all().filter(row => row.metadata?.sellerId === seller.id).map(row => ({
          ...row,
          coupons: promotion.coupons.repository.all({ promotionId: row.id }).map(coupon => ({ code: coupon.code, usageCount: coupon.usageCount, usageLimit: coupon.usageLimit })),
        }));
        return { data, count: data.length };
      },
    },
    {
      method: 'POST', path: '/marketplace/seller/stores/:sellerId/promotions', permission: null, status: 201, tags: sellerTags,
      body: {
        name: rule.text(140, { required: true }),
        label: rule.text(80),
        description: rule.text(500),
        type: rule.enumOf(['percentage', 'fixed'], { required: true }),
        value: { type: 'number', coerce: true, required: true, min: 1 },
        code: { type: 'string', maxLength: 30, pattern: /^[A-Za-z0-9-]{3,30}$/, patternMessage: 'Solo letras, números y guiones.' },
        startsAt: rule.date(),
        endsAt: rule.date(),
        usageLimit: rule.quantity(),
        showInCatalog: rule.flag({ default: true }),
      },
      summary: 'Crea una promoción acotada a los productos de la tienda (la financia la tienda).',
      handler: ctx => createSellerPromotion(container, member(ctx, ['owner', 'manager']), ctx.body),
    },
    {
      method: 'POST', path: '/marketplace/seller/stores/:sellerId/promotions/:promotionId/status', permission: null, tags: sellerTags,
      body: { status: rule.enumOf(['active', 'paused'], { required: true }) },
      summary: 'Activa o pausa una promoción de la tienda.',
      handler: async ctx => {
        const { seller, actorCtx } = member(ctx, ['owner', 'manager']);
        const promotions = container.resolve('promotion').promotions;
        const promotion = promotions.repository.byId(ctx.params.promotionId);
        if (!promotion || promotion.metadata?.sellerId !== seller.id) throw new NotFoundError('promoción', ctx.params.promotionId);
        return promotions.update(promotion.id, { status: ctx.body.status }, actorCtx);
      },
    },
  ];
}

const discoveryHelpers = { displayName: customer => {
  if (!customer?.firstName) return 'Cliente';
  return customer.lastName ? `${customer.firstName} ${customer.lastName[0].toUpperCase()}.` : customer.firstName;
} };

/** Carrito agrupado por responsable. El total es el del carrito: se calcula en backend. */
function cartView(container, cartId) {
  const cartService = container.resolve('cart');
  const cart = cartService.publicView(cartService.repository.retrieve(cartId));
  const sellers = container.resolve('channel').sellers;
  const catalog = container.resolve('catalog');
  const discovery = container.resolve('marketplace').discovery;
  const groups = new Map();
  for (const line of cart.items || []) {
    const product = catalog.products.repository.byId(line.productId);
    const model = line.commercialModel || product?.commercialModel || 'PROPIO';
    const key = model === 'LOCAL' ? `seller:${line.sellerId || product?.sellerId}` : model === 'DROPSHIPPING' ? 'supplier' : 'platform';
    if (!groups.has(key)) {
      const seller = model === 'LOCAL' ? sellers.repository.byId(line.sellerId || product?.sellerId) : null;
      groups.set(key, {
        key,
        partyType: model === 'LOCAL' ? 'seller' : model === 'DROPSHIPPING' ? 'supplier' : 'platform',
        title: seller ? seller.name : model === 'DROPSHIPPING' ? 'Envío de proveedor aliado' : 'Vendido por Ndivepa',
        seller: seller ? { id: seller.id, code: seller.code, name: seller.name, logoUrl: seller.logoUrl || null, deliveryModes: seller.deliveryModes || [] } : null,
        items: [],
        subtotal: 0,
      });
    }
    const group = groups.get(key);
    group.items.push({ ...line, image: product ? discovery.imageOf(product) : null, emoji: product?.image && product.image.length <= 4 ? product.image : null, handle: product?.handle || null });
    group.subtotal += Number(line.subtotalAfterDiscount ?? line.total ?? 0);
  }
  return { ...cart, groups: [...groups.values()] };
}

function buyerOrderView(container, order, { full = false } = {}) {
  const mp = container.resolve('marketplace');
  const vendorOrders = mp.vendorOrders.forOrder(order.id);
  const aggregate = mp.vendorOrders.aggregateStatus(vendorOrders);
  const publicOrder = container.resolve('order').orders.publicView(order);
  const base = {
    id: order.id,
    code: order.code,
    placedAt: order.placedAt,
    status: order.status,
    paymentStatus: order.paymentStatus,
    marketplaceStatus: aggregate,
    marketplaceStatusLabel: aggregate ? VENDOR_STATUS_LABELS[aggregate] : null,
    total: order.total,
    currencyCode: order.currencyCode,
    itemCount: (order.items || []).reduce((sum, item) => sum + item.quantity, 0),
    vendorOrders: vendorOrders.map(row => mp.vendorOrders.buyerView(row)),
  };
  if (!full) return base;
  const orderModule = container.resolve('order');
  return {
    ...base,
    // Devoluciones del propio pedido, con lo que el comprador necesita seguir.
    returns: orderModule.returns.repository.all({ orderId: order.id }).map(record => ({
      id: record.id,
      status: record.status,
      createdAt: record.createdAt,
      refundAmount: record.refundAmount || 0,
      rejectionReason: record.rejectionReason || null,
      items: (record.items || []).map(item => ({
        lineItemId: item.lineItemId,
        title: (order.items || []).find(line => line.id === item.lineItemId)?.title || item.lineItemId,
        quantity: item.quantity,
      })),
    })),
    // Devolvible = lo entregado y todavía no devuelto, línea por línea.
    returnable: (order.items || [])
      .map(line => ({ ...line, pending: Math.min(line.quantity, Number(line.fulfilledQuantity || 0)) - Number(line.returnedQuantity || 0) }))
      .filter(line => line.pending > 0)
      .map(line => ({ lineItemId: line.id, title: line.title, quantity: line.pending })),
    items: publicOrder.items,
    subtotal: order.subtotal,
    discountTotal: order.discountTotal,
    shippingTotal: order.shippingTotal,
    shippingAddress: order.shippingAddress,
    shippingMethods: order.shippingMethods,
    history: container.resolve('order').history.forOrder(order.id, { includeInternal: false }),
  };
}

/** Promoción de tienda: `targetRules` sobre `sellerId` la acota a sus líneas. */
async function createSellerPromotion(container, { seller, actorCtx }, input) {
  if (input.type === 'percentage' && input.value > 90) throw ValidationError.single('value', 'Una tienda puede descontar hasta el 90 %.');
  const promotion = container.resolve('promotion');
  const currency = container.resolve('settings').settings.get('marketplace.currencyCode', 'PYG');
  const code = input.code ? input.code.toUpperCase() : null;
  if (code && promotion.coupons.repository.find({ code })) throw new ConflictError('Ese código de cupón ya existe.');
  const created = await promotion.promotions.create({
    code: `tienda-${seller.code}-${humanCode('', 6, '').toLowerCase()}`.slice(0, 120),
    name: input.name,
    label: input.label || input.name,
    description: input.description || null,
    type: code ? 'standard' : 'automatic',
    applicationMethod: {
      type: input.type,
      value: input.type === 'fixed' ? Math.round(input.value) : input.value,
      currencyCode: currency,
      target: 'items',
    },
    targetRules: [{ attribute: 'sellerId', operator: 'eq', values: [seller.id] }],
    requiresCode: Boolean(code),
    usageLimit: input.usageLimit || undefined,
    startsAt: input.startsAt || now(),
    endsAt: input.endsAt || undefined,
    status: 'active',
    showInCatalog: input.showInCatalog !== false,
    metadata: { sellerId: seller.id, fundedBy: 'seller' },
  }, actorCtx);
  if (code) await promotion.coupons.create({ promotionId: created.id, code, usageLimit: input.usageLimit || undefined, active: true }, actorCtx);
  await container.resolve('events').emit('marketplace.promotion.created', { promotionId: created.id, sellerId: seller.id });
  return created;
}

/** Métricas del panel de la tienda. Solo cifras calculadas desde datos reales. */
function sellerDashboard(container, seller, days) {
  const mp = container.resolve('marketplace');
  const store = container.resolve('store');
  const catalog = container.resolve('catalog');
  const since = Date.now() - days * 86_400_000;
  const inRange = value => new Date(value).getTime() >= since;
  const vendorOrders = mp.vendorOrders.forSeller(seller.id);
  const recent = vendorOrders.filter(row => inRange(row.createdAt));
  const valid = recent.filter(row => row.status !== 'cancelled');
  const products = catalog.products.repository.all({ sellerId: seller.id });
  const productIds = new Set(products.map(product => product.id));
  const views = store.collection('events').filter(event => event.type === 'product_view' && productIds.has(event.productId) && inRange(event.timestamp)).length;
  const favorites = store.collection('favorites').filter(row => !row.deletedAt && row.targetType === 'product' && productIds.has(row.targetId)).length;
  const units = new Map();
  for (const row of valid) {
    for (const item of row.items || []) {
      const current = units.get(item.productId) || { productId: item.productId, title: item.title, units: 0, revenue: 0 };
      current.units += item.quantity;
      current.revenue += item.base;
      units.set(item.productId, current);
    }
  }
  const byStatus = {};
  for (const row of vendorOrders) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  const finance = mp.finance.summary({ sellerId: seller.id });
  const reputation = mp.discovery.sellerReputation(seller.id);
  const buyers = new Set(valid.map(row => row.customerId).filter(Boolean));
  return {
    range: { days },
    sales: { gross: valid.reduce((sum, row) => sum + row.total, 0), orders: valid.length, cancelled: recent.length - valid.length },
    ordersByStatus: byStatus,
    openOrders: vendorOrders.filter(row => mp.vendorOrders.isOpen(row)).length,
    products: { total: products.length, published: products.filter(product => product.status === 'published').length, drafts: products.filter(product => product.status === 'draft').length },
    // Las vistas solo cuentan visitas con consentimiento de analítica.
    views,
    favorites,
    conversionRate: views ? Math.round((valid.length / views) * 1000) / 10 : null,
    buyers: buyers.size,
    income: {
      pending: finance.sellerPayable.pending,
      available: finance.sellerPayable.confirmedUnpaid,
      paid: finance.sellerPayable.paid,
      commissions: finance.platformRevenue.commissions,
      currencyCode: finance.currencyCode,
    },
    topProducts: [...units.values()].sort((a, b) => b.units - a.units).slice(0, 5),
    reputation,
    quality: listingQuality(container, products),
    status: seller.status,
  };
}

/**
 * Publicaciones que se pueden mejorar. Una ficha sin foto o sin descripción se
 * vende mucho menos, y la tienda no tiene cómo darse cuenta mirando la lista.
 * Son comprobaciones sobre datos reales del propio catálogo, no consejos
 * genéricos.
 */
function listingQuality(container, products) {
  const discovery = container.resolve('marketplace').discovery;
  const published = products.filter(product => product.status === 'published');
  const issues = {
    sinFoto: [], sinDescripcion: [], sinStock: [], sinEntrega: [], sinCategoria: [],
  };
  for (const product of published) {
    const card = { name: product.name, handle: product.handle, id: product.id };
    if (!discovery.gallery(product).length) issues.sinFoto.push(card);
    if (String(product.description || '').trim().length < 40) issues.sinDescripcion.push(card);
    if (!discovery.stockState(product).hasStock) issues.sinStock.push(card);
    if (!(product.deliveryModes || []).length) issues.sinEntrega.push(card);
    if (!product.categoryId) issues.sinCategoria.push(card);
  }
  const total = Object.values(issues).reduce((sum, list) => sum + list.length, 0);
  return {
    reviewed: published.length,
    pending: total,
    issues: Object.fromEntries(Object.entries(issues).map(([key, list]) => [key, list.slice(0, 5)])),
    counts: Object.fromEntries(Object.entries(issues).map(([key, list]) => [key, list.length])),
  };
}

// ---------------------------------------------------------------------------
// Administración
// ---------------------------------------------------------------------------


/**
 * Exportaciones CSV para contabilidad y operación. Se generan desde los mismos
 * datos que muestra el panel; los importes van en unidades mínimas y con su
 * moneda, para que nadie tenga que adivinar decimales en una planilla.
 */
const EXPORTS = {
  pedidos: container => {
    const mp = container.resolve('marketplace');
    const sellers = new Map(container.resolve('channel').sellers.repository.all().map(row => [row.id, row.name]));
    const rows = container.resolve('store').collection('vendorOrders').filter(row => !row.deletedAt);
    return {
      header: ['subpedido', 'pedido', 'fecha', 'tipo', 'tienda', 'estado', 'moneda', 'subtotal', 'envio', 'total', 'comision', 'pago_tienda', 'costo_proveedor', 'margen'],
      rows: rows.map(row => [
        row.code, row.orderCode, row.createdAt, row.partyType, sellers.get(row.sellerId) || '',
        VENDOR_STATUS_LABELS[row.status] || row.status, row.currencyCode, row.subtotal, row.shippingShare,
        row.total, row.commissionTotal, row.sellerPayout, row.supplierCost, row.platformMargin,
      ]),
      note: mp ? null : null,
    };
  },
  contabilidad: container => {
    const sellers = new Map(container.resolve('channel').sellers.repository.all().map(row => [row.id, row.name]));
    const rows = container.resolve('store').collection('ledgerEntries');
    return {
      header: ['fecha', 'flujo', 'tipo', 'estado', 'moneda', 'importe', 'tienda', 'pedido', 'subpedido', 'referencia', 'liquidacion'],
      rows: rows.map(row => [
        row.occurredAt || row.createdAt, row.stream, row.type, row.status, row.currencyCode, row.amount,
        sellers.get(row.sellerId) || '', row.orderId || '', row.vendorOrderId || '', row.reference || '', row.payoutId || '',
      ]),
    };
  },
  liquidaciones: container => {
    const sellers = new Map(container.resolve('channel').sellers.repository.all().map(row => [row.id, row.name]));
    const rows = container.resolve('store').collection('sellerPayouts').filter(row => !row.deletedAt);
    return {
      header: ['fecha', 'tienda', 'moneda', 'importe', 'estado', 'metodo', 'referencia', 'pagada'],
      rows: rows.map(row => [row.createdAt, sellers.get(row.sellerId) || row.sellerId, row.currencyCode, row.amount, row.status, row.method || '', row.reference || '', row.paidAt || '']),
    };
  },
  productos: container => {
    const catalog = container.resolve('catalog');
    const sellers = new Map(container.resolve('channel').sellers.repository.all().map(row => [row.id, row.name]));
    const categories = new Map(catalog.categories.repository.all().map(row => [row.id, row.name]));
    return {
      header: ['nombre', 'handle', 'modelo', 'tienda', 'categoria', 'estado', 'moneda', 'precio', 'precio_anterior', 'vistas', 'creado'],
      rows: catalog.products.repository.all().map(row => [
        row.name, row.handle, row.commercialModel || '', sellers.get(row.sellerId) || '', categories.get(row.categoryId) || '',
        row.status, row.price?.currency || '', row.price?.amount ?? '', row.price?.previousAmount ?? '', row.viewCount || 0, row.createdAt,
      ]),
    };
  },
  tiendas: container => {
    const mp = container.resolve('marketplace');
    const localities = new Map(container.resolve('store').collection('localities').map(row => [row.id, row.name]));
    return {
      header: ['tienda', 'codigo', 'estado', 'tipo', 'localidad', 'zona', 'productos', 'ventas', 'valoracion', 'resenas', 'alta'],
      rows: container.resolve('channel').sellers.repository.all().map(row => {
        const reputation = mp.discovery.sellerReputation(row.id);
        return [
          row.name, row.code, SELLER_STATUS_LABELS[row.status] || row.status, row.type || '', localities.get(row.localityId) || '',
          row.location?.area || '', reputation.productsPublished, reputation.salesCount,
          reputation.rating.average ?? '', reputation.rating.count, row.createdAt,
        ];
      }),
    };
  },
};

function adminRoutes(container) {
  const mp = () => container.resolve('marketplace');
  const tags = ['marketplace'];
  return [
    ...crudRoutes(localityResource, () => mp().localities, { tags }),
    ...crudRoutes(sellerMemberResource, () => mp().members, { tags }),
    ...crudRoutes(sellerApplicationResource, () => mp().applications, { tags }),
    ...crudRoutes(sellerPlanResource, () => mp().plans, { tags }),
    ...crudRoutes(commissionRuleResource, () => mp().rules, { tags }),
    ...crudRoutes(searchSynonymResource, () => mp().synonyms, { tags }),
    ...crudRoutes(stockAlertResource, () => mp().stockAlerts, { tags }),
    ...crudRoutes(vendorOrderResource, () => mp().vendorOrdersBase, { tags }).filter(route => route.method === 'GET'),
    ...crudRoutes(ledgerEntryResource, () => mp().ledger, { tags }).filter(route => route.method === 'GET'),
    ...crudRoutes(sellerPayoutResource, () => mp().payouts, { tags }).filter(route => route.method === 'GET'),
    {
      method: 'GET', path: '/marketplace/dashboard', permission: 'marketplace:read', bodyless: true, tags,
      query: { days: { type: 'integer', coerce: true, min: 1, max: 3650 } },
      summary: 'Panel general: ventas del marketplace, ingresos de la plataforma, afiliados, dropshipping y publicidad por separado.',
      handler: ctx => adminDashboard(container, ctx.query.days || null),
    },
    {
      method: 'GET', path: '/marketplace/sellers', permission: 'seller:read', bodyless: true, tags,
      query: { status: rule.enumOf(['pending', 'active', 'suspended', 'rejected']), q: rule.text(80) },
      summary: 'Tiendas con estado, solicitud vigente y reputación.',
      handler: ctx => {
        const sellers = container.resolve('channel').sellers.repository.all()
          .filter(row => !ctx.query.status || row.status === ctx.query.status)
          .filter(row => !ctx.query.q || row.name.toLowerCase().includes(String(ctx.query.q).toLowerCase()));
        const data = sellers.map(seller => ({ ...mp().accounts.privateView(seller), reputation: mp().discovery.sellerReputation(seller.id) }))
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        return { data, count: data.length };
      },
    },
    {
      method: 'POST', path: '/marketplace/seller-applications/:id/decision', permission: 'sellerApplication:update', tags,
      body: { decision: rule.enumOf(['approve', 'reject'], { required: true }), note: rule.text(600) },
      summary: 'Aprueba o rechaza una solicitud de tienda.',
      handler: ctx => mp().accounts.decide(ctx.params.id, ctx.body, ctx),
    },
    {
      method: 'POST', path: '/marketplace/sellers/:id/status', permission: 'seller:update', tags,
      body: { action: rule.enumOf(['suspend', 'reactivate'], { required: true }), reason: rule.text(500) },
      summary: 'Suspende o reactiva una tienda.',
      handler: ctx => mp().accounts.setStatus(ctx.params.id, { status: ctx.body.action, reason: ctx.body.reason || null }, ctx),
    },
    {
      method: 'POST', path: '/marketplace/sellers/:id/plan', permission: 'seller:update', tags,
      body: { planId: rule.id() },
      summary: 'Asigna un plan de suscripción a la tienda.',
      handler: async ctx => {
        if (ctx.body.planId) mp().plans.repository.retrieve(ctx.body.planId);
        await container.resolve('channel').sellers.update(ctx.params.id, { planId: ctx.body.planId || null }, ctx);
        return mp().accounts.privateView(container.resolve('channel').sellers.repository.retrieve(ctx.params.id));
      },
    },
    {
      method: 'POST', path: '/marketplace/sellers/:id/subscription-payments', permission: 'sellerPayout:create', status: 201, tags,
      body: { amount: rule.minor({ required: true, min: 1 }), period: rule.text(20, { required: true }), reference: rule.text(120) },
      summary: 'Registra el cobro de la suscripción de una tienda (ingreso de la plataforma).',
      handler: ctx => {
        const seller = container.resolve('channel').sellers.repository.retrieve(ctx.params.id);
        return mp().finance.recordRevenue({
          type: 'subscription', amount: ctx.body.amount, currencyCode: container.resolve('settings').settings.get('marketplace.currencyCode', 'PYG'),
          sellerId: seller.id, reference: ctx.body.reference || `SUB-${ctx.body.period}`, note: `Suscripción ${ctx.body.period}`,
        });
      },
    },
    {
      method: 'POST', path: '/marketplace/vendor-orders/:id/status', permission: 'vendorOrder:update', tags,
      body: {
        status: rule.enumOf(VENDOR_STATUSES, { required: true }),
        note: rule.text(300),
        tracking: { type: 'object', shape: { carrier: rule.text(80), trackingNumber: rule.text(120), trackingUrl: rule.url() } },
      },
      summary: 'Cambio de estado administrativo de un subpedido (incluye devoluciones).',
      handler: async ctx => mp().vendorOrders.sellerView(await mp().vendorOrders.transition(ctx.params.id, ctx.body.status, {
        actorType: 'admin', note: ctx.body.note || null, tracking: ctx.body.tracking || null, ctx,
      })),
    },
    {
      method: 'GET', path: '/marketplace/orders', permission: 'order:read', bodyless: true, tags,
      query: { q: rule.text(60), status: rule.enumOf(VENDOR_STATUSES) },
      summary: 'Pedidos con sus subpedidos, para operación.',
      handler: ctx => {
        const orders = container.resolve('order').orders.repository.all()
          .filter(order => !ctx.query.q || String(order.code).includes(String(ctx.query.q).toUpperCase()) || String(order.email || '').includes(String(ctx.query.q).toLowerCase()))
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .slice(0, 200)
          .map(order => ({
            ...buyerOrderView(container, order),
            email: order.email,
            vendorOrders: mp().vendorOrders.forOrder(order.id).map(row => mp().vendorOrders.sellerView(row)),
          }))
          .filter(order => !ctx.query.status || order.vendorOrders.some(row => row.status === ctx.query.status));
        return { data: orders, count: orders.length };
      },
    },
    {
      method: 'GET', path: '/marketplace/payables', permission: 'sellerPayout:read', bodyless: true, tags,
      summary: 'Importes por liquidar a cada tienda (firmes y en espera).',
      handler: () => {
        const sellers = container.resolve('channel').sellers;
        const data = mp().finance.payables().map(row => ({ ...row, sellerName: sellers.repository.byId(row.sellerId)?.name || row.sellerId }));
        return { data, count: data.length };
      },
    },
    {
      method: 'POST', path: '/marketplace/sellers/:id/payouts', permission: 'sellerPayout:create', status: 201, tags,
      body: { method: rule.text(80), note: rule.text(300) },
      summary: 'Crea la liquidación de lo que la tienda tiene disponible.',
      handler: ctx => mp().finance.createPayout(ctx.params.id, ctx.body, ctx),
    },
    {
      method: 'POST', path: '/seller-payouts/:id/paid', permission: 'sellerPayout:update', tags,
      body: { reference: rule.text(120) },
      summary: 'Marca una liquidación como pagada.',
      handler: ctx => mp().finance.markPayoutPaid(ctx.params.id, ctx.body, ctx),
    },
    {
      method: 'GET', path: '/marketplace/products', permission: 'product:read', bodyless: true, tags,
      query: { status: rule.enumOf(['draft', 'proposed', 'published', 'rejected']), model: rule.text(40), q: rule.text(80) },
      summary: 'Productos del marketplace para moderación, con modelo comercial y tienda.',
      handler: ctx => {
        const discovery = mp().discovery;
        const data = container.resolve('catalog').products.repository.all()
          .filter(product => !ctx.query.status || product.status === ctx.query.status)
          .filter(product => !ctx.query.model || product.commercialModel === ctx.query.model)
          .filter(product => !ctx.query.q || product.name.toLowerCase().includes(String(ctx.query.q).toLowerCase()))
          .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
          .slice(0, 300)
          .map(product => ({ ...discovery.card(product), status: product.status, visible: discovery.isVisible(product), updatedAt: product.updatedAt }));
        return { data, count: data.length };
      },
    },
    {
      method: 'POST', path: '/marketplace/products/:id/moderate', permission: 'product:update', tags,
      body: { decision: rule.enumOf(['publish', 'reject', 'unpublish'], { required: true }), note: rule.text(300) },
      summary: 'Moderación de un producto: publicar, rechazar o retirar.',
      handler: async ctx => {
        const products = container.resolve('catalog').products;
        const product = products.repository.retrieve(ctx.params.id);
        if (ctx.body.decision === 'publish') await mp().listings.publish(product.id, ctx, { moderated: false });
        else if (ctx.body.decision === 'reject') await products.update(product.id, { status: 'rejected', metadata: { ...(product.metadata || {}), moderationNote: ctx.body.note || null } }, ctx);
        else await mp().listings.unpublish(product.id, ctx);
        if (product.sellerId && ctx.body.decision !== 'publish') {
          const seller = container.resolve('channel').sellers.repository.byId(product.sellerId);
          if (seller) {
            await mp().accounts.notifyOwners(seller, {
              type: 'product_moderated', title: `Tu producto «${product.name}» fue ${ctx.body.decision === 'reject' ? 'rechazado' : 'retirado'}`,
              body: ctx.body.note || null, link: `/mi-tienda/${seller.id}/productos/${product.id}`,
            });
          }
        }
        return mp().discovery.card(products.repository.retrieve(product.id));
      },
    },
    {
      method: 'POST', path: '/marketplace/listings', permission: 'product:create', status: 201, tags,
      body: { ...LISTING_INPUT, supplierId: rule.id() },
      summary: 'Crea un producto propio de la plataforma o de dropshipping.',
      handler: ctx => {
        const { supplierId, ...input } = ctx.body;
        return mp().listings.create(supplierId ? { supplierId } : {}, input, ctx);
      },
    },
    {
      method: 'PATCH', path: '/marketplace/listings/:id', permission: 'product:update', tags,
      summary: 'Actualiza un producto propio o de dropshipping (datos, precio y stock).',
      handler: ctx => mp().listings.update({}, ctx.params.id, ctx.body, ctx),
    },
    {
      method: 'POST', path: '/marketplace/listings/import', permission: 'product:create', tags,
      maxBodyBytes: 900_000,
      body: { csv: { type: 'string', required: true, maxLength: 800_000 }, dryRun: rule.flag({ default: true }), publish: rule.flag({ default: false }) },
      summary: 'Importa productos propios desde CSV con informe por fila.',
      handler: ctx => mp().listings.importCsv({}, ctx.body, ctx),
    },
    {
      method: 'GET', path: '/marketplace/commission-preview', permission: 'commissionRule:read', bodyless: true, tags,
      query: { productId: rule.id({ required: true }), amount: rule.minor({ min: 0 }) },
      summary: 'Regla de comisión que se aplicaría a un producto y su importe.',
      handler: ctx => {
        const product = container.resolve('catalog').products.repository.retrieve(ctx.query.productId);
        const base = ctx.query.amount ?? product.price?.amount ?? 0;
        return {
          productId: product.id,
          base,
          ...mp().commissions.compute({
            productId: product.id, sellerId: product.sellerId, categoryId: product.categoryId, campaignId: product.campaignId, commercialModel: product.commercialModel,
          }, base),
        };
      },
    },
    {
      method: 'GET', path: '/marketplace/search-tuning', permission: 'searchSynonym:read', bodyless: true, tags,
      summary: 'Estado del buscador: sinónimos vigentes y búsquedas que no encontraron nada.',
      handler: () => {
        const search = container.resolve('search');
        return {
          index: search.describe(),
          synonyms: mp().synonyms.repository.all().sort((a, b) => a.term.localeCompare(b.term)),
          emptySearches: search.emptySearches({ limit: 30 }),
        };
      },
    },
    {
      method: 'GET', path: '/marketplace/analytics', permission: 'analytics:read', bodyless: true, tags,
      query: { days: { type: 'integer', coerce: true, min: 1, max: 365 } },
      summary: 'Qué funciona: visitas, búsquedas, clics, favoritos, carritos, compras, conversión y rankings.',
      handler: ctx => marketplaceAnalytics(container, ctx.query.days || 30),
    },
    {
      method: 'GET', path: '/marketplace/exports/:dataset', permission: 'marketplace:read', bodyless: true, tags,
      summary: 'Exporta pedidos, contabilidad, liquidaciones, productos o tiendas en CSV.',
      handler: ctx => {
        const build = EXPORTS[ctx.params.dataset];
        if (!build) throw new NotFoundError('exportación', ctx.params.dataset);
        const { header, rows } = build(container);
        const csv = [csvRow(header), ...rows.map(row => csvRow(row))].join('\r\n');
        const day = new Date().toISOString().slice(0, 10);
        return respond.text(ctx.res, 200, csv, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="ndivepa-${ctx.params.dataset}-${day}.csv"`,
          'Cache-Control': 'no-store',
        });
      },
    },
    {
      method: 'GET', path: '/marketplace/inbox', permission: 'inboxNotification:read', bodyless: true, tags,
      summary: 'Bandeja de avisos de administración (nuevas tiendas, incidencias, reportes).',
      handler: () => {
        const data = mp().inbox.forRecipient('staff', 'all', { limit: 100 });
        return { data, count: data.length, unread: mp().inbox.unreadCount('staff', 'all') };
      },
    },
    {
      method: 'POST', path: '/marketplace/inbox/read', permission: 'inboxNotification:update', tags,
      body: { ids: rule.list({ type: 'string' }, { maxItems: 200 }) },
      summary: 'Marca avisos de administración como leídos.',
      handler: ctx => mp().inbox.markRead('staff', 'all', ctx.body.ids?.length ? ctx.body.ids : null),
    },
    {
      method: 'GET', path: '/marketplace/integrations', permission: 'settings:read', bodyless: true, tags,
      summary: 'Adaptadores de integración registrados y si están configurados (sin secretos).',
      handler: () => ({ adapters: mp().adapters.describe() }),
    },
  ];
}

function adminDashboard(container, days) {
  const mp = container.resolve('marketplace');
  const store = container.resolve('store');
  const within = value => days === null || (Date.now() - new Date(value).getTime()) <= days * 86_400_000;
  const vendorOrders = store.collection('vendorOrders').filter(row => !row.deletedAt && within(row.createdAt));
  const orders = store.collection('orders').filter(row => !row.deletedAt && row.status !== 'draft' && within(row.placedAt || row.createdAt));
  const products = store.collection('products').filter(row => !row.deletedAt);
  const byModel = {};
  for (const product of products.filter(row => row.status === 'published')) byModel[product.commercialModel || 'AFILIADO'] = (byModel[product.commercialModel || 'AFILIADO'] || 0) + 1;
  const commissions = store.collection('commissions').filter(row => !row.deletedAt && within(row.createdAt));
  const affiliateTotal = status => commissions.filter(row => row.status === status).reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const unitsSold = vendorOrders.filter(row => row.status !== 'cancelled').reduce((sum, row) => sum + (row.items || []).reduce((acc, item) => acc + item.quantity, 0), 0);
  const finance = mp.finance.summary({ days });
  const sellers = container.resolve('channel').sellers.repository.all();
  return {
    range: { days },
    currencyCode: finance.currencyCode,
    // Ventas del marketplace (GMV): lo que pagaron los compradores. No es ingreso propio.
    marketplaceSales: finance.marketplaceSales,
    orders: { total: orders.length, cancelled: orders.filter(row => row.status === 'cancelled').length, vendorOrders: vendorOrders.length },
    unitsSold,
    sellers: {
      active: sellers.filter(row => row.status === 'active').length,
      pending: sellers.filter(row => row.status === 'pending').length,
      suspended: sellers.filter(row => row.status === 'suspended').length,
    },
    buyers: new Set(orders.map(row => row.customerId || row.email).filter(Boolean)).size,
    products: { published: Object.values(byModel).reduce((sum, value) => sum + value, 0), byModel },
    // Ingresos de la plataforma: comisiones, ventas propias, publicidad y suscripciones.
    platformRevenue: finance.platformRevenue,
    // Ingresos de afiliados: comisiones de programas externos, por estado. Pendiente no es ingreso.
    affiliateRevenue: {
      pending: affiliateTotal('pending'),
      approved: affiliateTotal('approved'),
      paid: affiliateTotal('paid'),
      rejected: affiliateTotal('rejected'),
      // Los programas pagan en su moneda: los totales por moneda no se mezclan.
      byCurrency: commissions.reduce((acc, row) => {
        const code = row.currency || 'USD';
        acc[code] = acc[code] || { pending: 0, approved: 0, paid: 0, rejected: 0 };
        if (acc[code][row.status] !== undefined) acc[code][row.status] += Number(row.amount || 0);
        return acc;
      }, {}),
      note: 'Importes informados o estimados por programa, en su moneda de origen.',
    },
    // Margen de dropshipping: venta menos costo del proveedor.
    dropshipping: finance.dropshipping,
    sellerPayable: finance.sellerPayable,
    pendingApplications: store.collection('sellerApplications').filter(row => row.status === 'pending' && !row.deletedAt).length,
    openReports: store.collection('reports').filter(row => ['open', 'reviewing'].includes(row.status) && !row.deletedAt).length,
    unreadInbox: mp.inbox.unreadCount('staff', 'all'),
  };
}

function marketplaceAnalytics(container, days) {
  const store = container.resolve('store');
  const mp = container.resolve('marketplace');
  const since = Date.now() - days * 86_400_000;
  const recent = value => new Date(value).getTime() >= since;
  const events = store.collection('events').filter(event => recent(event.timestamp));
  const count = type => events.filter(event => event.type === type).length;
  const tally = (rows, keyOf) => {
    const map = new Map();
    for (const row of rows) {
      const key = keyOf(row);
      if (key) map.set(key, (map.get(key) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  };
  const products = new Map(store.collection('products').map(row => [row.id, row]));
  const sellers = new Map(store.collection('sellers').map(row => [row.id, row]));
  const categories = new Map(store.collection('categories').map(row => [row.id, row]));
  const vendorOrders = store.collection('vendorOrders').filter(row => recent(row.createdAt) && row.status !== 'cancelled');
  const soldItems = vendorOrders.flatMap(row => (row.items || []).map(item => ({ ...item, sellerId: row.sellerId })));
  const carts = store.collection('carts').filter(row => recent(row.createdAt));
  const views = count('product_view');
  const purchases = new Set(vendorOrders.map(row => row.orderId)).size;
  return {
    range: { days },
    note: 'Visitas, búsquedas y clics solo incluyen visitantes que aceptaron la analítica.',
    funnel: {
      productViews: views,
      searches: count('search'),
      affiliateClicks: count('affiliate_click'),
      favorites: store.collection('favorites').filter(row => !row.deletedAt && recent(row.createdAt)).length,
      cartsWithItems: carts.filter(row => (row.items || []).length).length,
      purchases,
      conversionRate: views ? Math.round((purchases / views) * 1000) / 10 : null,
      cartConversionRate: carts.filter(row => (row.items || []).length).length
        ? Math.round((purchases / carts.filter(row => (row.items || []).length).length) * 1000) / 10 : null,
    },
    topSearches: tally(events.filter(event => event.type === 'search'), event => String(event.term || event.metadata?.term || '').toLowerCase())
      .map(([term, total]) => ({ term, total })),
    emptySearches: container.resolve('search').emptySearches({ limit: 10 }),
    popularProducts: tally(events.filter(event => event.type === 'product_view'), event => event.productId)
      .map(([id, total]) => ({ id, name: products.get(id)?.name || id, views: total })),
    bestSellers: (() => {
      const map = new Map();
      for (const item of soldItems) map.set(item.productId, (map.get(item.productId) || 0) + item.quantity);
      return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, units]) => ({ id, name: products.get(id)?.name || id, units }));
    })(),
    popularSellers: (() => {
      const map = new Map();
      for (const row of vendorOrders) if (row.sellerId) map.set(row.sellerId, (map.get(row.sellerId) || 0) + row.total);
      return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, sales]) => ({ id, name: sellers.get(id)?.name || id, sales }));
    })(),
    popularCategories: (() => {
      const map = new Map();
      for (const item of soldItems) {
        const categoryId = products.get(item.productId)?.categoryId;
        if (categoryId) map.set(categoryId, (map.get(categoryId) || 0) + item.quantity);
      }
      return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, units]) => ({ id, name: categories.get(id)?.name || id, units }));
    })(),
    finance: mp.finance.summary({ days }),
  };
}
