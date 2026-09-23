/**
 * Subpedidos y finanzas del marketplace.
 *
 *   PEDIDO PRINCIPAL (módulo `order`, sin cambios de contrato)
 *   ├── SUBPEDIDO TIENDA A      partyType = seller
 *   ├── SUBPEDIDO TIENDA B      partyType = seller
 *   ├── SUBPEDIDO DROPSHIPPING  partyType = supplier
 *   └── SUBPEDIDO PROPIO        partyType = platform
 *
 * El comprador paga una vez y ve un solo pedido. Cada tienda ve y gestiona solo
 * su subpedido. Los estados del subpedido mueven el pedido principal a través
 * de los servicios existentes (envíos e inventario): no se duplica la lógica de
 * consumo de stock ni de transición del pedido.
 */
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../framework/errors.js';
import { distribute } from '../../framework/money.js';
import { ageInDays, now } from '../../framework/dates.js';
import {
  LEDGER_TYPES, SELLER_ALLOWED_TARGETS, VENDOR_STATUS_LABELS, VENDOR_TRANSITIONS,
} from './models.js';

const OPEN_STATUSES = new Set(['created', 'payment_pending', 'paid', 'preparing', 'ready_to_ship', 'shipped', 'in_transit']);

export class FinanceService {
  constructor({ store, settings, ledger, payouts, events }) {
    this.store = store;
    this.settings = settings;
    this.ledger = ledger;
    this.payouts = payouts;
    this.events = events;
  }

  entry(type, amount, extra) {
    return { type, stream: LEDGER_TYPES[type], amount: Math.trunc(amount), status: 'accrued', occurredAt: now(), ...extra };
  }

  /** Asientos devengados de un subpedido recién creado. */
  async accrue(vendorOrder) {
    const base = {
      currencyCode: vendorOrder.currencyCode,
      orderId: vendorOrder.orderId,
      vendorOrderId: vendorOrder.id,
      sellerId: vendorOrder.sellerId || null,
      supplierId: vendorOrder.supplierId || null,
      reference: vendorOrder.code,
    };
    const rows = [this.entry('gmv', vendorOrder.total, base)];
    if (vendorOrder.partyType === 'seller') {
      rows.push(this.entry('commission', vendorOrder.commissionTotal, base));
      rows.push(this.entry('seller_payable', vendorOrder.sellerPayout, base));
    } else if (vendorOrder.partyType === 'supplier') {
      rows.push(this.entry('supplier_payable', vendorOrder.supplierCost, base));
      rows.push(this.entry('dropship_margin', vendorOrder.platformMargin, base));
    } else {
      rows.push(this.entry('own_sale', vendorOrder.total, base));
    }
    if (vendorOrder.platformDiscountTotal > 0) {
      rows.push(this.entry('platform_discount', -vendorOrder.platformDiscountTotal, base));
    }
    await this.store.transaction(state => {
      for (const row of rows) this.ledger.repository.insert(state, row);
    });
    return rows.length;
  }

  async setStatusFor(vendorOrderId, from, to) {
    const rows = this.ledger.repository.all({ vendorOrderId }).filter(row => from.includes(row.status));
    if (!rows.length) return 0;
    await this.store.transaction(state => {
      for (const row of rows) {
        this.ledger.repository.patch(state, row.id, {
          status: to,
          metadata: { ...(row.metadata || {}), [`${to}At`]: now() },
        });
      }
    });
    return rows.length;
  }

  /** Entregado: lo devengado pasa a firme. */
  confirm(vendorOrderId) {
    return this.setStatusFor(vendorOrderId, ['accrued'], 'confirmed');
  }

  /**
   * Cancelado o devuelto: se anula lo pendiente. Si la tienda ya cobró su parte,
   * se registra un asiento negativo que se descuenta de la próxima liquidación.
   */
  async reverse(vendorOrderId) {
    const rows = this.ledger.repository.all({ vendorOrderId });
    const paid = rows.filter(row => row.status === 'paid' && ['seller_payable', 'supplier_payable'].includes(row.type));
    const reversed = await this.setStatusFor(vendorOrderId, ['accrued', 'confirmed'], 'reversed');
    if (paid.length) {
      await this.store.transaction(state => {
        for (const row of paid) {
          this.ledger.repository.insert(state, {
            ...this.entry(row.type, -row.amount, {
              currencyCode: row.currencyCode, orderId: row.orderId, vendorOrderId, sellerId: row.sellerId,
              supplierId: row.supplierId, reference: row.reference, note: 'Reverso de un importe ya liquidado',
            }),
            status: 'confirmed',
          });
        }
      });
    }
    return reversed + paid.length;
  }

  /** Ingresos que no nacen de un pedido: publicidad y suscripciones de tiendas. */
  async recordRevenue({ type, amount, currencyCode, sellerId = null, campaignId = null, reference = null, note = null }) {
    if (!['advertising', 'subscription'].includes(type)) throw ValidationError.single('type', 'Tipo de ingreso no válido.');
    if (!(Number(amount) > 0)) throw ValidationError.single('amount', 'El importe debe ser mayor que cero.');
    return this.store.transaction(state => this.ledger.repository.insert(state, {
      ...this.entry(type, Number(amount), { currencyCode, sellerId, campaignId, reference, note }),
      status: 'confirmed',
    }));
  }

  /** Resumen por flujo y estado. Cada flujo se reporta por separado, nunca sumado. */
  summary({ days = null, sellerId = null } = {}) {
    const rows = this.ledger.repository.all(sellerId ? { sellerId } : {})
      .filter(row => days === null || (ageInDays(row.occurredAt || row.createdAt) ?? 0) <= days);
    const empty = () => ({ accrued: 0, confirmed: 0, reversed: 0, paid: 0 });
    const byType = {};
    for (const row of rows) {
      byType[row.type] = byType[row.type] || empty();
      byType[row.type][row.status] += row.amount;
    }
    const firm = type => (byType[type]?.confirmed || 0) + (byType[type]?.paid || 0);
    const pending = type => byType[type]?.accrued || 0;
    return {
      currencyCode: this.settings.get('marketplace.currencyCode', 'PYG'),
      marketplaceSales: { confirmed: firm('gmv'), pending: pending('gmv'), reversed: byType.gmv?.reversed || 0 },
      platformRevenue: {
        commissions: { confirmed: firm('commission'), pending: pending('commission') },
        ownSales: { confirmed: firm('own_sale'), pending: pending('own_sale') },
        advertising: { confirmed: firm('advertising') },
        subscriptions: { confirmed: firm('subscription') },
        platformDiscounts: { confirmed: firm('platform_discount'), pending: pending('platform_discount') },
      },
      dropshipping: {
        margin: { confirmed: firm('dropship_margin'), pending: pending('dropship_margin') },
        supplierCost: { confirmed: firm('supplier_payable'), pending: pending('supplier_payable') },
      },
      sellerPayable: {
        pending: pending('seller_payable'),
        confirmedUnpaid: byType.seller_payable?.confirmed || 0,
        paid: byType.seller_payable?.paid || 0,
      },
      byType,
    };
  }

  /** Importe liquidable por tienda: firme y fuera del plazo de espera configurado. */
  payables() {
    const delay = this.settings.get('marketplace.payoutDelayDays', 7);
    const grouped = new Map();
    for (const row of this.ledger.repository.all({ type: 'seller_payable', status: 'confirmed' })) {
      if (row.payoutId) continue;
      const confirmedAt = row.metadata?.confirmedAt || row.occurredAt;
      const eligible = (ageInDays(confirmedAt) ?? 0) >= delay || row.amount < 0;
      const current = grouped.get(row.sellerId) || { sellerId: row.sellerId, eligible: 0, waiting: 0, entryIds: [], currencyCode: row.currencyCode };
      if (eligible) {
        current.eligible += row.amount;
        current.entryIds.push(row.id);
      } else {
        current.waiting += row.amount;
      }
      grouped.set(row.sellerId, current);
    }
    return [...grouped.values()];
  }

  async createPayout(sellerId, { method = null, note = null } = {}, ctx = null) {
    const payable = this.payables().find(row => row.sellerId === sellerId);
    if (!payable || payable.eligible <= 0 || !payable.entryIds.length) {
      throw new ConflictError('La tienda no tiene importes liquidables todavía.', { sellerId });
    }
    const payout = await this.payouts.create({
      sellerId, amount: payable.eligible, currencyCode: payable.currencyCode, entryIds: payable.entryIds, status: 'pending', method, note,
    }, ctx);
    await this.store.transaction(state => {
      for (const entryId of payable.entryIds) this.ledger.repository.patch(state, entryId, { payoutId: payout.id });
    });
    return payout;
  }

  async markPayoutPaid(payoutId, { reference = null } = {}, ctx = null) {
    const payout = this.payouts.repository.retrieve(payoutId);
    if (payout.status !== 'pending') throw new ConflictError(`La liquidación está en estado "${payout.status}".`);
    await this.store.transaction(state => {
      this.payouts.repository.patch(state, payoutId, { status: 'paid', paidAt: now(), reference });
      for (const entryId of payout.entryIds) this.ledger.repository.patch(state, entryId, { status: 'paid' });
    });
    await this.payouts.emit('paid', this.payouts.repository.retrieve(payoutId), ctx, payout);
    return this.payouts.repository.retrieve(payoutId);
  }
}

export class VendorOrderService {
  constructor({ store, events, settings, catalog, order, fulfillment, inventory, alert, accounts, vendorOrders, finance, commissions, inbox, customer, logger }) {
    this.store = store;
    this.events = events;
    this.settings = settings;
    this.catalog = catalog;
    this.order = order;
    this.fulfillment = fulfillment;
    this.inventory = inventory;
    this.alerts = alert;
    this.accounts = accounts;
    this.repository = vendorOrders.repository;
    this.vendorOrders = vendorOrders;
    this.finance = finance;
    this.commissions = commissions;
    this.inbox = inbox;
    this.customer = customer;
    this.logger = logger;
  }

  forOrder(orderId) {
    return this.repository.all({ orderId }).sort((a, b) => String(a.code).localeCompare(String(b.code)));
  }

  forSeller(sellerId, { status = null } = {}) {
    return this.repository.all({ sellerId })
      .filter(row => !status || row.status === status)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  /** Parte responsable de una línea según el modelo comercial congelado en el pedido. */
  partyOf(line) {
    const product = this.catalog.products.repository.byId(line.productId);
    const model = line.commercialModel || product?.commercialModel || (line.sellerId ? 'LOCAL' : 'PROPIO');
    if (model === 'LOCAL' && (line.sellerId || product?.sellerId)) {
      return { key: `seller:${line.sellerId || product.sellerId}`, partyType: 'seller', sellerId: line.sellerId || product.sellerId };
    }
    if (model === 'DROPSHIPPING' && (line.supplierId || product?.supplierId)) {
      return { key: `supplier:${line.supplierId || product.supplierId}`, partyType: 'supplier', supplierId: line.supplierId || product.supplierId };
    }
    return { key: 'platform', partyType: 'platform' };
  }

  /** Separa los descuentos que financia la tienda de los que financia la plataforma. */
  splitAdjustments(line) {
    const promotions = this.store.collection('promotions');
    let seller = 0;
    let platform = 0;
    for (const adjustment of line.adjustments || []) {
      const promotion = promotions.find(row => row.id === adjustment.promotionId);
      const fundedBy = promotion?.metadata?.sellerId;
      if (fundedBy && fundedBy === line.sellerId) seller += Number(adjustment.amount || 0);
      else platform += Number(adjustment.amount || 0);
    }
    return { seller, platform };
  }

  deliveryModeFor(order, partyType, groupKey = null) {
    // Con envío por tienda, cada grupo tiene su método; si no, el único del pedido.
    const own = (order.shippingMethods || []).find(entry => entry.groupKey === groupKey);
    if (own?.mode) return own.mode;
    if (partyType === 'supplier') return 'supplier_shipping';
    const method = own || order.shippingMethods?.[0];
    if (!method) return 'pickup';
    const option = this.store.collection('shippingOptions').find(row => row.id === method.shippingOptionId);
    if (option?.provider === 'pickup' || /retiro|pickup/.test(option?.code || '')) return 'pickup';
    if (/local/.test(option?.code || '')) return 'local_delivery';
    return 'national_shipping';
  }

  paymentProviderOf(order) {
    const authorization = (order.transactions || []).find(transaction => ['authorization', 'capture'].includes(transaction.type));
    return authorization?.provider || null;
  }

  supplierCostOf(line) {
    const supplierProduct = this.store.collection('supplierProducts').find(row => !row.deletedAt && row.active !== false
      && (row.variantId === line.variantId || (!row.variantId && row.productId === line.productId)));
    return supplierProduct ? Number(supplierProduct.cost || 0) * line.quantity : 0;
  }

  /**
   * Crea los subpedidos al confirmarse el pedido principal. Idempotente: si ya
   * existen no se duplican (el evento puede entregarse más de una vez).
   */
  async createForOrder(orderId) {
    const existing = this.forOrder(orderId);
    if (existing.length) return existing;
    const order = this.order.orders.repository.retrieve(orderId);
    const groups = new Map();
    for (const line of order.items || []) {
      const party = this.partyOf(line);
      if (!groups.has(party.key)) groups.set(party.key, { ...party, lines: [] });
      groups.get(party.key).lines.push(line);
    }
    const list = [...groups.values()];
    const subtotals = list.map(group => group.lines.reduce((sum, line) => sum + Number(line.total || 0), 0));
    // Cada grupo cobra su propio envío; lo que no tenga método declarado se reparte
    // en proporción a su subtotal, como en el flujo de un solo envío.
    const methodsByGroup = new Map((order.shippingMethods || []).filter(method => method.groupKey).map(method => [method.groupKey, method]));
    const ownShipping = list.map(group => (methodsByGroup.has(group.key) ? Number(methodsByGroup.get(group.key).amount || 0) : null));
    const remaining = Math.max(0, Number(order.shippingTotal || 0) - ownShipping.reduce((sum, value) => sum + (value || 0), 0));
    const pending = list.map((group, index) => (ownShipping[index] === null ? subtotals[index] : 0));
    const distributed = distribute(remaining, pending);
    const shippingShares = list.map((group, index) => (ownShipping[index] === null ? distributed[index] : ownShipping[index]));
    const initialStatus = order.paymentStatus === 'paid' ? 'paid' : 'payment_pending';
    const provider = this.paymentProviderOf(order);
    const created = [];

    for (const [index, group] of list.entries()) {
      let sellerDiscountTotal = 0;
      let platformDiscountTotal = 0;
      let commissionTotal = 0;
      let supplierCost = 0;
      const items = group.lines.map(line => {
        const product = this.catalog.products.repository.byId(line.productId);
        const discounts = this.splitAdjustments(line);
        sellerDiscountTotal += discounts.seller;
        platformDiscountTotal += discounts.platform;
        const base = Math.max(0, Number(line.total || 0) - discounts.seller);
        const commission = group.partyType === 'seller'
          ? this.commissions.compute({
            productId: line.productId,
            sellerId: group.sellerId,
            categoryId: line.categoryId || product?.categoryId || null,
            campaignId: product?.campaignId || null,
            commercialModel: 'LOCAL',
          }, base)
          : { amount: 0, rule: null };
        commissionTotal += commission.amount;
        const cost = group.partyType === 'supplier' ? this.supplierCostOf(line) : 0;
        supplierCost += cost;
        return {
          lineItemId: line.id,
          productId: line.productId,
          variantId: line.variantId,
          title: line.title,
          variantTitle: line.variantTitle,
          sku: line.sku,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          total: line.total,
          sellerDiscount: discounts.seller,
          platformDiscount: discounts.platform,
          base,
          commission: commission.amount,
          commissionRule: commission.rule,
          supplierCost: cost,
        };
      });
      const subtotal = subtotals[index];
      const shippingShare = shippingShares[index];
      const baseTotal = items.reduce((sum, item) => sum + item.base, 0);
      const total = Math.max(0, subtotal - sellerDiscountTotal - platformDiscountTotal + shippingShare);
      const record = await this.vendorOrders.create({
        orderId: order.id,
        orderCode: order.code,
        code: `${order.code}-${index + 1}`,
        partyType: group.partyType,
        sellerId: group.sellerId || null,
        supplierId: group.supplierId || null,
        customerId: order.customerId || null,
        status: initialStatus,
        currencyCode: order.currencyCode,
        items,
        subtotal,
        sellerDiscountTotal,
        platformDiscountTotal,
        shippingShare,
        total,
        commissionTotal,
        // La tienda recibe su base menos la comisión, más el envío que ella realiza.
        sellerPayout: group.partyType === 'seller' ? Math.max(0, baseTotal - commissionTotal + shippingShare) : 0,
        supplierCost,
        platformMargin: group.partyType === 'supplier' ? baseTotal - supplierCost : 0,
        deliveryMode: this.deliveryModeFor(order, group.partyType, group.key),
        shippingMethodName: (methodsByGroup.get(group.key) || order.shippingMethods?.[0])?.name || null,
        groupKey: group.key,
        paymentProvider: provider,
        statusHistory: [{ status: initialStatus, at: now(), actorType: 'system', note: 'Pedido confirmado' }],
      });
      await this.finance.accrue(record);
      created.push(record);
      if (record.partyType === 'seller') {
        const seller = this.accounts.sellers.repository.byId(record.sellerId);
        if (seller) {
          await this.accounts.notifyOwners(seller, {
            type: 'new_order',
            title: `Nuevo pedido ${record.code}`,
            body: `${items.length} producto(s). ${initialStatus === 'paid' ? 'El pago está confirmado.' : 'Pago pendiente de confirmación.'}`,
            link: `/mi-tienda/${seller.id}/pedidos/${record.id}`,
            data: { vendorOrderId: record.id },
          });
        }
      }
    }

    if (order.customerId) {
      await this.inbox.notify({
        recipientId: order.customerId,
        type: 'order_received',
        title: `Recibimos tu pedido ${order.code}`,
        body: created.length > 1 ? `Lo preparan ${created.length} tiendas; verás el avance de cada una.` : 'Te avisaremos cada cambio de estado.',
        link: `/cuenta/pedidos/${order.id}`,
      });
    }
    await this.events.emit('marketplace.order.split', { orderId, vendorOrderIds: created.map(row => row.id) });
    return created;
  }

  /** El pago del pedido principal se refleja en los subpedidos que lo esperaban. */
  async syncPayment(orderId) {
    const order = this.order.orders.repository.byId(orderId);
    if (!order || order.paymentStatus !== 'paid') return { updated: 0 };
    let updated = 0;
    for (const vendorOrder of this.forOrder(orderId)) {
      if (!['created', 'payment_pending'].includes(vendorOrder.status)) continue;
      await this.transition(vendorOrder.id, 'paid', { actorType: 'system', note: 'Pago confirmado' });
      updated += 1;
    }
    if (updated && order.customerId) {
      await this.inbox.notify({
        recipientId: order.customerId, type: 'payment_confirmed', title: `Pago confirmado del pedido ${order.code}`,
        link: `/cuenta/pedidos/${order.id}`,
      });
    }
    return { updated };
  }

  assertTransition(vendorOrder, target, actorType) {
    const allowed = VENDOR_TRANSITIONS[vendorOrder.status] || [];
    if (!allowed.includes(target)) {
      throw new ConflictError(`No se puede pasar el subpedido de "${VENDOR_STATUS_LABELS[vendorOrder.status]}" a "${VENDOR_STATUS_LABELS[target] || target}".`, {
        from: vendorOrder.status, to: target, allowed,
      });
    }
    if (['seller', 'supplier'].includes(actorType) && !SELLER_ALLOWED_TARGETS.has(target)) {
      throw new ForbiddenError('Ese cambio de estado lo realiza la administración.');
    }
    if (target === 'cancelled' && ['seller', 'supplier'].includes(actorType) && ['shipped', 'in_transit', 'delivered'].includes(vendorOrder.status)) {
      throw new ConflictError('Un subpedido ya enviado no se cancela: solicita una devolución.');
    }
    // Sin pago confirmado solo se prepara si el cobro es contra entrega o en tienda.
    if (target === 'preparing' && vendorOrder.status === 'payment_pending'
      && !['cash_on_delivery', 'in_store'].includes(vendorOrder.paymentProvider)) {
      throw new ConflictError('Espera a que se confirme el pago antes de preparar el pedido.');
    }
    if (target === 'delivered' && vendorOrder.status === 'ready_to_ship' && !['pickup', 'local_delivery'].includes(vendorOrder.deliveryMode)) {
      throw new ConflictError('Un envío nacional debe marcarse como enviado antes de entregado.');
    }
  }

  /**
   * Cambia el estado de un subpedido y propaga el efecto al pedido principal.
   * @param {{actorType:'seller'|'supplier'|'admin'|'system', note?:string, tracking?:object, ctx?:object}} options
   */
  async transition(vendorOrderId, target, { actorType = 'system', note = null, tracking = null, ctx = null } = {}) {
    const vendorOrder = this.repository.retrieve(vendorOrderId);
    this.assertTransition(vendorOrder, target, actorType);
    const order = this.order.orders.repository.retrieve(vendorOrder.orderId);
    const patch = {
      status: target,
      statusHistory: [...(vendorOrder.statusHistory || []), { status: target, at: now(), actorType, note: note || null }],
    };
    if (tracking) patch.tracking = { ...(vendorOrder.tracking || {}), ...tracking };

    if (target === 'preparing' && order.status === 'confirmed') {
      await this.order.orders.transition(order.id, 'processing', ctx);
    }
    if (target === 'shipped' || (target === 'delivered' && ['ready_to_ship'].includes(vendorOrder.status))) {
      patch.fulfillmentId = await this.ship(vendorOrder, patch.tracking || vendorOrder.tracking || {}, ctx);
    }
    if (target === 'delivered') {
      const fulfillmentId = patch.fulfillmentId || vendorOrder.fulfillmentId;
      if (fulfillmentId) {
        const fulfillment = this.fulfillment.fulfillments.repository.byId(fulfillmentId);
        if (fulfillment && fulfillment.status === 'shipped') await this.fulfillment.fulfillments.deliver(fulfillmentId, ctx);
      }
      patch.deliveredAt = now();
    }
    if (target === 'cancelled') {
      for (const item of vendorOrder.items || []) {
        await this.inventory.service.release({ reference: order.id, lineItemId: item.lineItemId }, ctx);
      }
      patch.cancelledBy = actorType === 'system' ? 'system' : actorType;
      patch.cancelReason = note || null;
    }

    const result = await this.store.transaction(state => this.repository.patch(state, vendorOrderId, patch));
    const updated = result.after;
    await this.vendorOrders.emit(target, updated, ctx, vendorOrder);

    if (target === 'delivered') await this.finance.confirm(vendorOrderId);
    if (target === 'cancelled' || target === 'returned') await this.finance.reverse(vendorOrderId);
    if (target === 'cancelled') await this.afterCancel(updated, order, actorType);
    if (['shipped', 'delivered'].includes(target)) await this.checkStockOut(updated);
    await this.notifyBuyer(updated, order, target);
    return updated;
  }

  /** Crea y despacha el envío de las líneas del subpedido con el servicio de envíos. */
  async ship(vendorOrder, tracking, ctx) {
    if (vendorOrder.fulfillmentId) {
      const existing = this.fulfillment.fulfillments.repository.byId(vendorOrder.fulfillmentId);
      if (existing && ['shipped', 'delivered'].includes(existing.status)) return existing.id;
    }
    const current = this.order.orders.repository.retrieve(vendorOrder.orderId);
    const items = (vendorOrder.items || [])
      .map(item => {
        const line = (current.items || []).find(entry => entry.id === item.lineItemId);
        const pending = line ? line.quantity - Number(line.fulfilledQuantity || 0) : 0;
        return { lineItemId: item.lineItemId, quantity: Math.min(item.quantity, pending) };
      })
      .filter(item => item.quantity > 0);
    if (!items.length) return vendorOrder.fulfillmentId || null;
    const fulfillment = await this.fulfillment.fulfillments.createFor(vendorOrder.orderId, {
      items,
      locationId: vendorOrder.sellerId ? this.accounts.stockLocationFor(vendorOrder.sellerId)?.id || null : null,
      shippingOptionId: (current.shippingMethods || []).find(method => method.groupKey === vendorOrder.groupKey)?.shippingOptionId
        || current.shippingMethods?.[0]?.shippingOptionId || null,
      instructions: `Subpedido ${vendorOrder.code}`,
    }, ctx);
    await this.fulfillment.fulfillments.ship(fulfillment.id, {
      carrier: tracking.carrier || null,
      trackingNumber: tracking.trackingNumber || null,
      trackingUrl: tracking.trackingUrl || null,
    }, ctx);
    return fulfillment.id;
  }

  async afterCancel(vendorOrder, order, actorType) {
    const siblings = this.forOrder(order.id);
    if (siblings.every(row => row.status === 'cancelled')) {
      const fresh = this.order.orders.repository.retrieve(order.id);
      if (!['cancelled', 'completed'].includes(fresh.status) && !(fresh.paidTotal > fresh.refundedTotal)) {
        await this.order.orders.cancel(order.id, 'Todos los subpedidos fueron cancelados', null).catch(() => {});
      }
    }
    if (['seller', 'supplier'].includes(actorType) || order.paidTotal > order.refundedTotal) {
      // Incidencia: cancelación de la tienda o importe cobrado que hay que devolver.
      await this.alerts?.raise({
        type: 'vendor_order_cancelled',
        severity: order.paidTotal > order.refundedTotal ? 'critical' : 'warning',
        message: `Subpedido ${vendorOrder.code} cancelado por ${actorType}.${order.paidTotal > order.refundedTotal ? ' Hay importes cobrados: revisa el reembolso.' : ''}`,
        entityId: vendorOrder.id,
        entityType: 'vendorOrder',
      });
      await this.inbox.notifyStaff({
        type: 'problem_order',
        title: `Pedido con incidencia: ${vendorOrder.code}`,
        body: vendorOrder.cancelReason || 'Cancelado sin motivo indicado.',
        link: `/admin/pedidos?codigo=${encodeURIComponent(order.code)}`,
      });
    }
  }

  /** Aviso de producto agotado a la tienda después de consumir stock. */
  async checkStockOut(vendorOrder) {
    if (vendorOrder.partyType !== 'seller') return;
    const seller = this.accounts.sellers.repository.byId(vendorOrder.sellerId);
    if (!seller) return;
    for (const item of vendorOrder.items || []) {
      const availability = this.inventory.service.availabilityFor(item.variantId);
      if (availability.state !== 'out_of_stock') continue;
      await this.accounts.notifyOwners(seller, {
        type: 'out_of_stock',
        title: `Agotado: ${item.title}`,
        body: 'Repón el stock para que vuelva a venderse.',
        link: `/mi-tienda/${seller.id}/productos/${item.productId}`,
        data: { productId: item.productId, variantId: item.variantId },
      });
    }
  }

  async notifyBuyer(vendorOrder, order, target) {
    if (!order.customerId) return;
    const messages = {
      shipped: ['order_shipped', `Tu pedido ${vendorOrder.code} fue enviado`],
      in_transit: ['order_in_transit', `Tu pedido ${vendorOrder.code} está en camino`],
      delivered: ['order_delivered', `Tu pedido ${vendorOrder.code} fue entregado. ¿Qué te pareció?`],
      cancelled: ['order_cancelled', `El subpedido ${vendorOrder.code} fue cancelado`],
      ready_to_ship: ['order_ready', `Tu pedido ${vendorOrder.code} está listo${vendorOrder.deliveryMode === 'pickup' ? ' para retirar' : ''}`],
    };
    const message = messages[target];
    if (!message) return;
    const customer = this.customer.customers.repository.byId(order.customerId);
    await this.inbox.notify({
      recipientId: order.customerId,
      type: message[0],
      title: message[1],
      body: vendorOrder.tracking?.trackingNumber ? `Seguimiento: ${vendorOrder.tracking.trackingNumber}` : null,
      link: `/cuenta/pedidos/${order.id}`,
      email: customer?.email || null,
    });
  }

  /** Estado agregado que ve el comprador en el pedido principal. */
  aggregateStatus(vendorOrders) {
    if (!vendorOrders.length) return null;
    const statuses = vendorOrders.map(row => row.status);
    const order = ['created', 'payment_pending', 'paid', 'preparing', 'ready_to_ship', 'shipped', 'in_transit', 'delivered', 'returned'];
    const live = statuses.filter(status => status !== 'cancelled');
    if (!live.length) return 'cancelled';
    // El estado global es el del subpedido **menos** avanzado: el pedido no está
    // entregado hasta que lo está la última tienda.
    return live.sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
  }

  /** Vista del comprador: sin comisiones ni pagos a la tienda. */
  buyerView(vendorOrder) {
    const seller = vendorOrder.sellerId ? this.accounts.sellers.repository.byId(vendorOrder.sellerId) : null;
    return {
      id: vendorOrder.id,
      code: vendorOrder.code,
      partyType: vendorOrder.partyType,
      seller: seller ? { id: seller.id, code: seller.code, name: seller.name } : null,
      fulfilledBy: vendorOrder.partyType === 'seller' ? seller?.name || 'Tienda' : vendorOrder.partyType === 'supplier' ? 'Proveedor aliado' : 'Ndivepa',
      status: vendorOrder.status,
      statusLabel: VENDOR_STATUS_LABELS[vendorOrder.status],
      items: (vendorOrder.items || []).map(item => ({
        lineItemId: item.lineItemId, productId: item.productId, title: item.title, variantTitle: item.variantTitle,
        quantity: item.quantity, unitPrice: item.unitPrice, total: item.total,
      })),
      total: vendorOrder.total,
      shippingShare: vendorOrder.shippingShare,
      currencyCode: vendorOrder.currencyCode,
      deliveryMode: vendorOrder.deliveryMode,
      tracking: vendorOrder.tracking || null,
      statusHistory: vendorOrder.statusHistory || [],
      deliveredAt: vendorOrder.deliveredAt || null,
      reviewable: vendorOrder.status === 'delivered',
    };
  }

  /**
   * Vista de la tienda: sus números y lo mínimo del comprador para entregar
   * (nombre, teléfono y dirección solo si hay que llevar el pedido).
   */
  sellerView(vendorOrder) {
    const order = this.order.orders.repository.byId(vendorOrder.orderId);
    const address = order?.shippingAddress || {};
    const needsAddress = !['pickup'].includes(vendorOrder.deliveryMode);
    return {
      ...vendorOrder,
      statusLabel: VENDOR_STATUS_LABELS[vendorOrder.status],
      allowedTransitions: (VENDOR_TRANSITIONS[vendorOrder.status] || []).filter(status => SELLER_ALLOWED_TARGETS.has(status)),
      buyer: {
        name: [address.firstName, address.lastName].filter(Boolean).join(' ') || 'Cliente',
        phone: address.phone || null,
        address: needsAddress ? {
          address1: address.address1 || null, address2: address.address2 || null, city: address.city || null,
          province: address.province || null, instructions: address.instructions || null,
        } : null,
      },
      note: order?.note || null,
      placedAt: order?.placedAt || null,
    };
  }

  /** Autorización por recurso para la tienda. */
  ownedBySeller(sellerId, vendorOrderId) {
    const vendorOrder = this.repository.byId(vendorOrderId);
    if (!vendorOrder || vendorOrder.sellerId !== sellerId) throw new NotFoundError('subpedido', vendorOrderId);
    return vendorOrder;
  }

  isOpen(vendorOrder) {
    return OPEN_STATUSES.has(vendorOrder.status);
  }
}
