/**
 * Envío y fulfillment (M-0671 … M-0690).
 *
 * Estructura de Medusa: perfiles de envío, conjuntos de fulfillment con zonas de
 * servicio, opciones con reglas de elegibilidad, y fulfillments con su máquina de
 * estados. La integración con un transportista real queda pendiente de credenciales
 * (M-0687): la etiqueta se genera como documento local, sin llamar a nadie.
 */
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule } from '../../framework/validate.js';
import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '../../framework/errors.js';
import { id as generateId } from '../../framework/ids.js';
import { now, plusDays } from '../../framework/dates.js';

export const FULFILLMENT_STATES = ['pending', 'packed', 'shipped', 'delivered', 'cancelled'];
export const FULFILLMENT_TRANSITIONS = {
  pending: ['packed', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

export const shippingProfileResource = defineResource({
  name: 'shippingProfile',
  collection: 'shippingProfiles',
  prefix: 'sprof',
  route: 'shipping-profiles',
  unique: ['code'],
  searchable: ['name', 'code'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(120, { required: true }),
    type: rule.enumOf(['default', 'oversized', 'digital', 'fragile', 'cold_chain'], { default: 'default' }),
    description: rule.text(300),
    metadata: rule.metadata(),
  },
});

export const fulfillmentSetResource = defineResource({
  name: 'fulfillmentSet',
  collection: 'fulfillmentSets',
  prefix: 'fset',
  route: 'fulfillment-sets',
  unique: ['code'],
  searchable: ['name', 'code'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(120, { required: true }),
    type: rule.enumOf(['shipping', 'pickup'], { default: 'shipping' }),
    locationId: rule.id(),
    active: rule.flag({ default: true }),
    metadata: rule.metadata(),
  },
});

export const serviceZoneResource = defineResource({
  name: 'serviceZone',
  collection: 'serviceZones',
  prefix: 'szone',
  route: 'service-zones',
  searchable: ['name'],
  fields: {
    fulfillmentSetId: rule.id({ required: true }),
    name: rule.text(120, { required: true }),
    zoneIds: rule.list({ type: 'string' }, { default: [] }),
    countryCodes: rule.list({ type: 'string' }, { default: [] }),
    // Plazo estimado de entrega por zona (M-0688).
    estimatedDaysMin: { type: 'integer', coerce: true, min: 0, max: 365 },
    estimatedDaysMax: { type: 'integer', coerce: true, min: 0, max: 365 },
    active: rule.flag({ default: true }),
    metadata: rule.metadata(),
  },
});

export const shippingOptionResource = defineResource({
  name: 'shippingOption',
  collection: 'shippingOptions',
  prefix: 'sopt',
  route: 'shipping-options',
  unique: ['code'],
  searchable: ['name', 'code'],
  translatable: ['name', 'description'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(120, { required: true }),
    description: rule.text(300),
    serviceZoneId: rule.id({ required: true }),
    shippingProfileId: rule.id(),
    provider: rule.enumOf(['manual', 'pickup', 'external'], { default: 'manual' }),
    // `flat` importe fijo; `weight` por tramos de peso; `item` por número de artículos;
    // `free_over` gratis por encima de un umbral (M-0674, M-0676 … M-0678).
    priceType: rule.enumOf(['flat', 'weight', 'item', 'free_over', 'free'], { default: 'flat' }),
    amount: rule.minor({ default: 0 }),
    currencyCode: rule.currency(),
    freeOverAmount: rule.minor(),
    perItemAmount: rule.minor({ default: 0 }),
    weightTiers: rule.list({
      type: 'object',
      shape: {
        maxWeight: { type: 'number', coerce: true, required: true, min: 0 },
        amount: rule.minor({ required: true }),
      },
    }, { default: [] }),
    minSubtotal: rule.minor(),
    maxSubtotal: rule.minor(),
    maxWeight: { type: 'number', coerce: true, min: 0 },
    channelIds: rule.list({ type: 'string' }, { default: [] }),
    customerGroupIds: rule.list({ type: 'string' }, { default: [] }),
    taxable: rule.flag({ default: true }),
    rank: { type: 'integer', coerce: true, min: 0, default: 100 },
    active: rule.flag({ default: true }),
    metadata: rule.metadata(),
  },
});

export const fulfillmentResource = defineResource({
  name: 'fulfillment',
  collection: 'fulfillments',
  prefix: 'ful',
  route: 'fulfillments',
  searchable: ['trackingNumber', 'orderId'],
  fields: {
    orderId: rule.id({ required: true }),
    locationId: rule.id(),
    shippingOptionId: rule.id(),
    provider: rule.text(60, { default: 'manual' }),
    items: rule.list({
      type: 'object',
      shape: {
        lineItemId: rule.id({ required: true }),
        quantity: rule.quantity({ required: true, min: 1 }),
      },
    }, { required: true }),
    packages: rule.list({
      type: 'object',
      shape: {
        reference: rule.text(80),
        weight: { type: 'number', coerce: true, min: 0 },
        length: { type: 'number', coerce: true, min: 0 },
        width: { type: 'number', coerce: true, min: 0 },
        height: { type: 'number', coerce: true, min: 0 },
      },
    }, { default: [] }),
    status: rule.enumOf(FULFILLMENT_STATES, { default: 'pending' }),
    carrier: rule.text(80),
    trackingNumber: rule.text(120),
    trackingUrl: rule.url(),
    instructions: rule.text(300),
    packedAt: rule.date(),
    shippedAt: rule.date(),
    deliveredAt: rule.date(),
    cancelledAt: rule.date(),
    estimatedDeliveryAt: rule.date(),
    metadata: rule.metadata(),
  },
});

export class ShippingOptionService extends BaseService {
  constructor(deps) {
    super(deps, shippingOptionResource);
    this.zones = deps.zones;
    this.geography = deps.geography;
    this.catalog = deps.catalog;
  }

  /** Peso total del carrito, normalizado a gramos. */
  totalWeight(items) {
    return (items || []).reduce((sum, item) => {
      const variant = this.catalog.variants.repository.byId(item.variantId);
      if (!variant?.weight) return sum;
      const grams = variant.weightUnit === 'kg' ? variant.weight * 1000
        : variant.weightUnit === 'lb' ? variant.weight * 453.592
          : variant.weightUnit === 'oz' ? variant.weight * 28.3495
            : variant.weight;
      return sum + grams * item.quantity;
    }, 0);
  }

  /** Precio de la opción para un contexto concreto. */
  priceFor(option, { subtotal = 0, itemCount = 0, weight = 0 }) {
    switch (option.priceType) {
      case 'free':
        return 0;
      case 'free_over':
        return option.freeOverAmount !== null && subtotal >= option.freeOverAmount ? 0 : option.amount || 0;
      case 'item':
        return (option.amount || 0) + (option.perItemAmount || 0) * itemCount;
      case 'weight': {
        const tier = [...(option.weightTiers || [])]
          .sort((a, b) => a.maxWeight - b.maxWeight)
          .find(entry => weight <= entry.maxWeight);
        return tier ? tier.amount : option.amount || 0;
      }
      default:
        return option.amount || 0;
    }
  }

  /** Opciones elegibles para una dirección y un carrito (M-0675, M-0690). */
  eligible({ address = {}, items = [], subtotal = 0, channelId = null, customerGroupIds = [], currencyCode = null }) {
    const zone = this.geography.zones.resolve(address);
    const weight = this.totalWeight(items);
    const itemCount = (items || []).reduce((sum, item) => sum + item.quantity, 0);
    const profileIds = new Set((items || [])
      .map(item => this.catalog.products.repository.byId(item.productId)?.shippingProfileId)
      .filter(Boolean));

    const serviceZones = this.zones.repository.all({ active: true }).filter(serviceZone => {
      if (serviceZone.zoneIds?.length && zone && serviceZone.zoneIds.includes(zone.id)) return true;
      if (serviceZone.countryCodes?.length && address.countryCode) {
        return serviceZone.countryCodes.includes(String(address.countryCode).toLowerCase());
      }
      return !serviceZone.zoneIds?.length && !serviceZone.countryCodes?.length;
    });
    const zoneIds = new Set(serviceZones.map(serviceZone => serviceZone.id));

    return this.repository
      .all({ active: true })
      .filter(option => zoneIds.has(option.serviceZoneId))
      .filter(option => !option.channelIds?.length || (channelId && option.channelIds.includes(channelId)))
      .filter(option => !option.customerGroupIds?.length || option.customerGroupIds.some(groupId => customerGroupIds.includes(groupId)))
      .filter(option => !option.currencyCode || !currencyCode || option.currencyCode === currencyCode)
      .filter(option => option.minSubtotal === null || option.minSubtotal === undefined || subtotal >= option.minSubtotal)
      .filter(option => option.maxSubtotal === null || option.maxSubtotal === undefined || subtotal <= option.maxSubtotal)
      .filter(option => !option.maxWeight || weight <= option.maxWeight)
      // Si el carrito exige un perfil de envío concreto, la opción debe cubrirlo.
      .filter(option => !profileIds.size || !option.shippingProfileId || profileIds.has(option.shippingProfileId))
      .sort((a, b) => a.rank - b.rank)
      .map(option => {
        const serviceZone = this.zones.repository.byId(option.serviceZoneId);
        return {
          id: option.id,
          code: option.code,
          name: option.name,
          description: option.description,
          provider: option.provider,
          amount: this.priceFor(option, { subtotal, itemCount, weight }),
          currencyCode: option.currencyCode || currencyCode,
          taxable: option.taxable !== false,
          estimatedDaysMin: serviceZone?.estimatedDaysMin ?? null,
          estimatedDaysMax: serviceZone?.estimatedDaysMax ?? null,
          requiresCredentials: option.provider === 'external',
        };
      });
  }
}

export class FulfillmentService extends BaseService {
  constructor(deps) {
    super(deps, fulfillmentResource);
    this.orders = deps.orders;
    this.history = deps.history;
    this.inventory = deps.inventory;
    this.settings = deps.settings;
    this.notifications = deps.notifications;
    this.zones = deps.zones;
    this.options = deps.options;
  }

  assertEnabled() {
    this.settings.assertCapability('fulfillment');
  }

  /** Crea un fulfillment validando lo que queda por enviar (M-0684). */
  async createFor(orderId, { items, locationId = null, shippingOptionId = null, packages = [], instructions = null }, ctx = null) {
    this.assertEnabled();
    const order = this.orders.repository.retrieve(orderId);
    if (!['confirmed', 'processing', 'shipped'].includes(order.status)) {
      throw new ConflictError(`No se puede enviar un pedido en estado "${order.status}".`, { status: order.status });
    }

    for (const entry of items) {
      const line = (order.items || []).find(item => item.id === entry.lineItemId);
      if (!line) throw new NotFoundError('línea del pedido', entry.lineItemId);
      const pending = line.quantity - Number(line.fulfilledQuantity || 0);
      if (entry.quantity > pending) {
        throw new ConflictError(`Solo quedan ${pending} unidad(es) por enviar de ${line.title}.`, { lineItemId: line.id, pending });
      }
    }

    const option = shippingOptionId ? this.options.repository.byId(shippingOptionId) : null;
    const serviceZone = option ? this.zones.repository.byId(option.serviceZoneId) : null;

    const record = await this.create({
      orderId,
      locationId: locationId || this.inventory.locations.default()?.id || null,
      shippingOptionId,
      provider: option?.provider || 'manual',
      items,
      packages,
      instructions,
      status: 'pending',
      estimatedDeliveryAt: serviceZone?.estimatedDaysMax ? plusDays(now(), serviceZone.estimatedDaysMax) : null,
    }, ctx);

    await this.history.log({
      orderId,
      type: 'fulfillment_created',
      message: `Fulfillment creado con ${items.length} línea(s).`,
      data: { fulfillmentId: record.id },
    }, ctx);
    if (order.status === 'confirmed') await this.orders.transition(orderId, 'processing', ctx);
    return record;
  }

  assertTransition(fulfillment, target) {
    const allowed = FULFILLMENT_TRANSITIONS[fulfillment.status] || [];
    if (!allowed.includes(target)) throw new InvalidStateError('el envío', fulfillment.status, target, allowed);
    return true;
  }

  async pack(fulfillmentId, { packages = [] } = {}, ctx = null) {
    const fulfillment = this.repository.retrieve(fulfillmentId);
    this.assertTransition(fulfillment, 'packed');
    const result = await this.store.transaction(state => this.repository.patch(state, fulfillmentId, {
      status: 'packed',
      packedAt: now(),
      packages: packages.length ? packages : fulfillment.packages,
    }));
    return result.after;
  }

  /** Al enviar, la reserva se convierte en venta y el pedido avanza (M-0500). */
  async ship(fulfillmentId, { carrier = null, trackingNumber = null, trackingUrl = null } = {}, ctx = null) {
    const fulfillment = this.repository.retrieve(fulfillmentId);
    if (fulfillment.status === 'pending') await this.pack(fulfillmentId, {}, ctx);
    const current = this.repository.retrieve(fulfillmentId);
    this.assertTransition(current, 'shipped');

    const order = this.orders.repository.retrieve(fulfillment.orderId);
    for (const entry of fulfillment.items) {
      await this.inventory.service.consume({ reference: order.id, lineItemId: entry.lineItemId }, ctx);
    }

    const items = (order.items || []).map(line => {
      const entry = fulfillment.items.find(item => item.lineItemId === line.id);
      return entry ? { ...line, fulfilledQuantity: Number(line.fulfilledQuantity || 0) + entry.quantity } : line;
    });

    await this.store.transaction(state => {
      this.repository.patch(state, fulfillmentId, {
        status: 'shipped',
        shippedAt: now(),
        carrier,
        trackingNumber,
        trackingUrl,
      });
      this.orders.repository.patch(state, order.id, { items });
    });

    const refreshed = await this.orders.refreshTotals(order.id, ctx);
    if (refreshed.fulfillmentStatus === 'fulfilled' && refreshed.status !== 'shipped') {
      await this.orders.transition(order.id, 'shipped', ctx);
    }

    await this.history.log({
      orderId: order.id,
      type: 'fulfillment_shipped',
      message: `Envío realizado${carrier ? ` con ${carrier}` : ''}${trackingNumber ? ` (seguimiento ${trackingNumber})` : ''}.`,
      internal: false,
      data: { fulfillmentId },
    }, ctx);
    await this.notifications?.send({
      template: 'order.shipped',
      to: order.email,
      entityId: order.id,
      data: { code: order.code, carrier: carrier || 'transporte propio', tracking: trackingNumber || 'sin seguimiento' },
    });

    return this.repository.retrieve(fulfillmentId);
  }

  async deliver(fulfillmentId, ctx = null) {
    const fulfillment = this.repository.retrieve(fulfillmentId);
    this.assertTransition(fulfillment, 'delivered');
    const result = await this.store.transaction(state => this.repository.patch(state, fulfillmentId, {
      status: 'delivered',
      deliveredAt: now(),
    }));
    const order = this.orders.repository.retrieve(fulfillment.orderId);
    const siblings = this.repository.all({ orderId: order.id });
    if (siblings.every(entry => ['delivered', 'cancelled'].includes(entry.status)) && order.status === 'shipped') {
      await this.orders.transition(order.id, 'delivered', ctx);
    }
    return result.after;
  }

  /** Cancelar un fulfillment repone el stock si aún no se envió (M-0685). */
  async cancel(fulfillmentId, reason, ctx = null) {
    const fulfillment = this.repository.retrieve(fulfillmentId);
    this.assertTransition(fulfillment, 'cancelled');
    const result = await this.store.transaction(state => this.repository.patch(state, fulfillmentId, {
      status: 'cancelled',
      cancelledAt: now(),
      metadata: { ...(fulfillment.metadata || {}), cancelReason: reason || null },
    }));
    await this.history.log({
      orderId: fulfillment.orderId,
      type: 'fulfillment_cancelled',
      message: `Envío cancelado. Motivo: ${reason || 'sin especificar'}.`,
      data: { fulfillmentId },
    }, ctx);
    return result.after;
  }

  /**
   * Documento de envío local. No llama a ningún transportista: sin credenciales, una
   * etiqueta «real» sería un papel sin validez (M-0686, M-0687).
   */
  packingSlip(fulfillmentId) {
    const fulfillment = this.repository.retrieve(fulfillmentId);
    const order = this.orders.repository.retrieve(fulfillment.orderId);
    return {
      documentType: 'packing_slip',
      note: 'Documento interno de preparación. No es una etiqueta de transportista ni un comprobante fiscal.',
      generatedAt: now(),
      fulfillmentId,
      orderCode: order.code,
      shippingAddress: order.shippingAddress || {},
      carrier: fulfillment.carrier || null,
      trackingNumber: fulfillment.trackingNumber || null,
      lines: fulfillment.items.map(entry => {
        const line = (order.items || []).find(item => item.id === entry.lineItemId);
        return { sku: line?.sku || null, title: line?.title || entry.lineItemId, quantity: entry.quantity };
      }),
      packages: fulfillment.packages || [],
    };
  }
}

const SEED_PROFILES = [
  { id: 'sprof_default', code: 'estandar', name: 'Envío estándar', type: 'default' },
  { id: 'sprof_digital', code: 'digital', name: 'Entrega digital', type: 'digital' },
  { id: 'sprof_oversized', code: 'voluminoso', name: 'Envío voluminoso', type: 'oversized' },
];

const SEED_SETS = [
  { id: 'fset_shipping', code: 'envio', name: 'Envío a domicilio', type: 'shipping', locationId: 'sloc_main', active: true },
  { id: 'fset_pickup', code: 'retiro', name: 'Retiro en tienda', type: 'pickup', locationId: 'sloc_main', active: true },
];

const SEED_ZONES = [
  { id: 'szone_py', fulfillmentSetId: 'fset_shipping', name: 'Paraguay', zoneIds: ['zone_py'], estimatedDaysMin: 1, estimatedDaysMax: 4, active: true },
  { id: 'szone_latam', fulfillmentSetId: 'fset_shipping', name: 'Latinoamérica', zoneIds: ['zone_latam'], estimatedDaysMin: 5, estimatedDaysMax: 15, active: true },
  { id: 'szone_pickup', fulfillmentSetId: 'fset_pickup', name: 'Retiro local', zoneIds: ['zone_py'], estimatedDaysMin: 0, estimatedDaysMax: 1, active: true },
];

const SEED_OPTIONS = [
  {
    id: 'sopt_py_standard', code: 'py-estandar', name: 'Envío estándar Paraguay', serviceZoneId: 'szone_py',
    shippingProfileId: 'sprof_default', priceType: 'free_over', amount: 3500000, freeOverAmount: 50000000,
    currencyCode: 'PYG', rank: 10, active: true,
    description: 'Entrega en 1 a 4 días hábiles. Gratis por encima del umbral configurado.',
  },
  {
    id: 'sopt_py_pickup', code: 'py-retiro', name: 'Retiro en tienda', serviceZoneId: 'szone_pickup',
    shippingProfileId: 'sprof_default', provider: 'pickup', priceType: 'free', amount: 0, rank: 5, active: true,
    description: 'Retira el pedido en el punto de recogida sin coste.',
  },
  {
    id: 'sopt_latam', code: 'latam-estandar', name: 'Envío internacional', serviceZoneId: 'szone_latam',
    shippingProfileId: 'sprof_default', priceType: 'weight', amount: 2500,
    weightTiers: [{ maxWeight: 1000, amount: 2500 }, { maxWeight: 5000, amount: 6000 }, { maxWeight: 20000, amount: 15000 }],
    currencyCode: 'USD', rank: 20, active: true,
    description: 'Tarifa por tramos de peso. Plazo estimado de 5 a 15 días.',
  },
];

export default {
  name: 'fulfillment',
  requires: [
    'store', 'events', 'audit', 'config', 'customFields', 'translations', 'settings',
    'geography', 'catalog', 'inventory', 'order', 'notifications',
  ],
  resources: [shippingProfileResource, fulfillmentSetResource, serviceZoneResource, shippingOptionResource, fulfillmentResource],
  permissions: [
    { resource: 'fulfillment', description: 'Envíos y preparación.' },
    { resource: 'shippingProfile', description: 'Perfiles de envío.' },
    { resource: 'fulfillmentSet', description: 'Conjuntos de fulfillment.' },
    { resource: 'serviceZone', description: 'Zonas de servicio.' },
    { resource: 'shippingOption', description: 'Opciones de envío.' },
  ],

  register(deps) {
    const profiles = new BaseService(deps, shippingProfileResource);
    const sets = new BaseService(deps, fulfillmentSetResource);
    const zones = new BaseService(deps, serviceZoneResource);
    const options = new ShippingOptionService({ ...deps, zones });
    const fulfillments = new FulfillmentService({
      ...deps,
      zones,
      options,
      orders: deps.order.orders,
      history: deps.order.history,
    });
    return { profiles, sets, zones, options, fulfillments };
  },

  async seed(service) {
    await service.profiles.seed(SEED_PROFILES, 'id');
    await service.sets.seed(SEED_SETS, 'id');
    await service.zones.seed(SEED_ZONES, 'id');
    await service.options.seed(SEED_OPTIONS, 'id');
  },

  routes: {
    admin: container => {
      const module = () => container.resolve('fulfillment');
      return [
        ...crudRoutes(shippingProfileResource, () => module().profiles, { tags: ['envíos'] }),
        ...crudRoutes(fulfillmentSetResource, () => module().sets, { tags: ['envíos'] }),
        ...crudRoutes(serviceZoneResource, () => module().zones, { tags: ['envíos'] }),
        ...crudRoutes(shippingOptionResource, () => module().options, { tags: ['envíos'] }),
        ...crudRoutes(fulfillmentResource, () => module().fulfillments, { tags: ['envíos'] }),
        {
          method: 'POST',
          path: '/orders/:id/fulfillments',
          permission: 'fulfillment:create',
          summary: 'Crea un envío para las líneas indicadas.',
          tags: ['envíos'],
          status: 201,
          body: {
            items: rule.list({ type: 'object', shape: { lineItemId: rule.id({ required: true }), quantity: rule.quantity({ required: true, min: 1 }) } }, { required: true }),
            locationId: rule.id(),
            shippingOptionId: rule.id(),
            instructions: rule.text(300),
            packages: rule.list({ type: 'object', shape: { reference: rule.text(80), weight: { type: 'number', coerce: true, min: 0 } } }),
          },
          handler: ctx => module().fulfillments.createFor(ctx.params.id, ctx.body, ctx),
        },
        {
          method: 'POST',
          path: '/fulfillments/:id/pack',
          permission: 'fulfillment:update',
          summary: 'Marca el envío como preparado.',
          tags: ['envíos'],
          body: { packages: rule.list({ type: 'object', shape: { reference: rule.text(80), weight: { type: 'number', coerce: true, min: 0 } } }) },
          handler: ctx => module().fulfillments.pack(ctx.params.id, ctx.body, ctx),
        },
        {
          method: 'POST',
          path: '/fulfillments/:id/ship',
          permission: 'fulfillment:update',
          summary: 'Marca el envío como enviado y convierte la reserva en venta.',
          tags: ['envíos'],
          body: { carrier: rule.text(80), trackingNumber: rule.text(120), trackingUrl: rule.url() },
          handler: ctx => module().fulfillments.ship(ctx.params.id, ctx.body, ctx),
        },
        {
          method: 'POST',
          path: '/fulfillments/:id/deliver',
          permission: 'fulfillment:update',
          summary: 'Marca el envío como entregado.',
          tags: ['envíos'],
          handler: ctx => module().fulfillments.deliver(ctx.params.id, ctx),
        },
        {
          method: 'POST',
          path: '/fulfillments/:id/cancel',
          permission: 'fulfillment:update',
          summary: 'Cancela un envío no despachado.',
          tags: ['envíos'],
          body: { reason: rule.text(300) },
          handler: ctx => module().fulfillments.cancel(ctx.params.id, ctx.body.reason, ctx),
        },
        {
          method: 'GET',
          path: '/fulfillments/:id/packing-slip',
          permission: 'fulfillment:read',
          summary: 'Documento interno de preparación, sin validez fiscal.',
          tags: ['envíos'],
          bodyless: true,
          handler: ctx => module().fulfillments.packingSlip(ctx.params.id),
        },
      ];
    },

    store: container => {
      const module = () => container.resolve('fulfillment');
      return [
        {
          method: 'GET',
          path: '/carts/:id/shipping-options',
          permission: null,
          summary: 'Opciones de envío elegibles para el carrito.',
          tags: ['store'],
          bodyless: true,
          handler: ctx => {
            const cartService = container.resolve('cart');
            const cart = cartService.repository.retrieve(ctx.params.id);
            const customerGroupIds = cart.customerId ? container.resolve('customer').customers.groupsFor(cart.customerId) : [];
            const data = module().options.eligible({
              address: cart.shippingAddress || {},
              items: cart.items || [],
              subtotal: cart.subtotal || 0,
              channelId: cart.channelId,
              currencyCode: cart.currencyCode,
              customerGroupIds,
            });
            return { data, count: data.length };
          },
        },
        {
          method: 'POST',
          path: '/carts/:id/shipping-method',
          permission: null,
          csrf: false,
          summary: 'Selecciona una opción de envío para el carrito.',
          tags: ['store'],
          body: { shippingOptionId: rule.id({ required: true }) },
          handler: async ctx => {
            const cartService = container.resolve('cart');
            const cart = cartService.repository.retrieve(ctx.params.id);
            const customerGroupIds = cart.customerId ? container.resolve('customer').customers.groupsFor(cart.customerId) : [];
            const available = module().options.eligible({
              address: cart.shippingAddress || {},
              items: cart.items || [],
              subtotal: cart.subtotal || 0,
              channelId: cart.channelId,
              currencyCode: cart.currencyCode,
              customerGroupIds,
            });
            const chosen = available.find(option => option.id === ctx.body.shippingOptionId);
            if (!chosen) {
              throw ValidationError.single('shippingOptionId', 'La opción de envío no está disponible para este carrito.');
            }
            if (chosen.requiresCredentials) {
              throw new ConflictError('Esta opción requiere credenciales de transportista que no están configuradas.', { optionId: chosen.id });
            }
            const updated = await cartService.setShippingMethod(ctx.params.id, {
              id: generateId('smeth'),
              shippingOptionId: chosen.id,
              name: chosen.name,
              amount: chosen.amount,
              taxable: chosen.taxable,
              estimatedDaysMin: chosen.estimatedDaysMin,
              estimatedDaysMax: chosen.estimatedDaysMax,
            }, ctx);
            return cartService.publicView(updated);
          },
        },
      ];
    },
  },
};
