/**
 * Modelos del marketplace multivendedor (v4).
 *
 * El marketplace **no** duplica catálogo, carrito, pedido ni pago: usa los del
 * núcleo. Lo que añade es lo que el núcleo no tenía:
 *
 *  - localidades jerárquicas (país → departamento → ciudad → zona) para crecer
 *    de una ciudad a todo el país sin tocar código;
 *  - membresías: qué cliente administra qué tienda (un usuario puede comprar y
 *    vender con la misma cuenta);
 *  - solicitudes de alta de vendedor con revisión;
 *  - reglas de comisión configurables por alcance;
 *  - subpedidos por vendedor/proveedor/plataforma bajo un pedido principal;
 *  - libro contable que separa ventas, ingresos propios, márgenes y pagos.
 */
import { defineResource } from '../base.js';
import { rule } from '../../framework/validate.js';

/** Estados del subpedido. Etiquetas visibles en `VENDOR_STATUS_LABELS`. */
export const VENDOR_STATUSES = [
  'created', 'payment_pending', 'paid', 'preparing', 'ready_to_ship',
  'shipped', 'in_transit', 'delivered', 'cancelled', 'returned',
];

export const VENDOR_STATUS_LABELS = {
  created: 'Creado',
  payment_pending: 'Pago pendiente',
  paid: 'Pagado',
  preparing: 'En preparación',
  ready_to_ship: 'Listo para envío',
  shipped: 'Enviado',
  in_transit: 'En tránsito',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
  returned: 'Devuelto',
};

export const VENDOR_TRANSITIONS = {
  created: ['payment_pending', 'paid', 'cancelled'],
  payment_pending: ['paid', 'preparing', 'cancelled'],
  paid: ['preparing', 'cancelled'],
  preparing: ['ready_to_ship', 'cancelled'],
  ready_to_ship: ['shipped', 'delivered', 'cancelled'],
  shipped: ['in_transit', 'delivered'],
  in_transit: ['delivered'],
  delivered: ['returned'],
  cancelled: [],
  returned: [],
};

/** Estados que una tienda puede aplicar por sí misma; el resto es de administración. */
export const SELLER_ALLOWED_TARGETS = new Set(['preparing', 'ready_to_ship', 'shipped', 'in_transit', 'delivered', 'cancelled']);

export const SELLER_STATUS_LABELS = {
  pending: 'Pendiente',
  active: 'Aprobado',
  rejected: 'Rechazado',
  suspended: 'Suspendido',
};

export const DELIVERY_MODE_LABELS = {
  pickup: 'Retiro en tienda',
  local_delivery: 'Entrega local',
  national_shipping: 'Envío nacional',
  supplier_shipping: 'Envío del proveedor',
};

/**
 * Tipos de asiento y flujo al que pertenecen. Cada flujo se informa por separado:
 * mezclar la venta de un vendedor con el ingreso de la plataforma es el error
 * que este libro existe para evitar.
 */
export const LEDGER_TYPES = {
  gmv: 'marketplace_sales',
  commission: 'platform_revenue',
  platform_discount: 'platform_revenue',
  own_sale: 'own_sales',
  seller_payable: 'seller_payable',
  supplier_payable: 'supplier_payable',
  dropship_margin: 'dropshipping_margin',
  advertising: 'advertising_revenue',
  subscription: 'subscription_revenue',
};

export const LEDGER_STREAMS = [...new Set(Object.values(LEDGER_TYPES))];

export const localityResource = defineResource({
  name: 'locality',
  collection: 'localities',
  prefix: 'loc',
  route: 'localities',
  unique: ['code'],
  searchable: ['name', 'code'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(120, { required: true }),
    type: rule.enumOf(['country', 'department', 'city', 'district'], { required: true }),
    parentId: rule.id(),
    countryCode: rule.country(),
    // `active`: se opera; `coming_soon`: visible como próxima; `hidden`: no se muestra.
    launchStatus: rule.enumOf(['active', 'coming_soon', 'hidden'], { default: 'coming_soon' }),
    description: rule.text(600),
    // Zonas generales (barrios, compañías). Nunca direcciones.
    areas: rule.list({ type: 'string', maxLength: 80 }, { default: [] }),
    center: {
      type: 'object',
      shape: {
        lat: { type: 'number', coerce: true, min: -90, max: 90 },
        lng: { type: 'number', coerce: true, min: -180, max: 180 },
      },
    },
    bounds: {
      type: 'object',
      shape: {
        north: { type: 'number', coerce: true, min: -90, max: 90 },
        south: { type: 'number', coerce: true, min: -90, max: 90 },
        east: { type: 'number', coerce: true, min: -180, max: 180 },
        west: { type: 'number', coerce: true, min: -180, max: 180 },
      },
    },
    rank: { type: 'integer', coerce: true, min: 0, max: 100000, default: 100 },
    metadata: rule.metadata(),
  },
});

/**
 * Sinónimos de búsqueda editables desde el panel. Nacen de lo que la gente escribe
 * y no encuentra: el informe de búsquedas sin resultado alimenta esta tabla.
 */
export const searchSynonymResource = defineResource({
  name: 'searchSynonym',
  collection: 'searchSynonyms',
  prefix: 'syn',
  route: 'search-synonyms',
  unique: ['term'],
  searchable: ['term'],
  fields: {
    term: rule.text(60, { required: true, lowercase: true }),
    equivalents: rule.list({ type: 'string', maxLength: 60 }, { required: true, maxItems: 20 }),
    notes: rule.text(200),
    active: rule.flag({ default: true }),
    metadata: rule.metadata(),
  },
});

/**
 * Aviso de reposición: quien no encontró stock deja su correo y se le avisa
 * cuando vuelve. Es demanda real, medible por producto, y evita que la visita
 * se pierda sin dejar rastro.
 */
export const stockAlertResource = defineResource({
  name: 'stockAlert',
  collection: 'stockAlerts',
  prefix: 'salrt',
  route: 'stock-alerts',
  searchable: ['email'],
  fields: {
    productId: rule.id({ required: true }),
    variantId: rule.id(),
    customerId: rule.id(),
    email: rule.email({ required: true }),
    status: rule.enumOf(['pending', 'notified', 'cancelled'], { default: 'pending' }),
    notifiedAt: rule.date(),
    metadata: rule.metadata(),
  },
});

export const sellerMemberResource = defineResource({
  name: 'sellerMember',
  collection: 'sellerMembers',
  prefix: 'smem',
  route: 'seller-members',
  searchable: ['sellerId', 'customerId'],
  fields: {
    sellerId: rule.id({ required: true }),
    customerId: rule.id({ required: true }),
    role: rule.enumOf(['owner', 'manager', 'staff'], { default: 'owner' }),
    status: rule.enumOf(['active', 'revoked'], { default: 'active' }),
    metadata: rule.metadata(),
  },
});

export const sellerApplicationResource = defineResource({
  name: 'sellerApplication',
  collection: 'sellerApplications',
  prefix: 'sapp',
  route: 'seller-applications',
  searchable: ['sellerId', 'customerId'],
  fields: {
    sellerId: rule.id({ required: true }),
    customerId: rule.id({ required: true }),
    status: rule.enumOf(['draft', 'pending', 'approved', 'rejected'], { default: 'draft' }),
    termsVersion: rule.text(20),
    termsAcceptedAt: rule.date(),
    submittedAt: rule.date(),
    reviewedAt: rule.date(),
    reviewerId: rule.id(),
    decisionNote: rule.text(600),
    checklist: { type: 'object', shape: {}, allowUnknown: true },
    metadata: rule.metadata(),
  },
});

export const sellerPlanResource = defineResource({
  name: 'sellerPlan',
  collection: 'sellerPlans',
  prefix: 'splan',
  route: 'seller-plans',
  unique: ['code'],
  searchable: ['name', 'code'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(80, { required: true }),
    description: rule.text(500),
    monthlyFee: rule.minor({ default: 0, min: 0 }),
    currencyCode: rule.currency({ default: 'PYG' }),
    maxProducts: { type: 'integer', coerce: true, min: 0, max: 100000 },
    // Si se define, actúa como regla de comisión a nivel de tienda.
    commissionPercent: rule.percent(),
    features: rule.list({ type: 'string', maxLength: 120 }, { default: [] }),
    active: rule.flag({ default: true }),
    rank: { type: 'integer', coerce: true, min: 0, default: 100 },
    metadata: rule.metadata(),
  },
});

export const COMMISSION_SCOPES = ['global', 'commercialModel', 'category', 'campaign', 'seller', 'product'];

export const commissionRuleResource = defineResource({
  name: 'commissionRule',
  collection: 'commissionRules',
  prefix: 'crule',
  route: 'commission-rules',
  searchable: ['name', 'scopeValue'],
  fields: {
    name: rule.text(120, { required: true }),
    scope: rule.enumOf(COMMISSION_SCOPES, { required: true }),
    // Identificador o código al que aplica (`LOCAL`, `pcat_…`, `sell_…`). Vacío en `global`.
    scopeValue: rule.text(80),
    percent: rule.percent({ default: 0 }),
    // Importe fijo por línea, en unidades mínimas de `currencyCode`.
    flat: rule.minor({ default: 0, min: 0 }),
    currencyCode: rule.currency({ default: 'PYG' }),
    priority: { type: 'integer', coerce: true, min: 0, max: 1000, default: 100 },
    startsAt: rule.date(),
    endsAt: rule.date(),
    active: rule.flag({ default: true }),
    notes: rule.text(500),
    metadata: rule.metadata(),
  },
});

export const vendorOrderResource = defineResource({
  name: 'vendorOrder',
  collection: 'vendorOrders',
  prefix: 'vord',
  route: 'vendor-orders',
  unique: ['code'],
  searchable: ['code', 'orderCode'],
  fields: {
    orderId: rule.id({ required: true }),
    orderCode: rule.text(40),
    code: rule.text(50),
    partyType: rule.enumOf(['seller', 'supplier', 'platform'], { required: true }),
    sellerId: rule.id(),
    supplierId: rule.id(),
    customerId: rule.id(),
    status: rule.enumOf(VENDOR_STATUSES, { default: 'created' }),
    currencyCode: rule.currency({ required: true }),
    items: { type: 'array', default: [] },
    subtotal: rule.minor({ default: 0 }),
    sellerDiscountTotal: rule.minor({ default: 0 }),
    platformDiscountTotal: rule.minor({ default: 0 }),
    shippingShare: rule.minor({ default: 0 }),
    total: rule.minor({ default: 0 }),
    commissionTotal: rule.minor({ default: 0 }),
    sellerPayout: rule.minor({ default: 0 }),
    supplierCost: rule.minor({ default: 0 }),
    platformMargin: rule.minor({ default: 0 }),
    deliveryMode: rule.text(40),
    groupKey: rule.text(80),
    shippingMethodName: rule.text(120),
    paymentProvider: rule.text(60),
    tracking: { type: 'object', shape: { carrier: rule.text(80), trackingNumber: rule.text(120), trackingUrl: rule.url() } },
    fulfillmentId: rule.id(),
    statusHistory: { type: 'array', default: [] },
    cancelledBy: rule.enumOf(['buyer', 'seller', 'supplier', 'admin', 'system']),
    cancelReason: rule.text(300),
    deliveredAt: rule.date(),
    metadata: rule.metadata(),
  },
});

export const ledgerEntryResource = defineResource({
  name: 'ledgerEntry',
  collection: 'ledgerEntries',
  prefix: 'led',
  route: 'ledger',
  softDelete: false,
  searchable: ['reference'],
  fields: {
    type: rule.enumOf(Object.keys(LEDGER_TYPES), { required: true }),
    stream: rule.enumOf(LEDGER_STREAMS, { required: true }),
    amount: rule.minor({ required: true }),
    currencyCode: rule.currency({ required: true }),
    // `accrued`: devengado; `confirmed`: firme (entregado o cobrado);
    // `reversed`: anulado; `paid`: liquidado a la tienda o al proveedor.
    status: rule.enumOf(['accrued', 'confirmed', 'reversed', 'paid'], { default: 'accrued' }),
    orderId: rule.id(),
    vendorOrderId: rule.id(),
    sellerId: rule.id(),
    supplierId: rule.id(),
    campaignId: rule.id(),
    payoutId: rule.id(),
    reference: rule.text(120),
    note: rule.text(300),
    occurredAt: rule.date(),
    metadata: rule.metadata(),
  },
});

export const sellerPayoutResource = defineResource({
  name: 'sellerPayout',
  collection: 'sellerPayouts',
  prefix: 'spay',
  route: 'seller-payouts',
  searchable: ['sellerId', 'reference'],
  fields: {
    sellerId: rule.id({ required: true }),
    amount: rule.minor({ required: true, min: 0 }),
    currencyCode: rule.currency({ required: true }),
    entryIds: rule.list({ type: 'string' }, { default: [] }),
    status: rule.enumOf(['pending', 'paid', 'cancelled'], { default: 'pending' }),
    method: rule.text(80),
    reference: rule.text(120),
    paidAt: rule.date(),
    note: rule.text(300),
    metadata: rule.metadata(),
  },
});
