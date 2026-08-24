/**
 * Pedidos (M-0611 … M-0650, M-0691 … M-0730).
 *
 * Reúne pedido, borrador, historial, devoluciones, cambios, reclamaciones y
 * reembolsos, igual que el módulo `order` de Medusa: son un mismo agregado y
 * comparten la máquina de estados.
 *
 * Al confirmar, el pedido **congela** precio, descuento e impuesto de cada línea
 * (M-0650): un cambio posterior de catálogo no debe alterar un pedido cerrado.
 */
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule } from '../../framework/validate.js';
import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '../../framework/errors.js';
import { add, clampToZero } from '../../framework/money.js';
import { humanCode, id as generateId } from '../../framework/ids.js';
import { ageInDays, now } from '../../framework/dates.js';

export const ORDER_STATUSES = ['draft', 'pending', 'confirmed', 'processing', 'shipped', 'delivered', 'completed', 'cancelled'];
export const PAYMENT_STATUSES = ['unpaid', 'authorized', 'partially_paid', 'paid', 'partially_refunded', 'refunded'];
export const FULFILLMENT_STATUSES = ['not_fulfilled', 'partially_fulfilled', 'fulfilled', 'partially_returned', 'returned'];

/** Transiciones permitidas (M-0612, M-0616). */
export const ORDER_TRANSITIONS = {
  draft: ['pending', 'cancelled'],
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'shipped', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered', 'completed'],
  delivered: ['completed'],
  completed: [],
  cancelled: [],
};

const FINAL_STATUSES = new Set(['completed', 'cancelled']);

export const orderResource = defineResource({
  name: 'order',
  collection: 'orders',
  prefix: 'order',
  route: 'orders',
  unique: ['code'],
  searchable: ['code', 'email'],
  fields: {
    code: rule.text(40),
    cartId: rule.id(),
    channelId: rule.id(),
    regionId: rule.id(),
    currencyCode: rule.currency({ required: true }),
    customerId: rule.id(),
    email: rule.email(),
    status: rule.enumOf(ORDER_STATUSES, { default: 'pending' }),
    paymentStatus: rule.enumOf(PAYMENT_STATUSES, { default: 'unpaid' }),
    fulfillmentStatus: rule.enumOf(FULFILLMENT_STATUSES, { default: 'not_fulfilled' }),
    items: { type: 'array', default: [] },
    shippingAddress: { type: 'object', shape: {}, allowUnknown: true },
    billingAddress: { type: 'object', shape: {}, allowUnknown: true },
    shippingMethods: { type: 'array', default: [] },
    surcharges: { type: 'array', default: [] },
    appliedPromotions: { type: 'array', default: [] },
    taxBreakdown: { type: 'array', default: [] },
    transactions: { type: 'array', default: [] },
    creditLines: { type: 'array', default: [] },
    sellerBreakdown: { type: 'array', default: [] },
    subtotal: rule.minor({ default: 0 }),
    discountTotal: rule.minor({ default: 0 }),
    shippingTotal: rule.minor({ default: 0 }),
    taxTotal: rule.minor({ default: 0 }),
    surchargeTotal: rule.minor({ default: 0 }),
    total: rule.minor({ default: 0 }),
    paidTotal: rule.minor({ default: 0 }),
    refundedTotal: rule.minor({ default: 0 }),
    giftCardTotal: rule.minor({ default: 0 }),
    outstandingTotal: rule.minor({ default: 0 }),
    taxInclusive: rule.flag({ default: false }),
    note: rule.text(1000),
    internalNote: rule.text(2000),
    tags: rule.list({ type: 'string' }, { default: [] }),
    cancelReason: rule.text(300),
    placedAt: rule.date(),
    confirmedAt: rule.date(),
    completedAt: rule.date(),
    cancelledAt: rule.date(),
    idempotencyKey: rule.text(120),
    metadata: rule.metadata(),
  },
});

export const historyResource = defineResource({
  name: 'historyEntry',
  collection: 'historyEntries',
  prefix: 'hist',
  route: 'history',
  softDelete: false,
  searchable: ['type', 'message'],
  fields: {
    orderId: rule.id(),
    customerId: rule.id(),
    type: rule.text(60, { required: true }),
    message: rule.text(600),
    // `internal` no se muestra al cliente (M-0626).
    internal: rule.flag({ default: true }),
    actorId: rule.id(),
    data: rule.metadata(),
  },
});

export const returnReasonResource = defineResource({
  name: 'returnReason',
  collection: 'returnReasons',
  prefix: 'rreason',
  route: 'return-reasons',
  unique: ['code'],
  searchable: ['label', 'code'],
  translatable: ['label'],
  fields: {
    code: rule.handle({ required: true }),
    label: rule.text(120, { required: true }),
    description: rule.text(300),
    requiresEvidence: rule.flag({ default: false }),
    restockByDefault: rule.flag({ default: true }),
    metadata: rule.metadata(),
  },
});

export const returnResource = defineResource({
  name: 'return',
  collection: 'returns',
  prefix: 'ret',
  route: 'returns',
  searchable: ['orderId'],
  fields: {
    orderId: rule.id({ required: true }),
    items: rule.list({
      type: 'object',
      shape: {
        lineItemId: rule.id({ required: true }),
        quantity: rule.quantity({ required: true, min: 1 }),
        reasonId: rule.id(),
        note: rule.text(300),
        receivedQuantity: rule.quantity(),
        condition: rule.enumOf(['new', 'damaged', 'used', 'missing']),
        restock: rule.flag(),
      },
    }, { required: true }),
    status: rule.enumOf(['requested', 'approved', 'rejected', 'received', 'closed'], { default: 'requested' }),
    reasonId: rule.id(),
    note: rule.text(600),
    shippingCost: rule.minor({ default: 0 }),
    refundAmount: rule.minor({ default: 0 }),
    refundId: rule.id(),
    requestedBy: rule.enumOf(['customer', 'operator'], { default: 'customer' }),
    approvedAt: rule.date(),
    receivedAt: rule.date(),
    closedAt: rule.date(),
    rejectionReason: rule.text(300),
    metadata: rule.metadata(),
  },
});

export const exchangeResource = defineResource({
  name: 'exchange',
  collection: 'exchanges',
  prefix: 'exch',
  route: 'exchanges',
  searchable: ['orderId'],
  fields: {
    orderId: rule.id({ required: true }),
    returnId: rule.id(),
    returnItems: rule.list({ type: 'object', shape: { lineItemId: rule.id({ required: true }), quantity: rule.quantity({ required: true }) } }, { default: [] }),
    replacementItems: rule.list({ type: 'object', shape: { variantId: rule.id({ required: true }), quantity: rule.quantity({ required: true }) } }, { default: [] }),
    status: rule.enumOf(['requested', 'approved', 'shipped', 'closed', 'rejected'], { default: 'requested' }),
    difference: rule.minor({ default: 0 }),
    differenceDirection: rule.enumOf(['charge', 'refund', 'none'], { default: 'none' }),
    note: rule.text(600),
    metadata: rule.metadata(),
  },
});

export const claimResource = defineResource({
  name: 'claim',
  collection: 'claims',
  prefix: 'claim',
  route: 'claims',
  searchable: ['orderId'],
  fields: {
    orderId: rule.id({ required: true }),
    type: rule.enumOf(['damaged', 'missing', 'wrong_item', 'not_as_described', 'other'], { required: true }),
    items: rule.list({ type: 'object', shape: { lineItemId: rule.id({ required: true }), quantity: rule.quantity({ required: true }), note: rule.text(300) } }, { required: true }),
    evidenceAssetIds: rule.list({ type: 'string' }, { default: [] }),
    description: rule.text(1000),
    status: rule.enumOf(['open', 'in_review', 'resolved', 'rejected'], { default: 'open' }),
    resolution: rule.enumOf(['replacement', 'refund', 'partial_refund', 'rejected', 'none'], { default: 'none' }),
    resolutionNote: rule.text(600),
    resolvedAt: rule.date(),
    metadata: rule.metadata(),
  },
});

export const refundResource = defineResource({
  name: 'refund',
  collection: 'refunds',
  prefix: 'refund',
  route: 'refunds',
  searchable: ['orderId'],
  fields: {
    orderId: rule.id({ required: true }),
    paymentId: rule.id(),
    returnId: rule.id(),
    claimId: rule.id(),
    amount: rule.minor({ required: true, min: 1 }),
    currencyCode: rule.currency({ required: true }),
    reason: rule.text(300, { required: true }),
    status: rule.enumOf(['pending', 'completed', 'failed'], { default: 'pending' }),
    providerReference: rule.text(200),
    processedAt: rule.date(),
    metadata: rule.metadata(),
  },
});

export const draftOrderResource = defineResource({
  name: 'draftOrder',
  collection: 'draftOrders',
  prefix: 'draft',
  route: 'draft-orders',
  searchable: ['email'],
  fields: {
    channelId: rule.id(),
    regionId: rule.id(),
    currencyCode: rule.currency({ required: true }),
    customerId: rule.id(),
    email: rule.email(),
    items: rule.list({
      type: 'object',
      shape: {
        variantId: rule.id({ required: true }),
        quantity: rule.quantity({ required: true, min: 1 }),
        unitPrice: rule.minor(),
      },
    }, { default: [] }),
    shippingAddress: { type: 'object', shape: {}, allowUnknown: true },
    billingAddress: { type: 'object', shape: {}, allowUnknown: true },
    shippingAmount: rule.minor({ default: 0 }),
    note: rule.text(1000),
    status: rule.enumOf(['open', 'converted', 'cancelled'], { default: 'open' }),
    orderId: rule.id(),
    metadata: rule.metadata(),
  },
});

export class HistoryService extends BaseService {
  constructor(deps) {
    super(deps, historyResource);
  }

  async log({ orderId = null, customerId = null, type, message, internal = true, data = {} }, ctx = null) {
    return this.create({
      orderId, customerId, type, message, internal, data, actorId: ctx?.actor?.id || null,
    }, ctx);
  }

  forOrder(orderId, { includeInternal = true } = {}) {
    return this.repository
      .all({ orderId })
      .filter(entry => includeInternal || !entry.internal)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
}

export class OrderService extends BaseService {
  constructor(deps) {
    super(deps, orderResource);
    this.settings = deps.settings;
    this.history = deps.history;
    this.inventory = deps.inventory;
    this.promotion = deps.promotion;
    this.channel = deps.channel;
    this.geography = deps.geography;
    this.notifications = deps.notifications;
    this.catalog = deps.catalog;
    this.alerts = deps.alert;
  }

  assertEnabled() {
    this.settings.assertCapability('order');
  }

  /** Estrategia de código de pedido, reemplazable (M-0611, M-0632). */
  generateCode() {
    const prefix = this.settings.get('order.codePrefix', 'ND');
    let code = humanCode(prefix, 8);
    let guard = 0;
    while (this.repository.find({ code }) && guard < 20) {
      code = humanCode(prefix, 8);
      guard += 1;
    }
    return code;
  }

  byCode(code) {
    return this.repository.find({ code: String(code || '').toUpperCase() })
      || this.repository.find({ code });
  }

  assertTransition(order, target) {
    const allowed = ORDER_TRANSITIONS[order.status] || [];
    if (!allowed.includes(target)) throw new InvalidStateError('el pedido', order.status, target, allowed);
    return true;
  }

  /** Recalcula los totales derivados del pedido (M-0622). */
  computeTotals(order) {
    const subtotal = (order.items || []).reduce((sum, item) => sum + Number(item.total || 0), 0);
    const discountTotal = (order.items || []).reduce((sum, item) => sum + Number(item.discountTotal || 0), 0)
      + (order.appliedPromotions || [])
        .filter(promotion => promotion.target === 'shipping')
        .reduce((sum, promotion) => sum + Number(promotion.amount || 0), 0);
    const shippingTotal = (order.shippingMethods || []).reduce((sum, method) => sum + Number(method.amount || 0), 0);
    const surchargeTotal = (order.surcharges || []).reduce((sum, surcharge) => sum + Number(surcharge.amount || 0), 0);
    const taxTotal = order.taxInclusive ? 0 : (order.items || []).reduce((sum, item) => sum + Number(item.taxTotal || 0), 0);
    const total = clampToZero(add(subtotal, -discountTotal, shippingTotal, taxTotal, surchargeTotal));

    const paidTotal = (order.transactions || [])
      .filter(transaction => transaction.type === 'capture' && transaction.status === 'completed')
      .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
    const refundedTotal = (order.transactions || [])
      .filter(transaction => transaction.type === 'refund' && transaction.status === 'completed')
      .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
    const creditTotal = (order.creditLines || []).reduce((sum, line) => sum + Number(line.amount || 0), 0);

    return {
      subtotal,
      discountTotal,
      shippingTotal,
      surchargeTotal,
      taxTotal,
      total,
      paidTotal,
      refundedTotal,
      outstandingTotal: clampToZero(total - paidTotal - Number(order.giftCardTotal || 0) - creditTotal + refundedTotal),
    };
  }

  derivePaymentStatus(order, totals) {
    if (totals.refundedTotal >= totals.total && totals.total > 0) return 'refunded';
    if (totals.refundedTotal > 0) return 'partially_refunded';
    if (totals.outstandingTotal <= 0 && totals.total > 0) return 'paid';
    if (totals.paidTotal > 0) return 'partially_paid';
    if ((order.transactions || []).some(transaction => transaction.type === 'authorization' && transaction.status === 'completed')) {
      return 'authorized';
    }
    return 'unpaid';
  }

  deriveFulfillmentStatus(order) {
    const items = order.items || [];
    if (!items.length) return 'not_fulfilled';
    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    const fulfilled = items.reduce((sum, item) => sum + Number(item.fulfilledQuantity || 0), 0);
    const returned = items.reduce((sum, item) => sum + Number(item.returnedQuantity || 0), 0);
    if (returned >= totalQuantity && totalQuantity > 0) return 'returned';
    if (returned > 0) return 'partially_returned';
    if (fulfilled >= totalQuantity) return 'fulfilled';
    if (fulfilled > 0) return 'partially_fulfilled';
    return 'not_fulfilled';
  }

  async refreshTotals(orderId, ctx = null) {
    const order = this.repository.retrieve(orderId);
    const totals = this.computeTotals(order);
    const result = await this.store.transaction(state => this.repository.patch(state, orderId, {
      ...totals,
      paymentStatus: this.derivePaymentStatus(order, totals),
      fulfillmentStatus: this.deriveFulfillmentStatus(order),
    }));
    return result.after;
  }

  /** Crea el pedido desde un carrito ya calculado. */
  async createFromCart(cart, { idempotencyKey = null } = {}, ctx = null) {
    this.assertEnabled();
    if (idempotencyKey) {
      const existing = this.repository.find({ idempotencyKey });
      if (existing) return existing;
    }
    if (!(cart.items || []).length) throw new ConflictError('El carrito está vacío.');

    const order = await this.create({
      code: this.generateCode(),
      cartId: cart.id,
      channelId: cart.channelId,
      regionId: cart.regionId,
      currencyCode: cart.currencyCode,
      customerId: cart.customerId,
      email: cart.email,
      status: 'pending',
      // Las líneas se copian congeladas: importe, descuento e impuesto incluidos.
      items: (cart.items || []).map(item => ({
        ...item,
        fulfilledQuantity: 0,
        returnedQuantity: 0,
      })),
      shippingAddress: cart.shippingAddress || {},
      billingAddress: cart.billingAddress || cart.shippingAddress || {},
      shippingMethods: cart.shippingMethod ? [{ ...cart.shippingMethod, id: generateId('smeth') }] : [],
      surcharges: cart.surcharges || [],
      appliedPromotions: cart.appliedPromotions || [],
      taxBreakdown: cart.taxBreakdown || [],
      taxInclusive: Boolean(cart.taxInclusive),
      giftCardTotal: cart.giftCardTotal || 0,
      transactions: [],
      creditLines: [],
      note: cart.note || null,
      placedAt: now(),
      idempotencyKey,
    }, ctx);

    // División por vendedor para marketplace (M-0630).
    const breakdown = this.channel.sellers.splitOrder(order, item => {
      const product = this.catalog.products.repository.byId(item.productId);
      const channel = product?.channelIds?.[0] ? this.channel.channels.repository.byId(product.channelIds[0]) : null;
      return channel?.sellerId || null;
    });

    const withTotals = await this.store.transaction(state => this.repository.patch(state, order.id, {
      ...this.computeTotals(order),
      sellerBreakdown: breakdown.length > 1 ? breakdown : [],
    }));

    await this.history.log({
      orderId: order.id,
      customerId: order.customerId,
      type: 'order_placed',
      message: `Pedido ${order.code} registrado.`,
      internal: false,
    }, ctx);

    for (const applied of cart.appliedPromotions || []) {
      await this.promotion.promotions.registerUsage({
        promotionId: applied.promotionId,
        couponId: applied.couponId,
        orderId: order.id,
        cartId: cart.id,
        customerId: cart.customerId,
        discountAmount: applied.amount,
        currencyCode: cart.currencyCode,
      }, ctx);
    }
    for (const code of cart.giftCardCodes || []) {
      const card = this.promotion.giftCards.byCode(code);
      if (!card) continue;
      const applicable = Math.min(card.balance, cart.giftCardTotal || 0);
      if (applicable > 0) await this.promotion.giftCards.redeem(code, applicable, { orderId: order.id }, ctx);
    }

    return withTotals.after;
  }

  /** Confirma el pedido y convierte la reserva del carrito en asignación (M-0629). */
  async confirm(orderId, ctx = null) {
    const order = this.repository.retrieve(orderId);
    this.assertTransition(order, 'confirmed');

    // La reserva del carrito pasa a ser del pedido: la referencia cambia.
    if (order.cartId) {
      await this.inventory.service.release({ reference: order.cartId }, ctx);
    }
    for (const item of order.items || []) {
      await this.inventory.service.reserve({
        variantId: item.variantId,
        quantity: item.quantity,
        reference: order.id,
        referenceType: 'order',
        lineItemId: item.id,
      }, ctx);
    }

    const result = await this.store.transaction(state => this.repository.patch(state, orderId, {
      status: 'confirmed',
      confirmedAt: now(),
    }));
    await this.history.log({ orderId, type: 'order_confirmed', message: 'Pedido confirmado y stock asignado.', internal: false }, ctx);
    await this.notifications?.send({
      template: 'order.confirmed',
      to: order.email,
      entityId: orderId,
      data: { code: order.code, total: order.total },
    });
    await this.emit('confirmed', result.after, ctx, order);
    return result.after;
  }

  async transition(orderId, target, ctx = null) {
    const order = this.repository.retrieve(orderId);
    this.assertTransition(order, target);
    const patch = { status: target };
    if (target === 'completed') patch.completedAt = now();
    const result = await this.store.transaction(state => this.repository.patch(state, orderId, patch));
    await this.history.log({ orderId, type: `order_${target}`, message: `El pedido pasó a "${target}".`, internal: false }, ctx);
    await this.emit(target, result.after, ctx, order);
    return result.after;
  }

  /** Cancela y libera el stock reservado (M-0628). */
  async cancel(orderId, reason, ctx = null) {
    const order = this.repository.retrieve(orderId);
    this.assertTransition(order, 'cancelled');
    if (order.paidTotal > order.refundedTotal) {
      throw new ConflictError(
        'El pedido tiene importes cobrados sin reembolsar. Registra el reembolso antes de cancelarlo.',
        { paidTotal: order.paidTotal, refundedTotal: order.refundedTotal },
      );
    }
    await this.inventory.service.release({ reference: order.id }, ctx);
    const result = await this.store.transaction(state => this.repository.patch(state, orderId, {
      status: 'cancelled',
      cancelledAt: now(),
      cancelReason: reason || null,
    }));
    await this.history.log({ orderId, type: 'order_cancelled', message: `Pedido cancelado. Motivo: ${reason || 'sin especificar'}.`, internal: false }, ctx);
    await this.notifications?.send({
      template: 'order.cancelled',
      to: order.email,
      entityId: orderId,
      data: { code: order.code, reason: reason || 'sin especificar' },
    });
    await this.emit('cancelled', result.after, ctx, order);
    return result.after;
  }

  /** Registra una transacción (cobro, reembolso o ajuste) y recalcula (M-0623). */
  async addTransaction(orderId, { type, amount, reference = null, provider = null, status = 'completed', note = null }, ctx = null) {
    const order = this.repository.retrieve(orderId);
    const transaction = {
      id: generateId('trx'),
      type,
      amount: Number(amount),
      currencyCode: order.currencyCode,
      reference,
      provider,
      status,
      note,
      createdAt: now(),
      actorId: ctx?.actor?.id || null,
    };
    await this.store.transaction(state => this.repository.patch(state, orderId, {
      transactions: [...(order.transactions || []), transaction],
    }));
    await this.history.log({ orderId, type: `transaction_${type}`, message: `Transacción ${type} de ${amount}.`, data: { transactionId: transaction.id } }, ctx);
    const updated = await this.refreshTotals(orderId, ctx);
    await this.checkReconciliation(updated, ctx);
    return { transaction, order: updated };
  }

  /** Línea de crédito: saldo a favor del cliente (M-0624). */
  async addCreditLine(orderId, { amount, reason }, ctx = null) {
    const order = this.repository.retrieve(orderId);
    const line = { id: generateId('cred'), amount: Number(amount), reason, createdAt: now(), actorId: ctx?.actor?.id || null };
    await this.store.transaction(state => this.repository.patch(state, orderId, {
      creditLines: [...(order.creditLines || []), line],
    }));
    return this.refreshTotals(orderId, ctx);
  }

  /** Alerta de descuadre entre pagos y total (M-0669, M-0669). */
  async checkReconciliation(order, ctx = null) {
    const totals = this.computeTotals(order);
    const overpaid = totals.paidTotal - totals.refundedTotal - totals.total - Number(order.giftCardTotal || 0);
    if (overpaid > 0) {
      await this.alerts?.raise({
        type: 'order_overpaid',
        severity: 'critical',
        message: `El pedido ${order.code} tiene ${overpaid} cobrado por encima de su total.`,
        entityId: order.id,
        entityType: 'order',
      }, ctx);
    }
    return { overpaid };
  }

  /** Modificación de pedido con cálculo de diferencia (M-0635 … M-0638). */
  async modify(orderId, { addItems = [], removeLineIds = [], updateQuantities = [], note = null }, ctx = null) {
    const order = this.repository.retrieve(orderId);
    if (FINAL_STATUSES.has(order.status)) {
      throw new ConflictError('Un pedido completado o cancelado no admite modificaciones.', { status: order.status });
    }

    const before = this.computeTotals(order);
    let items = [...(order.items || [])];

    for (const lineId of removeLineIds) {
      const line = items.find(item => item.id === lineId);
      if (!line) continue;
      if (line.fulfilledQuantity > 0) {
        throw new ConflictError('No se puede quitar una línea ya enviada.', { lineItemId: lineId });
      }
      items = items.filter(item => item.id !== lineId);
      await this.inventory.service.release({ reference: order.id, lineItemId: lineId }, ctx);
    }

    for (const update of updateQuantities) {
      const line = items.find(item => item.id === update.lineItemId);
      if (!line) continue;
      if (update.quantity < line.fulfilledQuantity) {
        throw new ConflictError('La cantidad no puede quedar por debajo de lo ya enviado.', { lineItemId: line.id });
      }
      line.quantity = update.quantity;
      line.total = line.unitPrice * update.quantity;
    }

    for (const addition of addItems) {
      const variant = this.catalog.variants.repository.byId(addition.variantId);
      if (!variant) throw new NotFoundError('variante', addition.variantId);
      const product = this.catalog.products.repository.byId(variant.productId);
      const unitPrice = Number(addition.unitPrice);
      if (!Number.isFinite(unitPrice)) {
        throw ValidationError.single('unitPrice', 'Indica el precio unitario de la línea añadida.');
      }
      const line = {
        id: generateId('li'),
        variantId: variant.id,
        productId: variant.productId,
        title: product?.name || variant.title,
        variantTitle: variant.title,
        sku: variant.sku || null,
        quantity: addition.quantity,
        unitPrice,
        total: unitPrice * addition.quantity,
        adjustments: [],
        taxLines: [],
        discountTotal: 0,
        taxTotal: 0,
        fulfilledQuantity: 0,
        returnedQuantity: 0,
      };
      items.push(line);
      await this.inventory.service.reserve({
        variantId: variant.id,
        quantity: addition.quantity,
        reference: order.id,
        referenceType: 'order',
        lineItemId: line.id,
      }, ctx);
    }

    await this.store.transaction(state => this.repository.patch(state, orderId, { items }));
    const updated = await this.refreshTotals(orderId, ctx);
    const after = this.computeTotals(updated);
    const difference = after.total - before.total;

    await this.history.log({
      orderId,
      type: 'order_modified',
      message: `Pedido modificado. Diferencia: ${difference}.`,
      data: { before: before.total, after: after.total, difference, note },
    }, ctx);

    return {
      order: updated,
      difference,
      direction: difference > 0 ? 'charge' : difference < 0 ? 'refund' : 'none',
      note: difference > 0
        ? 'Hay una diferencia a cobrar. Registra el cobro adicional.'
        : difference < 0
          ? 'Hay una diferencia a devolver. Registra el reembolso.'
          : 'El total no cambió.',
    };
  }

  /** Crea un carrito con las líneas de un pedido anterior (M-0640). */
  reorderPayload(orderId) {
    const order = this.repository.retrieve(orderId);
    return {
      channelId: order.channelId,
      regionId: order.regionId,
      currencyCode: order.currencyCode,
      customerId: order.customerId,
      items: (order.items || []).map(item => ({ variantId: item.variantId, quantity: item.quantity })),
    };
  }

  /** Vista para el cliente: sin notas internas ni desglose de vendedor. */
  publicView(order) {
    if (!order) return null;
    const { internalNote: _internal, sellerBreakdown: _sellers, idempotencyKey: _key, ...rest } = order;
    return rest;
  }

  /** Marca como completados los pedidos entregados hace tiempo. */
  async autoComplete() {
    const days = this.settings.get('order.autoCompleteAfterDays', 30);
    if (!days) return { completed: 0 };
    const candidates = this.repository
      .all({ status: 'delivered' })
      .filter(order => (ageInDays(order.updatedAt) ?? 0) >= days);
    for (const order of candidates) await this.transition(order.id, 'completed');
    return { completed: candidates.length };
  }
}

export class ReturnService extends BaseService {
  constructor(deps) {
    super(deps, returnResource);
    this.orders = deps.orders;
    this.history = deps.history;
    this.inventory = deps.inventory;
    this.reasons = deps.reasons;
    this.refunds = deps.refunds;
    this.geography = deps.geography;
    this.settings = deps.settings;
    this.notifications = deps.notifications;
  }

  /** Plazo de devolución por región (M-0703, M-0704). */
  assertWithinWindow(order) {
    const region = order.regionId ? this.geography.regions.repository.byId(order.regionId) : null;
    const days = region?.returnWindowDays ?? this.settings.get('order.returnWindowDays', 30);
    const age = ageInDays(order.placedAt || order.createdAt);
    if (age !== null && age > days) {
      throw new ConflictError(`El plazo de devolución de ${days} días ya venció (pedido de hace ${age} días).`, { days, age });
    }
    return true;
  }

  async request(input, ctx = null) {
    const order = this.orders.repository.retrieve(input.orderId);
    this.assertWithinWindow(order);
    if (!['shipped', 'delivered', 'completed'].includes(order.status)) {
      throw new ConflictError('Solo se puede devolver un pedido enviado o entregado.', { status: order.status });
    }
    for (const item of input.items) {
      const line = (order.items || []).find(entry => entry.id === item.lineItemId);
      if (!line) throw new NotFoundError('línea del pedido', item.lineItemId);
      const returnable = line.quantity - Number(line.returnedQuantity || 0);
      if (item.quantity > returnable) {
        throw new ConflictError(`Solo quedan ${returnable} unidad(es) devolvibles de ${line.title}.`, { lineItemId: line.id, returnable });
      }
    }
    const record = await this.create({ ...input, status: 'requested' }, ctx);
    await this.history.log({
      orderId: order.id,
      type: 'return_requested',
      message: `Devolución solicitada (${input.items.length} línea(s)).`,
      internal: false,
      data: { returnId: record.id },
    }, ctx);
    await this.notifications?.send({
      template: 'return.requested',
      to: order.email,
      entityId: record.id,
      data: { code: order.code },
    });
    return record;
  }

  async approve(returnId, ctx = null) {
    const record = this.repository.retrieve(returnId);
    if (record.status !== 'requested') throw new InvalidStateError('la devolución', record.status, 'approved', ['requested']);
    const result = await this.store.transaction(state => this.repository.patch(state, returnId, { status: 'approved', approvedAt: now() }));
    await this.history.log({ orderId: record.orderId, type: 'return_approved', message: 'Devolución aprobada.', internal: false }, ctx);
    return result.after;
  }

  async reject(returnId, reason, ctx = null) {
    const record = this.repository.retrieve(returnId);
    if (!['requested', 'approved'].includes(record.status)) {
      throw new InvalidStateError('la devolución', record.status, 'rejected', ['requested', 'approved']);
    }
    const result = await this.store.transaction(state => this.repository.patch(state, returnId, {
      status: 'rejected',
      rejectionReason: reason,
      closedAt: now(),
    }));
    await this.history.log({ orderId: record.orderId, type: 'return_rejected', message: `Devolución rechazada: ${reason}.`, internal: false }, ctx);
    return result.after;
  }

  /**
   * Recepción con inspección por línea. Solo se repone lo recibido en buen estado
   * (M-0694, M-0695).
   */
  async receive(returnId, { items, refund = true }, ctx = null) {
    const record = this.repository.retrieve(returnId);
    if (record.status !== 'approved') throw new InvalidStateError('la devolución', record.status, 'received', ['approved']);
    const order = this.orders.repository.retrieve(record.orderId);

    let refundAmount = 0;
    const inspected = [];

    for (const entry of items) {
      const requested = record.items.find(item => item.lineItemId === entry.lineItemId);
      if (!requested) throw new NotFoundError('línea de la devolución', entry.lineItemId);
      const line = (order.items || []).find(item => item.id === entry.lineItemId);
      const received = Math.min(entry.receivedQuantity ?? requested.quantity, requested.quantity);
      const reason = requested.reasonId ? this.reasons.repository.byId(requested.reasonId) : null;
      const restock = entry.restock ?? reason?.restockByDefault ?? entry.condition === 'new';

      inspected.push({ ...requested, receivedQuantity: received, condition: entry.condition || 'new', restock });

      if (line && received > 0) {
        const unitRefund = line.quantity ? Math.round((line.total - Number(line.discountTotal || 0)) / line.quantity) : 0;
        refundAmount += unitRefund * received;
      }

      if (restock && received > 0) {
        const requirements = this.inventory.service.requirementsFor(requested.lineItemId ? line.variantId : null);
        for (const requirement of requirements) {
          await this.inventory.service.adjust({
            inventoryItemId: requirement.inventoryItemId,
            locationId: this.inventory.locations.default()?.id,
            delta: requirement.quantity * received,
            reason: `Devolución ${returnId}`,
            type: 'return',
          }, ctx);
        }
      }
    }

    refundAmount = clampToZero(refundAmount - Number(record.shippingCost || 0));

    const updatedItems = (order.items || []).map(line => {
      const entry = inspected.find(item => item.lineItemId === line.id);
      return entry ? { ...line, returnedQuantity: Number(line.returnedQuantity || 0) + entry.receivedQuantity } : line;
    });
    await this.store.transaction(state => this.orders.repository.patch(state, order.id, { items: updatedItems }));

    let refundRecord = null;
    if (refund && refundAmount > 0) {
      refundRecord = await this.refunds.create({
        orderId: order.id,
        returnId,
        amount: refundAmount,
        currencyCode: order.currencyCode,
        reason: `Devolución ${returnId}`,
        status: 'pending',
      }, ctx);
    }

    const result = await this.store.transaction(state => this.repository.patch(state, returnId, {
      status: 'received',
      receivedAt: now(),
      items: inspected,
      refundAmount,
      refundId: refundRecord?.id || null,
    }));

    await this.orders.refreshTotals(order.id, ctx);
    await this.history.log({
      orderId: order.id,
      type: 'return_received',
      message: `Devolución recibida. Importe a reembolsar: ${refundAmount}.`,
      internal: false,
      data: { returnId, refundAmount },
    }, ctx);
    await this.notifications?.send({
      template: 'return.approved',
      to: order.email,
      entityId: returnId,
      data: { code: order.code, amount: refundAmount },
    });

    return result.after;
  }

  /** Métricas de devolución por motivo y producto (M-0706, M-0707). */
  metrics() {
    const returns = this.repository.all();
    const orders = this.orders.repository.all();
    const byReason = new Map();
    const byProduct = new Map();

    for (const record of returns) {
      const order = orders.find(row => row.id === record.orderId);
      for (const item of record.items || []) {
        const reason = item.reasonId || record.reasonId || 'sin_motivo';
        byReason.set(reason, (byReason.get(reason) || 0) + (item.receivedQuantity ?? item.quantity));
        const line = (order?.items || []).find(entry => entry.id === item.lineItemId);
        if (line) {
          const current = byProduct.get(line.productId) || { productId: line.productId, title: line.title, returned: 0 };
          current.returned += item.receivedQuantity ?? item.quantity;
          byProduct.set(line.productId, current);
        }
      }
    }

    const sold = new Map();
    for (const order of orders.filter(row => !['draft', 'cancelled'].includes(row.status))) {
      for (const line of order.items || []) {
        sold.set(line.productId, (sold.get(line.productId) || 0) + line.quantity);
      }
    }

    return {
      totalReturns: returns.length,
      byReason: [...byReason.entries()]
        .map(([reasonId, units]) => ({
          reasonId,
          label: this.reasons.repository.byId(reasonId)?.label || reasonId,
          units,
        }))
        .sort((a, b) => b.units - a.units),
      byProduct: [...byProduct.values()]
        .map(entry => ({
          ...entry,
          sold: sold.get(entry.productId) || 0,
          ratePercent: sold.get(entry.productId) ? Math.round((entry.returned / sold.get(entry.productId)) * 100) : null,
        }))
        .sort((a, b) => (b.ratePercent || 0) - (a.ratePercent || 0)),
    };
  }
}

export class ExchangeService extends BaseService {
  constructor(deps) {
    super(deps, exchangeResource);
    this.orders = deps.orders;
    this.history = deps.history;
    this.pricing = deps.pricing;
  }

  /** Diferencia entre lo devuelto y el reemplazo (M-0699). */
  async request(input, ctx = null) {
    const order = this.orders.repository.retrieve(input.orderId);
    let returnValue = 0;
    for (const item of input.returnItems || []) {
      const line = (order.items || []).find(entry => entry.id === item.lineItemId);
      if (!line) throw new NotFoundError('línea del pedido', item.lineItemId);
      const unit = line.quantity ? Math.round((line.total - Number(line.discountTotal || 0)) / line.quantity) : 0;
      returnValue += unit * item.quantity;
    }
    let replacementValue = 0;
    for (const item of input.replacementItems || []) {
      const price = this.pricing.calculation.calculate({
        variantId: item.variantId,
        currencyCode: order.currencyCode,
        regionId: order.regionId,
        channelId: order.channelId,
        quantity: item.quantity,
      });
      if (price.amount === null) throw new ConflictError('El reemplazo no tiene precio en la moneda del pedido.', { variantId: item.variantId });
      replacementValue += price.amount * item.quantity;
    }

    const difference = replacementValue - returnValue;
    const record = await this.create({
      ...input,
      difference: Math.abs(difference),
      differenceDirection: difference > 0 ? 'charge' : difference < 0 ? 'refund' : 'none',
      status: 'requested',
    }, ctx);

    await this.history.log({
      orderId: order.id,
      type: 'exchange_requested',
      message: `Cambio solicitado. Diferencia: ${difference}.`,
      internal: false,
      data: { exchangeId: record.id, difference },
    }, ctx);
    return record;
  }
}

export class ClaimService extends BaseService {
  constructor(deps) {
    super(deps, claimResource);
    this.orders = deps.orders;
    this.history = deps.history;
    this.refunds = deps.refunds;
    this.reasons = deps.reasons;
  }

  async open(input, ctx = null) {
    const order = this.orders.repository.retrieve(input.orderId);
    const reasonRequiresEvidence = ['damaged', 'wrong_item'].includes(input.type);
    if (reasonRequiresEvidence && !(input.evidenceAssetIds || []).length) {
      throw ValidationError.single('evidenceAssetIds', 'Este tipo de reclamación requiere al menos una evidencia adjunta.');
    }
    const record = await this.create({ ...input, status: 'open' }, ctx);
    await this.history.log({
      orderId: order.id,
      type: 'claim_opened',
      message: `Reclamación abierta (${input.type}).`,
      internal: false,
      data: { claimId: record.id },
    }, ctx);
    return record;
  }

  async resolve(claimId, { resolution, note, refundAmount = 0 }, ctx = null) {
    const claim = this.repository.retrieve(claimId);
    if (claim.status === 'resolved') throw new ConflictError('La reclamación ya está resuelta.');
    const order = this.orders.repository.retrieve(claim.orderId);

    let refundRecord = null;
    if (['refund', 'partial_refund'].includes(resolution)) {
      if (!(refundAmount > 0)) throw ValidationError.single('refundAmount', 'Indica el importe a reembolsar.');
      refundRecord = await this.refunds.create({
        orderId: order.id,
        claimId,
        amount: refundAmount,
        currencyCode: order.currencyCode,
        reason: `Reclamación ${claimId}: ${note || resolution}`,
        status: 'pending',
      }, ctx);
    }

    const result = await this.store.transaction(state => this.repository.patch(state, claimId, {
      status: resolution === 'rejected' ? 'rejected' : 'resolved',
      resolution,
      resolutionNote: note || null,
      resolvedAt: now(),
      refundId: refundRecord?.id || null,
    }));
    await this.history.log({
      orderId: order.id,
      type: 'claim_resolved',
      message: `Reclamación resuelta: ${resolution}.`,
      internal: false,
      data: { claimId, resolution },
    }, ctx);
    return result.after;
  }
}

export class RefundService extends BaseService {
  constructor(deps) {
    super(deps, refundResource);
    this.orders = deps.orders;
    this.history = deps.history;
  }

  /** Marca el reembolso como completado y lo refleja en el pedido. */
  async complete(refundId, { providerReference = null } = {}, ctx = null) {
    const refund = this.repository.retrieve(refundId);
    if (refund.status === 'completed') return refund;
    const result = await this.store.transaction(state => this.repository.patch(state, refundId, {
      status: 'completed',
      processedAt: now(),
      providerReference,
    }));
    await this.orders.addTransaction(refund.orderId, {
      type: 'refund',
      amount: refund.amount,
      reference: providerReference,
      note: refund.reason,
    }, ctx);
    return result.after;
  }
}

export class DraftOrderService extends BaseService {
  constructor(deps) {
    super(deps, draftOrderResource);
    this.orders = deps.orders;
    this.catalog = deps.catalog;
    this.pricing = deps.pricing;
    this.settings = deps.settings;
  }

  /** Convierte el borrador en pedido con pago pendiente (M-0634). */
  async convert(draftId, ctx = null) {
    this.settings.assertCapability('order');
    const draft = this.repository.retrieve(draftId);
    if (draft.status !== 'open') throw new ConflictError('El borrador ya se convirtió o se canceló.', { status: draft.status });
    if (!(draft.items || []).length) throw new ConflictError('El borrador no tiene líneas.');

    const items = draft.items.map(item => {
      const variant = this.catalog.variants.repository.retrieve(item.variantId);
      const product = this.catalog.products.repository.byId(variant.productId);
      const unitPrice = item.unitPrice ?? this.pricing.calculation.calculate({
        variantId: item.variantId,
        currencyCode: draft.currencyCode,
        regionId: draft.regionId,
        channelId: draft.channelId,
        quantity: item.quantity,
      }).amount;
      if (unitPrice === null) throw new ConflictError('Falta el precio de una línea del borrador.', { variantId: item.variantId });
      return {
        id: generateId('li'),
        variantId: variant.id,
        productId: variant.productId,
        title: product?.name || variant.title,
        variantTitle: variant.title,
        sku: variant.sku || null,
        quantity: item.quantity,
        unitPrice,
        total: unitPrice * item.quantity,
        discountTotal: 0,
        taxTotal: 0,
        adjustments: [],
        taxLines: [],
        fulfilledQuantity: 0,
        returnedQuantity: 0,
      };
    });

    const pseudoCart = {
      id: draft.id,
      channelId: draft.channelId,
      regionId: draft.regionId,
      currencyCode: draft.currencyCode,
      customerId: draft.customerId,
      email: draft.email,
      items,
      shippingAddress: draft.shippingAddress || {},
      billingAddress: draft.billingAddress || {},
      shippingMethod: draft.shippingAmount ? { name: 'Envío manual', amount: draft.shippingAmount } : null,
      appliedPromotions: [],
      giftCardCodes: [],
      note: draft.note,
    };

    const order = await this.orders.createFromCart(pseudoCart, {}, ctx);
    await this.store.transaction(state => this.repository.patch(state, draftId, { status: 'converted', orderId: order.id }));
    return order;
  }
}

const SEED_RETURN_REASONS = [
  { id: 'rreason_wrong_size', code: 'talla-incorrecta', label: 'Talla o medida incorrecta', restockByDefault: true },
  { id: 'rreason_damaged', code: 'llego-danado', label: 'Llegó dañado', requiresEvidence: true, restockByDefault: false },
  { id: 'rreason_not_described', code: 'no-coincide', label: 'No coincide con la descripción', restockByDefault: true },
  { id: 'rreason_late', code: 'entrega-tardia', label: 'Entrega demasiado tardía', restockByDefault: true },
  { id: 'rreason_changed_mind', code: 'cambio-de-opinion', label: 'Cambio de opinión', restockByDefault: true },
  { id: 'rreason_wrong_item', code: 'articulo-incorrecto', label: 'Artículo incorrecto', requiresEvidence: true, restockByDefault: true },
];

export default {
  name: 'order',
  requires: [
    'store', 'events', 'audit', 'config', 'customFields', 'translations', 'settings', 'catalog',
    'pricing', 'inventory', 'promotion', 'channel', 'geography', 'notifications', 'alert',
  ],
  resources: [
    orderResource, historyResource, returnReasonResource, returnResource,
    exchangeResource, claimResource, refundResource, draftOrderResource,
  ],
  permissions: [
    { resource: 'order', description: 'Pedidos.' },
    { resource: 'draftOrder', description: 'Pedidos borrador.' },
    { resource: 'return', description: 'Devoluciones.' },
    { resource: 'returnReason', description: 'Motivos de devolución.' },
    { resource: 'exchange', description: 'Cambios.' },
    { resource: 'claim', description: 'Reclamaciones.' },
    { resource: 'refund', description: 'Reembolsos.' },
    { resource: 'historyEntry', actions: ['read', 'create'], description: 'Historial de pedido y cliente.' },
  ],

  register(deps) {
    const history = new HistoryService(deps);
    const reasons = new BaseService(deps, returnReasonResource);
    const orders = new OrderService({ ...deps, history });
    const refunds = new RefundService({ ...deps, orders, history });
    const returns = new ReturnService({ ...deps, orders, history, reasons, refunds });
    const exchanges = new ExchangeService({ ...deps, orders, history });
    const claims = new ClaimService({ ...deps, orders, history, refunds, reasons });
    const drafts = new DraftOrderService({ ...deps, orders });
    return { orders, history, reasons, returns, exchanges, claims, refunds, drafts };
  },

  async seed(service) {
    await service.reasons.seed(SEED_RETURN_REASONS, 'id');
  },

  jobs: container => [
    {
      name: 'order.auto-complete',
      everyMs: 12 * 3_600_000,
      handler: () => container.resolve('order').orders.autoComplete(),
    },
    {
      name: 'order.high-return-rate',
      everyMs: 24 * 3_600_000,
      handler: async () => {
        const module = container.resolve('order');
        const metrics = module.returns.metrics();
        const risky = metrics.byProduct.filter(row => (row.ratePercent || 0) >= 20 && row.sold >= 5);
        for (const row of risky) {
          await container.resolve('alert').raise({
            type: 'high_return_rate',
            severity: 'warning',
            message: `${row.title} tiene una tasa de devolución del ${row.ratePercent} %.`,
            entityId: row.productId,
            entityType: 'product',
          });
        }
        return { flagged: risky.length };
      },
    },
  ],

  routes: {
    admin: container => {
      const module = () => container.resolve('order');
      return [
        ...crudRoutes(orderResource, () => module().orders, { tags: ['pedidos'] }),
        ...crudRoutes(returnReasonResource, () => module().reasons, { tags: ['pedidos'] }),
        ...crudRoutes(returnResource, () => module().returns, { tags: ['pedidos'] }),
        ...crudRoutes(exchangeResource, () => module().exchanges, { tags: ['pedidos'] }),
        ...crudRoutes(claimResource, () => module().claims, { tags: ['pedidos'] }),
        ...crudRoutes(refundResource, () => module().refunds, { tags: ['pedidos'] }),
        ...crudRoutes(draftOrderResource, () => module().drafts, { tags: ['pedidos'] }),
        {
          method: 'GET',
          path: '/orders/:id/history',
          permission: 'historyEntry:read',
          summary: 'Historial completo del pedido.',
          tags: ['pedidos'],
          bodyless: true,
          handler: ctx => {
            const data = module().history.forOrder(ctx.params.id);
            return { data, count: data.length };
          },
        },
        {
          method: 'POST',
          path: '/orders/:id/confirm',
          permission: 'order:update',
          summary: 'Confirma el pedido y asigna el stock.',
          tags: ['pedidos'],
          handler: ctx => module().orders.confirm(ctx.params.id, ctx),
        },
        {
          method: 'POST',
          path: '/orders/:id/transition',
          permission: 'order:update',
          summary: 'Cambia el estado del pedido validando la transición.',
          tags: ['pedidos'],
          body: { status: rule.enumOf(ORDER_STATUSES, { required: true }) },
          handler: ctx => module().orders.transition(ctx.params.id, ctx.body.status, ctx),
        },
        {
          method: 'POST',
          path: '/orders/:id/cancel',
          permission: 'order:update',
          summary: 'Cancela el pedido y libera el stock.',
          tags: ['pedidos'],
          body: { reason: rule.text(300, { required: true }) },
          handler: ctx => module().orders.cancel(ctx.params.id, ctx.body.reason, ctx),
        },
        {
          method: 'POST',
          path: '/orders/:id/transactions',
          permission: 'order:update',
          summary: 'Registra un cobro, reembolso o ajuste.',
          tags: ['pedidos'],
          body: {
            type: rule.enumOf(['authorization', 'capture', 'refund', 'adjustment'], { required: true }),
            amount: rule.minor({ required: true }),
            reference: rule.text(200),
            provider: rule.text(60),
            note: rule.text(300),
          },
          handler: ctx => module().orders.addTransaction(ctx.params.id, ctx.body, ctx),
        },
        {
          method: 'POST',
          path: '/orders/:id/credit-lines',
          permission: 'order:update',
          summary: 'Añade una línea de crédito a favor del cliente.',
          tags: ['pedidos'],
          body: { amount: rule.minor({ required: true }), reason: rule.text(300, { required: true }) },
          handler: ctx => module().orders.addCreditLine(ctx.params.id, ctx.body, ctx),
        },
        {
          method: 'POST',
          path: '/orders/:id/modify',
          permission: 'order:update',
          summary: 'Modifica el pedido y calcula la diferencia a cobrar o devolver.',
          tags: ['pedidos'],
          body: {
            addItems: rule.list({ type: 'object', shape: { variantId: rule.id({ required: true }), quantity: rule.quantity({ required: true }), unitPrice: rule.minor() } }),
            removeLineIds: rule.list({ type: 'string' }),
            updateQuantities: rule.list({ type: 'object', shape: { lineItemId: rule.id({ required: true }), quantity: rule.quantity({ required: true }) } }),
            note: rule.text(300),
          },
          handler: ctx => module().orders.modify(ctx.params.id, ctx.body, ctx),
        },
        {
          method: 'POST',
          path: '/orders/:id/notes',
          permission: 'order:update',
          summary: 'Añade una nota interna o visible al cliente.',
          tags: ['pedidos'],
          body: { message: rule.text(600, { required: true }), internal: rule.flag({ default: true }) },
          handler: ctx => module().history.log({
            orderId: ctx.params.id,
            type: 'note',
            message: ctx.body.message,
            internal: ctx.body.internal,
          }, ctx),
        },
        {
          method: 'GET',
          path: '/orders/:id/reorder-payload',
          permission: 'order:read',
          summary: 'Datos para crear un carrito nuevo desde este pedido.',
          tags: ['pedidos'],
          bodyless: true,
          handler: ctx => module().orders.reorderPayload(ctx.params.id),
        },
        {
          method: 'POST',
          path: '/returns/:id/approve',
          permission: 'return:update',
          summary: 'Aprueba una devolución.',
          tags: ['pedidos'],
          handler: ctx => module().returns.approve(ctx.params.id, ctx),
        },
        {
          method: 'POST',
          path: '/returns/:id/reject',
          permission: 'return:update',
          summary: 'Rechaza una devolución con motivo.',
          tags: ['pedidos'],
          body: { reason: rule.text(300, { required: true }) },
          handler: ctx => module().returns.reject(ctx.params.id, ctx.body.reason, ctx),
        },
        {
          method: 'POST',
          path: '/returns/:id/receive',
          permission: 'return:update',
          summary: 'Recibe la devolución con inspección por línea.',
          tags: ['pedidos'],
          body: {
            refund: rule.flag({ default: true }),
            items: rule.list({
              type: 'object',
              shape: {
                lineItemId: rule.id({ required: true }),
                receivedQuantity: rule.quantity(),
                condition: rule.enumOf(['new', 'damaged', 'used', 'missing']),
                restock: rule.flag(),
              },
            }, { required: true }),
          },
          handler: ctx => module().returns.receive(ctx.params.id, ctx.body, ctx),
        },
        {
          method: 'GET',
          path: '/returns/metrics',
          permission: 'return:read',
          summary: 'Devoluciones por motivo y por producto.',
          tags: ['pedidos'],
          bodyless: true,
          handler: () => module().returns.metrics(),
        },
        {
          method: 'POST',
          path: '/exchanges/request',
          permission: 'exchange:create',
          summary: 'Solicita un cambio y calcula la diferencia.',
          tags: ['pedidos'],
          status: 201,
          body: exchangeResource.fields,
          handler: ctx => module().exchanges.request(ctx.body, ctx),
        },
        {
          method: 'POST',
          path: '/claims/:id/resolve',
          permission: 'claim:update',
          summary: 'Resuelve una reclamación.',
          tags: ['pedidos'],
          body: {
            resolution: rule.enumOf(['replacement', 'refund', 'partial_refund', 'rejected'], { required: true }),
            note: rule.text(600),
            refundAmount: rule.minor(),
          },
          handler: ctx => module().claims.resolve(ctx.params.id, ctx.body, ctx),
        },
        {
          method: 'POST',
          path: '/refunds/:id/complete',
          permission: 'refund:update',
          summary: 'Marca un reembolso como completado.',
          tags: ['pedidos'],
          body: { providerReference: rule.text(200) },
          handler: ctx => module().refunds.complete(ctx.params.id, ctx.body, ctx),
        },
        {
          method: 'POST',
          path: '/draft-orders/:id/convert',
          permission: 'draftOrder:update',
          summary: 'Convierte un borrador en pedido con pago pendiente.',
          tags: ['pedidos'],
          status: 201,
          handler: ctx => module().drafts.convert(ctx.params.id, ctx),
        },
      ];
    },

    store: container => {
      const module = () => container.resolve('order');
      return [
        {
          method: 'GET',
          path: '/orders/by-code/:code',
          permission: null,
          summary: 'Consulta un pedido por su código.',
          tags: ['store'],
          bodyless: true,
          handler: ctx => {
            const order = module().orders.byCode(ctx.params.code);
            if (!order) throw new NotFoundError('pedido', ctx.params.code);
            // El correo se exige como segundo factor para no filtrar pedidos por código.
            const email = String(ctx.query.email || '').toLowerCase();
            if (order.email && email !== String(order.email).toLowerCase()) {
              throw new NotFoundError('pedido', ctx.params.code);
            }
            return {
              ...module().orders.publicView(order),
              history: module().history.forOrder(order.id, { includeInternal: false }),
            };
          },
        },
        {
          method: 'GET',
          path: '/customers/me/orders',
          permission: null,
          summary: 'Pedidos del cliente autenticado.',
          tags: ['store'],
          bodyless: true,
          handler: ctx => {
            const customerId = ctx.cookies.ndivepa_customer;
            if (!customerId) return { data: [], count: 0 };
            const data = module().orders.repository
              .all({ customerId })
              .map(order => module().orders.publicView(order));
            return { data, count: data.length };
          },
        },
        {
          method: 'POST',
          path: '/returns/request',
          permission: null,
          summary: 'El cliente solicita una devolución de su pedido.',
          tags: ['store'],
          status: 201,
          body: {
            orderId: rule.id({ required: true }),
            items: rule.list({
              type: 'object',
              shape: {
                lineItemId: rule.id({ required: true }),
                quantity: rule.quantity({ required: true, min: 1 }),
                reasonId: rule.id(),
                note: rule.text(300),
              },
            }, { required: true }),
            note: rule.text(600),
          },
          handler: ctx => {
            const customerId = ctx.cookies.ndivepa_customer;
            const order = module().orders.repository.retrieve(ctx.body.orderId);
            if (!customerId || order.customerId !== customerId) {
              throw new NotFoundError('pedido', ctx.body.orderId);
            }
            return module().returns.request({ ...ctx.body, requestedBy: 'customer' }, ctx);
          },
        },
        {
          method: 'GET',
          path: '/return-reasons',
          permission: null,
          summary: 'Motivos de devolución disponibles.',
          tags: ['store'],
          bodyless: true,
          handler: ctx => {
            const data = module().reasons.repository.all().map(reason => ({
              id: reason.id,
              code: reason.code,
              label: reason.label,
              requiresEvidence: reason.requiresEvidence,
            }));
            return { data, count: data.length };
          },
        },
      ];
    },
  },
};
