/**
 * Carrito (M-0581 … M-0610).
 *
 * Solo existe en modo `HYBRID` o `DIRECT`: en modo `AFFILIATE` estas rutas responden
 * `409 commerce_mode_disabled`, porque Ndivepa no cobra al cliente (M-0724).
 *
 * El precio unitario se **congela** en la línea al añadirla, y el recálculo detecta si
 * el precio de catálogo cambió desde entonces, para avisar en lugar de cobrar otra
 * cifra en silencio (M-0598).
 */
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule } from '../../framework/validate.js';
import { ConflictError, NotFoundError, ValidationError } from '../../framework/errors.js';
import { add, clampToZero, distribute } from '../../framework/money.js';
import { id as generateId, token as generateToken } from '../../framework/ids.js';
import { createHmac } from 'node:crypto';
import { now, plusMinutes, toDate } from '../../framework/dates.js';

export const cartResource = defineResource({
  name: 'cart',
  collection: 'carts',
  prefix: 'cart',
  route: 'carts',
  searchable: ['email'],
  fields: {
    channelId: rule.id(),
    regionId: rule.id(),
    currencyCode: rule.currency({ required: true }),
    customerId: rule.id(),
    email: rule.email(),
    // Cookie del visitante: permite recuperar el carrito sin pedir cuenta.
    visitorId: rule.text(80),
    items: { type: 'array', default: [] },
    shippingAddress: { type: 'object', shape: {}, allowUnknown: true },
    billingAddress: { type: 'object', shape: {}, allowUnknown: true },
    shippingMethod: { type: 'object', shape: {}, allowUnknown: true },
    appliedPromotions: { type: 'array', default: [] },
    couponCodes: rule.list({ type: 'string' }, { default: [] }),
    giftCardCodes: rule.list({ type: 'string' }, { default: [] }),
    surcharges: { type: 'array', default: [] },
    note: rule.text(1000),
    subtotal: rule.minor({ default: 0 }),
    discountTotal: rule.minor({ default: 0 }),
    shippingTotal: rule.minor({ default: 0 }),
    taxTotal: rule.minor({ default: 0 }),
    surchargeTotal: rule.minor({ default: 0 }),
    total: rule.minor({ default: 0 }),
    giftCardTotal: rule.minor({ default: 0 }),
    payableTotal: rule.minor({ default: 0 }),
    warnings: { type: 'array', default: [] },
    status: rule.enumOf(['active', 'abandoned', 'completed', 'expired'], { default: 'active' }),
    completedAt: rule.date(),
    abandonedAt: rule.date(),
    lastActivityAt: rule.date(),
    recoveryToken: rule.text(120),
    metadata: rule.metadata(),
  },
});

const MAX_LINE_QUANTITY = 999;

export class CartService extends BaseService {
  constructor(deps) {
    super(deps, cartResource);
    this.settings = deps.settings;
    this.catalog = deps.catalog;
    this.pricing = deps.pricing;
    this.inventory = deps.inventory;
    this.tax = deps.tax;
    this.geography = deps.geography;
    this.channel = deps.channel;
    this.customer = deps.customer;
    this.promotion = deps.promotion;
    this.locks = deps.locks;
    this.config = deps.config;
  }

  assertEnabled() {
    this.settings.assertCapability('cart');
  }

  /** Contexto de precio y promoción del carrito. */
  contextFor(cart) {
    const customer = cart.customerId ? this.customer.customers.repository.byId(cart.customerId) : null;
    const customerGroupIds = cart.customerId ? this.customer.customers.groupsFor(cart.customerId) : [];
    const metrics = cart.customerId ? this.customer.customers.metrics(cart.customerId) : { orders: 0 };
    return {
      regionId: cart.regionId || null,
      channelId: cart.channelId || null,
      currencyCode: cart.currencyCode,
      customerId: cart.customerId || null,
      customerGroupIds,
      customerOrderCount: metrics.orders,
      taxExempt: Boolean(customer?.taxExempt),
    };
  }

  async createCart({ channelId = null, regionId = null, currencyCode = null, customerId = null, email = null, visitorId = null }, ctx = null) {
    this.assertEnabled();
    const channel = channelId ? this.channel.channels.repository.byId(channelId) : this.channel.channels.default();
    const region = regionId
      ? this.geography.regions.repository.byId(regionId)
      : (channel?.defaultRegionId ? this.geography.regions.repository.byId(channel.defaultRegionId) : this.geography.regions.default());
    const currency = String(currencyCode || region?.currencyCode || this.settings.get('defaultCurrency', 'USD')).toUpperCase();

    return this.create({
      channelId: channel?.id || null,
      regionId: region?.id || null,
      currencyCode: currency,
      customerId,
      email,
      visitorId: visitorId || generateId('vis'),
      items: [],
      couponCodes: [],
      giftCardCodes: [],
      appliedPromotions: [],
      surcharges: [],
      warnings: [],
      status: 'active',
      lastActivityAt: now(),
      recoveryToken: generateToken(18),
    }, ctx);
  }

  retrieveActive(cartId) {
    const cart = this.repository.retrieve(cartId);
    if (cart.status === 'completed') throw new ConflictError('El carrito ya se confirmó y no admite cambios.', { cartId });
    if (cart.status === 'expired') throw new ConflictError('El carrito ha caducado.', { cartId });
    return cart;
  }

  /** Añade o incrementa una línea, validando disponibilidad (M-0586). */
  async addLine(cartId, { variantId, quantity = 1, metadata = {} }, ctx = null) {
    this.assertEnabled();
    return this.locks.withLock(`cart:${cartId}`, async () => {
      const cart = this.retrieveActive(cartId);
      const variant = this.catalog.variants.repository.byId(variantId);
      if (!variant || !variant.active) throw new NotFoundError('variante', variantId);
      const product = this.catalog.products.repository.byId(variant.productId);
      if (!product || product.status !== 'published') {
        throw new ConflictError('El producto no está publicado.', { productId: variant.productId });
      }
      if (product.monetizationType === 'AFFILIATE') {
        throw new ConflictError(
          'Este producto se vende en el comercio afiliado; no se puede añadir al carrito.',
          { productId: product.id, monetizationType: product.monetizationType },
        );
      }
      if (quantity < 1 || quantity > MAX_LINE_QUANTITY) {
        throw ValidationError.single('quantity', `La cantidad debe estar entre 1 y ${MAX_LINE_QUANTITY}.`);
      }

      const context = this.contextFor(cart);
      const existing = (cart.items || []).find(item => item.variantId === variantId);
      const nextQuantity = (existing?.quantity || 0) + quantity;

      const availability = this.inventory.service.availabilityFor(variantId);
      if (availability.state === 'out_of_stock') {
        throw new ConflictError('La variante está agotada.', { variantId, availability: availability.state });
      }
      if (availability.available !== null && !availability.backorder && nextQuantity > availability.available) {
        throw new ConflictError(`Solo quedan ${availability.available} unidad(es) disponibles.`, { variantId, available: availability.available });
      }

      const price = this.pricing.calculation.calculate({
        variantId,
        currencyCode: cart.currencyCode,
        regionId: context.regionId,
        channelId: context.channelId,
        customerGroupIds: context.customerGroupIds,
        quantity: nextQuantity,
        taxCategoryId: variant.taxCategoryId || product.taxCategoryId || null,
      });
      if (price.amount === null) {
        throw new ConflictError('La variante no tiene precio en la moneda del carrito.', { variantId, currencyCode: cart.currencyCode });
      }

      const items = existing
        ? (cart.items || []).map(item => (item.variantId === variantId
          ? { ...item, quantity: nextQuantity, unitPrice: price.amount, total: price.amount * nextQuantity, priceListId: price.priceListId }
          : item))
        : [...(cart.items || []), {
          id: generateId('li'),
          variantId,
          productId: product.id,
          title: product.name,
          variantTitle: variant.title,
          sku: variant.sku || null,
          thumbnail: product.primaryAssetId || product.image || null,
          quantity: nextQuantity,
          unitPrice: price.amount,
          originalUnitPrice: price.originalAmount ?? price.amount,
          total: price.amount * nextQuantity,
          priceListId: price.priceListId,
          hasPriceListDiscount: Boolean(price.priceListId),
          taxCategoryId: variant.taxCategoryId || product.taxCategoryId || null,
          categoryId: product.categoryId || null,
          collectionIds: product.collectionIds || [],
          facetValueIds: product.facetValueIds || [],
          requiresShipping: variant.manageInventory && product.type === 'physical',
          shippingProfileId: product.shippingProfileId || null,
          adjustments: [],
          taxLines: [],
          giftWrap: null,
          metadata,
        }];

      await this.store.transaction(state => this.repository.patch(state, cartId, { items, lastActivityAt: now() }));
      return this.recalculate(cartId, ctx);
    });
  }

  async updateLine(cartId, lineItemId, { quantity, giftWrap = undefined, metadata = undefined }, ctx = null) {
    this.assertEnabled();
    const cart = this.retrieveActive(cartId);
    const line = (cart.items || []).find(item => item.id === lineItemId);
    if (!line) throw new NotFoundError('línea de carrito', lineItemId);

    if (quantity !== undefined && quantity <= 0) return this.removeLine(cartId, lineItemId, ctx);
    if (quantity !== undefined && quantity > MAX_LINE_QUANTITY) {
      throw ValidationError.single('quantity', `La cantidad máxima por línea es ${MAX_LINE_QUANTITY}.`);
    }

    const items = (cart.items || []).map(item => (item.id === lineItemId
      ? {
        ...item,
        quantity: quantity ?? item.quantity,
        total: (quantity ?? item.quantity) * item.unitPrice,
        giftWrap: giftWrap === undefined ? item.giftWrap : giftWrap,
        metadata: metadata === undefined ? item.metadata : metadata,
      }
      : item));

    await this.store.transaction(state => this.repository.patch(state, cartId, { items, lastActivityAt: now() }));
    return this.recalculate(cartId, ctx);
  }

  async removeLine(cartId, lineItemId, ctx = null) {
    this.assertEnabled();
    const cart = this.retrieveActive(cartId);
    const items = (cart.items || []).filter(item => item.id !== lineItemId);
    await this.store.transaction(state => this.repository.patch(state, cartId, { items, lastActivityAt: now() }));
    return this.recalculate(cartId, ctx);
  }

  async setAddresses(cartId, { shippingAddress, billingAddress, email }, ctx = null) {
    this.assertEnabled();
    this.retrieveActive(cartId);
    if (shippingAddress) this.customer.addresses.assertComplete(shippingAddress);
    if (billingAddress) this.customer.addresses.assertComplete(billingAddress);
    await this.store.transaction(state => this.repository.patch(state, cartId, {
      ...(shippingAddress ? { shippingAddress } : {}),
      ...(billingAddress ? { billingAddress } : {}),
      ...(email ? { email } : {}),
      lastActivityAt: now(),
    }));
    return this.recalculate(cartId, ctx);
  }

  async setShippingMethod(cartId, shippingMethod, ctx = null) {
    this.assertEnabled();
    this.retrieveActive(cartId);
    await this.store.transaction(state => this.repository.patch(state, cartId, { shippingMethod, lastActivityAt: now() }));
    return this.recalculate(cartId, ctx);
  }

  async applyCoupon(cartId, code, ctx = null) {
    this.assertEnabled();
    const cart = this.retrieveActive(cartId);
    const normalized = String(code || '').trim().toUpperCase();
    if (!normalized) throw ValidationError.single('code', 'Indica un código.');
    const coupon = this.promotion.coupons.repository.find({ code: normalized, active: true });
    if (!coupon) throw ValidationError.single('code', 'El código no es válido.');
    const codes = [...new Set([...(cart.couponCodes || []), normalized])];
    await this.store.transaction(state => this.repository.patch(state, cartId, { couponCodes: codes, lastActivityAt: now() }));
    const recalculated = await this.recalculate(cartId, ctx);
    // Si el cupón no aportó nada se retira y se explica por qué (M-0805).
    const applied = (recalculated.appliedPromotions || []).some(entry => entry.code === normalized);
    if (!applied) {
      await this.store.transaction(state => this.repository.patch(state, cartId, {
        couponCodes: codes.filter(entry => entry !== normalized),
      }));
      const reason = (recalculated.promotionEvaluation || [])
        .find(entry => entry.promotionId === coupon.promotionId)?.reasons?.[0];
      throw new ConflictError(reason || 'El cupón no aplica a este carrito.', { code: normalized });
    }
    return recalculated;
  }

  async removeCoupon(cartId, code, ctx = null) {
    this.assertEnabled();
    const cart = this.retrieveActive(cartId);
    const normalized = String(code || '').trim().toUpperCase();
    await this.store.transaction(state => this.repository.patch(state, cartId, {
      couponCodes: (cart.couponCodes || []).filter(entry => entry !== normalized),
      lastActivityAt: now(),
    }));
    return this.recalculate(cartId, ctx);
  }

  async applyGiftCard(cartId, code, ctx = null) {
    this.assertEnabled();
    this.settings.assertCapability('giftCard');
    const cart = this.retrieveActive(cartId);
    const card = this.promotion.giftCards.byCode(code);
    if (!card || card.status !== 'active') throw ValidationError.single('code', 'La tarjeta regalo no está disponible.');
    if (card.currencyCode !== cart.currencyCode) {
      throw ValidationError.single('code', `La tarjeta regalo está en ${card.currencyCode} y el carrito en ${cart.currencyCode}.`);
    }
    const codes = [...new Set([...(cart.giftCardCodes || []), card.code])];
    await this.store.transaction(state => this.repository.patch(state, cartId, { giftCardCodes: codes, lastActivityAt: now() }));
    return this.recalculate(cartId, ctx);
  }

  /**
   * Recalcula el carrito completo (M-0597).
   *
   * Orden: precios de línea -> promociones -> envío -> impuestos -> recargos ->
   * tarjetas regalo. El orden importa: el impuesto se calcula sobre el importe ya
   * descontado, y la tarjeta regalo se aplica al final porque es un pago.
   */
  async recalculate(cartId, ctx = null) {
    const cart = this.repository.retrieve(cartId);
    const context = this.contextFor(cart);
    const warnings = [];
    const items = [];

    for (const line of cart.items || []) {
      const variant = this.catalog.variants.repository.byId(line.variantId);
      const product = this.catalog.products.repository.byId(line.productId);

      if (!variant?.active || product?.status !== 'published') {
        warnings.push({ code: 'line_unavailable', lineItemId: line.id, message: `${line.title} dejó de estar disponible.` });
      }

      const price = this.pricing.calculation.calculate({
        variantId: line.variantId,
        currencyCode: cart.currencyCode,
        regionId: context.regionId,
        channelId: context.channelId,
        customerGroupIds: context.customerGroupIds,
        quantity: line.quantity,
        taxCategoryId: line.taxCategoryId,
      });

      // Precio cambiado desde que se añadió: se avisa y se mantiene el congelado.
      if (price.amount !== null && price.amount !== line.unitPrice) {
        warnings.push({
          code: 'price_changed',
          lineItemId: line.id,
          message: `El precio de ${line.title} cambió de ${line.unitPrice} a ${price.amount}.`,
          from: line.unitPrice,
          to: price.amount,
        });
      }

      const availability = variant ? this.inventory.service.availabilityFor(line.variantId) : { state: 'out_of_stock', available: 0, backorder: false };
      if (availability.available !== null && !availability.backorder && line.quantity > availability.available) {
        warnings.push({
          code: 'insufficient_stock',
          lineItemId: line.id,
          message: `Solo quedan ${availability.available} unidad(es) de ${line.title}.`,
          available: availability.available,
        });
      }

      items.push({ ...line, total: line.unitPrice * line.quantity, adjustments: [], taxLines: [], availability: availability.state });
    }

    const subtotal = items.reduce((sum, item) => sum + item.total, 0);
    const shippingBase = Number(cart.shippingMethod?.amount || 0);

    // Promociones.
    const promotionResult = this.promotion.promotions.apply({
      ...context,
      items,
      itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
      subtotal,
      shippingTotal: shippingBase,
      couponCodes: cart.couponCodes || [],
    });

    for (const applied of promotionResult.applied) {
      for (const allocation of applied.allocations || []) {
        const line = items.find(item => item.id === allocation.lineItemId);
        if (!line) continue;
        line.adjustments = [...(line.adjustments || []), {
          id: generateId('adj'),
          promotionId: applied.promotionId,
          code: applied.code,
          description: applied.label,
          amount: allocation.amount,
        }];
      }
    }
    for (const line of items) {
      const discount = (line.adjustments || []).reduce((sum, adjustment) => sum + adjustment.amount, 0);
      line.discountTotal = discount;
      line.subtotalAfterDiscount = clampToZero(line.total - discount);
    }

    const discountTotal = promotionResult.discountTotal;
    const shippingTotal = clampToZero(shippingBase - promotionResult.shippingDiscount);

    // Impuestos sobre el importe ya descontado.
    const taxResult = this.tax.calculation.calculate({
      lines: items.map(item => ({ id: item.id, amount: item.subtotalAfterDiscount, taxCategoryId: item.taxCategoryId })),
      address: cart.shippingAddress || {},
      region: context.regionId ? this.geography.regions.repository.byId(context.regionId) : null,
      customerGroupIds: context.customerGroupIds,
      taxExempt: context.taxExempt,
      shipping: { amount: shippingTotal },
    });
    for (const taxLine of taxResult.lines) {
      const line = items.find(item => item.id === taxLine.id);
      if (line) {
        line.taxLines = taxLine.taxLines;
        line.taxTotal = taxLine.tax;
      }
    }

    const surchargeTotal = (cart.surcharges || []).reduce((sum, surcharge) => sum + Number(surcharge.amount || 0), 0);
    const taxTotal = taxResult.inclusive ? 0 : taxResult.totalTax;
    const total = clampToZero(add(subtotal, -discountTotal, shippingTotal, taxTotal, surchargeTotal));

    // Tarjetas regalo: reducen lo que queda por cobrar, no el total (M-0811).
    let giftCardTotal = 0;
    for (const code of cart.giftCardCodes || []) {
      const card = this.promotion.giftCards.byCode(code);
      if (!card || card.status !== 'active' || card.currencyCode !== cart.currencyCode) continue;
      const applicable = Math.min(card.balance, total - giftCardTotal);
      if (applicable > 0) giftCardTotal += applicable;
    }

    const updated = await this.store.transaction(state => this.repository.patch(state, cartId, {
      items,
      subtotal,
      discountTotal,
      shippingTotal,
      taxTotal,
      surchargeTotal,
      total,
      giftCardTotal,
      payableTotal: clampToZero(total - giftCardTotal),
      appliedPromotions: promotionResult.applied,
      promotionEvaluation: promotionResult.evaluated,
      taxBreakdown: taxResult.breakdown,
      taxInclusive: taxResult.inclusive,
      warnings,
      lastActivityAt: now(),
    }));

    return updated.after;
  }

  /**
   * Fusiona el carrito de invitado con el del cliente al iniciar sesión.
   * Estrategia por defecto: combinar líneas (M-0590, M-0591).
   */
  async merge({ guestCartId, customerId, strategy = 'combine' }, ctx = null) {
    this.assertEnabled();
    const guest = this.repository.byId(guestCartId);
    if (!guest) throw new NotFoundError('carrito', guestCartId);
    const existing = this.repository
      .all({ customerId, status: 'active' })
      .filter(cart => cart.id !== guestCartId)
      .sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)))[0];

    if (!existing) {
      await this.store.transaction(state => this.repository.patch(state, guestCartId, { customerId }));
      return this.recalculate(guestCartId, ctx);
    }

    if (strategy === 'use_existing') {
      await this.store.transaction(state => this.repository.patch(state, guestCartId, { status: 'expired' }));
      return this.recalculate(existing.id, ctx);
    }
    if (strategy === 'use_guest') {
      await this.store.transaction(state => {
        this.repository.patch(state, existing.id, { status: 'expired' });
        this.repository.patch(state, guestCartId, { customerId });
      });
      return this.recalculate(guestCartId, ctx);
    }

    const merged = [...(existing.items || [])];
    for (const line of guest.items || []) {
      const match = merged.find(item => item.variantId === line.variantId);
      if (match) match.quantity = Math.min(MAX_LINE_QUANTITY, match.quantity + line.quantity);
      else merged.push({ ...line, id: generateId('li') });
    }
    await this.store.transaction(state => {
      this.repository.patch(state, existing.id, {
        items: merged,
        couponCodes: [...new Set([...(existing.couponCodes || []), ...(guest.couponCodes || [])])],
        lastActivityAt: now(),
      });
      this.repository.patch(state, guestCartId, { status: 'expired' });
    });
    return this.recalculate(existing.id, ctx);
  }

  /** Marca los carritos inactivos como abandonados (M-0602). */
  async markAbandoned() {
    const hours = this.config.maintenance.cartTtlHours;
    const threshold = Date.now() - hours * 3_600_000;
    const candidates = this.repository
      .all({ status: 'active' })
      .filter(cart => (cart.items || []).length > 0)
      .filter(cart => (toDate(cart.lastActivityAt)?.getTime() ?? 0) < threshold);
    if (!candidates.length) return { abandoned: 0 };

    await this.store.transaction(state => {
      for (const cart of candidates) {
        this.repository.patch(state, cart.id, { status: 'abandoned', abandonedAt: now() });
      }
    });
    for (const cart of candidates) {
      await this.events.emit('cart.abandoned', { cartId: cart.id, items: (cart.items || []).length, email: cart.email });
      await this.inventory.service.release({ reference: cart.id });
    }
    return { abandoned: candidates.length };
  }

  /** Enlace de recuperación firmado (M-0603). */
  recoveryLink(cart, baseUrl) {
    const signature = createHmac('sha256', cart.recoveryToken || 'ndivepa').update(cart.id).digest('hex').slice(0, 32);
    return `${baseUrl}/carrito/recuperar?cart=${cart.id}&t=${signature}`;
  }

  verifyRecovery(cartId, signature) {
    const cart = this.repository.byId(cartId);
    if (!cart) return null;
    const expected = createHmac('sha256', cart.recoveryToken || 'ndivepa').update(cart.id).digest('hex').slice(0, 32);
    return expected === signature ? cart : null;
  }

  /** Reserva el stock del carrito durante el checkout. */
  async reserveStock(cart, ctx = null) {
    const reservations = [];
    for (const line of cart.items || []) {
      const result = await this.inventory.service.reserve({
        variantId: line.variantId,
        quantity: line.quantity,
        reference: cart.id,
        referenceType: 'cart',
        lineItemId: line.id,
        ttlMinutes: this.config.maintenance.reservationTtlMinutes,
      }, ctx);
      reservations.push(...(result.reservations || []));
    }
    return reservations;
  }

  /** Métricas de abandono por paso del checkout (M-0604). */
  abandonmentFunnel() {
    const carts = this.repository.all();
    const stage = cart => {
      if (cart.status === 'completed') return 'completed';
      if (cart.shippingMethod?.amount !== undefined) return 'shipping_selected';
      if (cart.shippingAddress?.address1) return 'address_entered';
      if ((cart.items || []).length) return 'items_added';
      return 'created';
    };
    const counts = {};
    for (const cart of carts) {
      const key = stage(cart);
      counts[key] = (counts[key] || 0) + 1;
    }
    const total = carts.length || 1;
    return {
      total: carts.length,
      stages: ['created', 'items_added', 'address_entered', 'shipping_selected', 'completed'].map(key => ({
        stage: key,
        count: counts[key] || 0,
        percent: Math.round(((counts[key] || 0) / total) * 100),
      })),
      abandoned: carts.filter(cart => cart.status === 'abandoned').length,
    };
  }

  /** Forma pública del carrito para la tienda. */
  publicView(cart) {
    if (!cart) return null;
    const { recoveryToken: _token, promotionEvaluation: _evaluation, ...rest } = cart;
    return rest;
  }
}

export default {
  name: 'cart',
  requires: [
    'store', 'events', 'audit', 'config', 'customFields', 'settings', 'catalog', 'pricing',
    'inventory', 'tax', 'geography', 'channel', 'customer', 'promotion', 'locks',
  ],
  resources: [cartResource],
  permissions: [{ resource: 'cart', description: 'Carritos de compra.' }],

  register(deps) {
    return new CartService(deps);
  },

  jobs: container => [
    {
      name: 'cart.mark-abandoned',
      everyMs: 60 * 60_000,
      handler: () => container.resolve('cart').markAbandoned(),
    },
  ],

  routes: {
    admin: container => {
      const service = () => container.resolve('cart');
      return [
        ...crudRoutes(cartResource, () => service(), { tags: ['carrito'] }),
        {
          method: 'GET',
          path: '/carts/abandonment',
          permission: 'cart:read',
          summary: 'Embudo de abandono por paso del checkout.',
          tags: ['carrito'],
          bodyless: true,
          handler: () => service().abandonmentFunnel(),
        },
        {
          method: 'POST',
          path: '/carts/:id/recalculate',
          permission: 'cart:update',
          summary: 'Fuerza el recálculo de un carrito.',
          tags: ['carrito'],
          handler: ctx => service().recalculate(ctx.params.id, ctx),
        },
      ];
    },

    store: container => {
      const service = () => container.resolve('cart');
      const cartOf = ctx => service().publicView(service().repository.retrieve(ctx.params.id));
      return [
        {
          method: 'POST',
          path: '/carts',
          permission: null,
          csrf: false,
          summary: 'Crea un carrito. Solo disponible en modo HYBRID o DIRECT.',
          tags: ['store'],
          status: 201,
          body: {
            channelId: rule.id(),
            regionId: rule.id(),
            currencyCode: rule.currency(),
            email: rule.email(),
          },
          handler: async ctx => {
            const customerId = ctx.cookies.ndivepa_customer || null;
            const cart = await service().createCart({
              ...ctx.body,
              customerId,
              channelId: ctx.body.channelId || ctx.channelId,
              visitorId: ctx.cookies.ndivepa_visitor || null,
            }, ctx);
            return service().publicView(cart);
          },
        },
        {
          method: 'GET',
          path: '/carts/:id',
          permission: null,
          summary: 'Recupera un carrito.',
          tags: ['store'],
          bodyless: true,
          handler: ctx => cartOf(ctx),
        },
        {
          method: 'POST',
          path: '/carts/:id/line-items',
          permission: null,
          csrf: false,
          summary: 'Añade una variante al carrito.',
          tags: ['store'],
          status: 201,
          body: {
            variantId: rule.id({ required: true }),
            quantity: rule.quantity({ default: 1, min: 1 }),
            metadata: rule.metadata(),
          },
          handler: async ctx => service().publicView(await service().addLine(ctx.params.id, ctx.body, ctx)),
        },
        {
          method: 'PATCH',
          path: '/carts/:id/line-items/:lineId',
          permission: null,
          csrf: false,
          summary: 'Actualiza una línea del carrito.',
          tags: ['store'],
          body: {
            quantity: rule.quantity(),
            giftWrap: { type: 'object', shape: { message: rule.text(300), style: rule.text(60) } },
            metadata: rule.metadata(),
          },
          handler: async ctx => service().publicView(await service().updateLine(ctx.params.id, ctx.params.lineId, ctx.body, ctx)),
        },
        {
          method: 'DELETE',
          path: '/carts/:id/line-items/:lineId',
          permission: null,
          csrf: false,
          summary: 'Quita una línea del carrito.',
          tags: ['store'],
          bodyless: true,
          handler: async ctx => service().publicView(await service().removeLine(ctx.params.id, ctx.params.lineId, ctx)),
        },
        {
          method: 'POST',
          path: '/carts/:id/addresses',
          permission: null,
          csrf: false,
          summary: 'Define las direcciones de envío y facturación.',
          tags: ['store'],
          body: {
            shippingAddress: { type: 'object', shape: {}, allowUnknown: true },
            billingAddress: { type: 'object', shape: {}, allowUnknown: true },
            email: rule.email(),
          },
          handler: async ctx => service().publicView(await service().setAddresses(ctx.params.id, ctx.body, ctx)),
        },
        {
          method: 'POST',
          path: '/carts/:id/coupons',
          permission: null,
          csrf: false,
          summary: 'Aplica un cupón y explica el motivo si no aplica.',
          tags: ['store'],
          body: { code: rule.text(40, { required: true }) },
          handler: async ctx => service().publicView(await service().applyCoupon(ctx.params.id, ctx.body.code, ctx)),
        },
        {
          method: 'DELETE',
          path: '/carts/:id/coupons/:code',
          permission: null,
          csrf: false,
          summary: 'Retira un cupón del carrito.',
          tags: ['store'],
          bodyless: true,
          handler: async ctx => service().publicView(await service().removeCoupon(ctx.params.id, ctx.params.code, ctx)),
        },
        {
          method: 'POST',
          path: '/carts/:id/gift-cards',
          permission: null,
          csrf: false,
          summary: 'Aplica una tarjeta regalo como pago parcial.',
          tags: ['store'],
          body: { code: rule.text(40, { required: true }) },
          handler: async ctx => service().publicView(await service().applyGiftCard(ctx.params.id, ctx.body.code, ctx)),
        },
        {
          method: 'POST',
          path: '/carts/:id/merge',
          permission: null,
          csrf: false,
          summary: 'Fusiona el carrito de invitado con el del cliente.',
          tags: ['store'],
          body: { strategy: rule.enumOf(['combine', 'use_existing', 'use_guest'], { default: 'combine' }) },
          handler: async ctx => {
            const customerId = ctx.cookies.ndivepa_customer;
            if (!customerId) throw new ConflictError('No hay una sesión de cliente activa.');
            const cart = await service().merge({ guestCartId: ctx.params.id, customerId, strategy: ctx.body.strategy }, ctx);
            return service().publicView(cart);
          },
        },
      ];
    },
  },
};
