/**
 * Promociones, campañas y tarjetas regalo (M-0761 … M-0860).
 *
 * Modelo híbrido: la estructura de Medusa (`promotion` + `applicationMethod` +
 * `promotionRule` + `campaign` con presupuesto) y el catálogo de condiciones y
 * acciones de Vendure.
 *
 * Dos reglas que las pruebas protegen:
 *  - el total **nunca** queda negativo (M-0846, M-0847);
 *  - una promoción afiliada **jamás** modifica la URL del enlace (M-0849, M-0856):
 *    solo puede mostrar información.
 */
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule } from '../../framework/validate.js';
import { ConflictError, ValidationError } from '../../framework/errors.js';
import { clampToZero, distribute, percentage } from '../../framework/money.js';
import { humanCode } from '../../framework/ids.js';
import { isActiveNow, now, weekdayName } from '../../framework/dates.js';

export const PROMOTION_TYPES = ['standard', 'automatic', 'buyget', 'informational'];
export const TARGETS = ['order', 'items', 'shipping'];
export const OPERATORS = ['eq', 'ne', 'in', 'nin', 'gt', 'gte', 'lt', 'lte'];

export const campaignResource = defineResource({
  name: 'promotionCampaign',
  collection: 'promotionCampaigns',
  prefix: 'camp',
  route: 'promotion-campaigns',
  unique: ['code'],
  searchable: ['name', 'code'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(140, { required: true }),
    description: rule.text(500),
    startsAt: rule.date(),
    endsAt: rule.date(),
    // Presupuesto por gasto o por número de usos (M-0798, M-0799).
    budget: {
      type: 'object',
      shape: {
        type: rule.enumOf(['spend', 'usage']),
        limit: rule.minor(),
        currencyCode: rule.currency(),
      },
    },
    consumed: rule.minor({ default: 0 }),
    consumedUsage: rule.quantity({ default: 0 }),
    status: rule.enumOf(['draft', 'active', 'paused', 'exhausted', 'finished'], { default: 'draft' }),
    metadata: rule.metadata(),
  },
});

export const promotionResource = defineResource({
  name: 'promotion',
  collection: 'promotions',
  prefix: 'promo',
  route: 'promotions',
  unique: ['code'],
  searchable: ['name', 'code'],
  translatable: ['name', 'label'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(140, { required: true }),
    label: rule.text(80),
    description: rule.text(500),
    type: rule.enumOf(PROMOTION_TYPES, { default: 'standard' }),
    campaignId: rule.id(),
    applicationMethod: {
      type: 'object',
      shape: {
        type: rule.enumOf(['percentage', 'fixed', 'free_shipping', 'buyget', 'gift']),
        value: { type: 'number', coerce: true, min: 0 },
        currencyCode: rule.currency(),
        target: rule.enumOf(TARGETS),
        maxDiscount: rule.minor(),
        // Tope de unidades bonificadas en buy-x-get-y (M-0823).
        maxQuantity: rule.quantity(),
        buyQuantity: rule.quantity(),
        getQuantity: rule.quantity(),
        giftVariantId: rule.id(),
        applyToCheapest: rule.flag({ default: true }),
      },
    },
    rules: rule.list({
      type: 'object',
      shape: {
        attribute: rule.text(60, { required: true }),
        operator: rule.enumOf(OPERATORS, { required: true }),
        values: rule.list({ type: 'string' }, { default: [] }),
      },
    }, { default: [] }),
    targetRules: rule.list({
      type: 'object',
      shape: {
        attribute: rule.text(60, { required: true }),
        operator: rule.enumOf(OPERATORS, { required: true }),
        values: rule.list({ type: 'string' }, { default: [] }),
      },
    }, { default: [] }),
    excludedProductIds: rule.list({ type: 'string' }, { default: [] }),
    // Excluye lo que ya está rebajado por una lista de precios (M-0829).
    excludeDiscounted: rule.flag({ default: false }),
    channelIds: rule.list({ type: 'string' }, { default: [] }),
    customerGroupIds: rule.list({ type: 'string' }, { default: [] }),
    regionIds: rule.list({ type: 'string' }, { default: [] }),
    weekdays: rule.list({ type: 'string' }, { default: [] }),
    priority: { type: 'integer', coerce: true, min: 0, max: 1000, default: 100 },
    exclusive: rule.flag({ default: false }),
    requiresCode: rule.flag({ default: true }),
    usageLimit: rule.quantity(),
    usageLimitPerCustomer: rule.quantity(),
    usageCount: rule.quantity({ default: 0 }),
    startsAt: rule.date(),
    endsAt: rule.date(),
    status: rule.enumOf(['draft', 'active', 'paused', 'expired'], { default: 'draft' }),
    showInCatalog: rule.flag({ default: false }),
    // Texto informativo para ofertas del comercio afiliado: no altera nada (M-0850).
    affiliateInfoOnly: rule.flag({ default: false }),
    metadata: rule.metadata(),
  },
});

export const couponResource = defineResource({
  name: 'coupon',
  collection: 'coupons',
  prefix: 'coup',
  route: 'coupons',
  unique: ['code'],
  searchable: ['code'],
  fields: {
    promotionId: rule.id({ required: true }),
    code: rule.text(40, { required: true, uppercase: true }),
    usageLimit: rule.quantity(),
    usageCount: rule.quantity({ default: 0 }),
    active: rule.flag({ default: true }),
    expiresAt: rule.date(),
    metadata: rule.metadata(),
  },
});

export const promotionUsageResource = defineResource({
  name: 'promotionUsage',
  collection: 'promotionUsages',
  prefix: 'puse',
  route: 'promotion-usages',
  softDelete: false,
  searchable: [],
  fields: {
    promotionId: rule.id({ required: true }),
    couponId: rule.id(),
    orderId: rule.id(),
    cartId: rule.id(),
    customerId: rule.id(),
    discountAmount: rule.minor({ default: 0 }),
    currencyCode: rule.currency(),
    metadata: rule.metadata(),
  },
});

export const giftCardResource = defineResource({
  name: 'giftCard',
  collection: 'giftCards',
  prefix: 'gift',
  route: 'gift-cards',
  unique: ['code'],
  searchable: ['code'],
  fields: {
    code: rule.text(40, { required: true, uppercase: true }),
    initialAmount: rule.minor({ required: true, min: 1 }),
    balance: rule.minor({ default: 0 }),
    currencyCode: rule.currency({ required: true }),
    customerId: rule.id(),
    orderId: rule.id(),
    expiresAt: rule.date(),
    status: rule.enumOf(['active', 'redeemed', 'expired', 'blocked'], { default: 'active' }),
    movements: rule.list({
      type: 'object',
      shape: {
        amount: rule.minor({ required: true }),
        orderId: rule.id(),
        reason: rule.text(200),
        at: rule.date(),
      },
    }, { default: [] }),
    metadata: rule.metadata(),
  },
});

/** Condiciones disponibles (M-0767 … M-0777). */
export const CONDITIONS = {
  min_order_amount: (context, values) => context.subtotal >= Number(values[0] || 0),
  min_item_count: (context, values) => context.itemCount >= Number(values[0] || 0),
  contains_products: (context, values) => context.items.some(item => values.includes(item.productId)),
  contains_variants: (context, values) => context.items.some(item => values.includes(item.variantId)),
  customer_group: (context, values) => (context.customerGroupIds || []).some(groupId => values.includes(groupId)),
  has_facet_values: (context, values) => context.items.some(item => (item.facetValueIds || []).some(id => values.includes(id))),
  in_category: (context, values) => context.items.some(item => values.includes(item.categoryId)),
  in_collection: (context, values) => context.items.some(item => (item.collectionIds || []).some(id => values.includes(id))),
  first_order: context => context.customerOrderCount === 0,
  region: (context, values) => values.includes(context.regionId),
  channel: (context, values) => values.includes(context.channelId),
  currency: (context, values) => values.includes(context.currencyCode),
  buy_x_get_y: (context, values) => {
    const [productId, quantity] = values;
    const total = context.items
      .filter(item => item.productId === productId)
      .reduce((sum, item) => sum + item.quantity, 0);
    return total >= Number(quantity || 1);
  },
};

function compare(operator, left, values) {
  const first = values[0];
  switch (operator) {
    case 'eq': return String(left) === String(first);
    case 'ne': return String(left) !== String(first);
    case 'in': return values.map(String).includes(String(left));
    case 'nin': return !values.map(String).includes(String(left));
    case 'gt': return Number(left) > Number(first);
    case 'gte': return Number(left) >= Number(first);
    case 'lt': return Number(left) < Number(first);
    case 'lte': return Number(left) <= Number(first);
    default: return false;
  }
}

export class PromotionCampaignService extends BaseService {
  constructor(deps) {
    super(deps, campaignResource);
    this.alerts = deps.alert;
  }

  /** Presupuesto restante, o `null` si la campaña no tiene tope. */
  remaining(campaign) {
    if (!campaign?.budget?.type || !campaign.budget.limit) return null;
    return campaign.budget.type === 'spend'
      ? campaign.budget.limit - (campaign.consumed || 0)
      : campaign.budget.limit - (campaign.consumedUsage || 0);
  }

  hasBudget(campaign, amount = 0) {
    const left = this.remaining(campaign);
    if (left === null) return true;
    return campaign.budget.type === 'spend' ? left >= amount : left >= 1;
  }

  /** Consume presupuesto y bloquea la campaña al agotarlo (M-0800, M-0801, M-0802). */
  async consume(campaignId, amount, ctx = null) {
    const campaign = this.repository.byId(campaignId);
    if (!campaign) return null;
    const result = await this.store.transaction(state => this.repository.patch(state, campaignId, {
      consumed: (campaign.consumed || 0) + Number(amount || 0),
      consumedUsage: (campaign.consumedUsage || 0) + 1,
    }));

    const updated = result.after;
    const left = this.remaining(updated);
    if (left !== null) {
      const limit = updated.budget.limit;
      const used = limit - left;
      if (left <= 0) {
        await this.store.transaction(state => this.repository.patch(state, campaignId, { status: 'exhausted' }));
        await this.alerts?.raise({
          type: 'campaign_budget_exhausted',
          severity: 'warning',
          message: `La campaña ${updated.name} agotó su presupuesto y quedó bloqueada.`,
          entityId: campaignId,
          entityType: 'promotionCampaign',
        }, ctx);
      } else if (used / limit >= 0.8) {
        await this.alerts?.raise({
          type: 'campaign_budget_80',
          severity: 'info',
          message: `La campaña ${updated.name} consumió el ${Math.round((used / limit) * 100)} % de su presupuesto.`,
          entityId: campaignId,
          entityType: 'promotionCampaign',
        }, ctx);
      }
    }
    return updated;
  }
}

export class PromotionService extends BaseService {
  constructor(deps) {
    super(deps, promotionResource);
    this.campaigns = deps.campaigns;
    this.coupons = deps.coupons;
    this.usages = deps.usages;
  }

  async beforeCreate(data) {
    this.assertValidMethod(data);
    return data;
  }

  async beforeUpdate(existing, changes) {
    if (changes.applicationMethod) this.assertValidMethod({ ...existing, ...changes });
    return changes;
  }

  assertValidMethod(promotion) {
    const method = promotion.applicationMethod;
    if (!method?.type) throw ValidationError.single('applicationMethod.type', 'Toda promoción necesita un método de aplicación.');
    if (['percentage', 'fixed'].includes(method.type) && !(method.value > 0)) {
      throw ValidationError.single('applicationMethod.value', 'El valor del descuento debe ser mayor que cero.');
    }
    if (method.type === 'percentage' && method.value > 100) {
      throw ValidationError.single('applicationMethod.value', 'Un descuento porcentual no puede superar el 100 %.');
    }
    if (method.type === 'buyget' && !(method.buyQuantity > 0 && method.getQuantity > 0)) {
      throw ValidationError.single('applicationMethod.buyQuantity', 'Buy-x-get-y necesita cantidades de compra y de regalo.');
    }
    if (method.type === 'gift' && !method.giftVariantId) {
      throw ValidationError.single('applicationMethod.giftVariantId', 'Indica la variante que se regala.');
    }
    return true;
  }

  /** Promociones automáticas activas más la que aporte un cupón concreto. */
  candidates({ channelId = null, customerGroupIds = [], regionId = null, couponCodes = [] } = {}) {
    const coupons = couponCodes
      .map(code => this.coupons.repository.find({ code: String(code).toUpperCase(), active: true }))
      .filter(Boolean);
    const couponPromotionIds = new Set(coupons.map(coupon => coupon.promotionId));

    return this.repository
      .all({ status: 'active' })
      .filter(promotion => !promotion.affiliateInfoOnly)
      .filter(promotion => isActiveNow(promotion))
      .filter(promotion => (promotion.requiresCode ? couponPromotionIds.has(promotion.id) : true))
      .filter(promotion => !promotion.channelIds?.length || (channelId && promotion.channelIds.includes(channelId)))
      .filter(promotion => !promotion.regionIds?.length || (regionId && promotion.regionIds.includes(regionId)))
      .filter(promotion => !promotion.customerGroupIds?.length || promotion.customerGroupIds.some(groupId => customerGroupIds.includes(groupId)))
      .filter(promotion => {
        if (!promotion.weekdays?.length) return true;
        return promotion.weekdays.includes(weekdayName(new Date()));
      })
      .map(promotion => ({
        promotion,
        coupon: coupons.find(coupon => coupon.promotionId === promotion.id) || null,
      }))
      .sort((a, b) => b.promotion.priority - a.promotion.priority);
  }

  /** ¿Se cumplen las reglas y condiciones? Devuelve el motivo si no (M-0805). */
  evaluate(promotion, context) {
    const reasons = [];

    if (promotion.usageLimit && (promotion.usageCount || 0) >= promotion.usageLimit) {
      reasons.push('Se alcanzó el límite global de usos.');
    }
    if (promotion.usageLimitPerCustomer && context.customerId) {
      const used = this.usages.repository.all({ promotionId: promotion.id, customerId: context.customerId }).length;
      if (used >= promotion.usageLimitPerCustomer) reasons.push('Se alcanzó el límite de usos por cliente.');
    }
    if (promotion.campaignId) {
      const campaign = this.campaigns.repository.byId(promotion.campaignId);
      if (!campaign || campaign.status !== 'active') reasons.push('La campaña asociada no está activa.');
      else if (!isActiveNow(campaign)) reasons.push('La campaña asociada está fuera de vigencia.');
      else if (!this.campaigns.hasBudget(campaign)) reasons.push('La campaña agotó su presupuesto.');
    }

    for (const condition of promotion.rules || []) {
      const evaluator = CONDITIONS[condition.attribute];
      if (evaluator) {
        if (!evaluator(context, condition.values)) reasons.push(`No se cumple la condición "${condition.attribute}".`);
        continue;
      }
      // Atributo libre del contexto con operador genérico (M-0765, M-0766).
      const left = context[condition.attribute];
      if (!compare(condition.operator, left, condition.values)) {
        reasons.push(`No se cumple la regla ${condition.attribute} ${condition.operator} ${condition.values.join(',')}.`);
      }
    }

    return { eligible: reasons.length === 0, reasons };
  }

  /** Líneas sobre las que actúa la promoción. */
  targetItems(promotion, context) {
    let items = context.items.filter(item => !promotion.excludedProductIds?.includes(item.productId));
    if (promotion.excludeDiscounted) items = items.filter(item => !item.hasPriceListDiscount);

    for (const target of promotion.targetRules || []) {
      items = items.filter(item => {
        const value = item[target.attribute];
        if (Array.isArray(value)) {
          return target.operator === 'nin'
            ? !value.some(entry => target.values.includes(String(entry)))
            : value.some(entry => target.values.includes(String(entry)));
        }
        return compare(target.operator, value, target.values);
      });
    }
    return items;
  }

  /**
   * Calcula el descuento de una promoción sobre un contexto de carrito.
   *
   * @returns {{promotionId:string, amount:number, target:string,
   *            allocations:Array<{lineItemId:string, amount:number}>, note:string}}
   */
  computeDiscount(promotion, context) {
    const method = promotion.applicationMethod || {};
    const target = method.target || 'order';

    if (method.type === 'free_shipping') {
      return {
        promotionId: promotion.id,
        amount: context.shippingTotal || 0,
        target: 'shipping',
        allocations: [],
        note: 'Envío gratis',
      };
    }

    if (method.type === 'gift') {
      return {
        promotionId: promotion.id,
        amount: 0,
        target: 'items',
        allocations: [],
        gift: { variantId: method.giftVariantId, quantity: 1 },
        note: 'Regalo añadido',
      };
    }

    const items = this.targetItems(promotion, context);
    if (!items.length) {
      return { promotionId: promotion.id, amount: 0, target, allocations: [], note: 'Ninguna línea elegible' };
    }

    if (method.type === 'buyget') {
      // El artículo más barato es el que se regala, salvo configuración contraria.
      const expanded = items.flatMap(item => Array.from({ length: item.quantity }, () => item));
      const ordered = [...expanded].sort((a, b) => (method.applyToCheapest ? a.unitPrice - b.unitPrice : b.unitPrice - a.unitPrice));
      const groups = Math.floor(expanded.length / (method.buyQuantity + method.getQuantity));
      const freeUnits = Math.min(groups * method.getQuantity, method.maxQuantity || Infinity);
      const chosen = ordered.slice(0, freeUnits);
      const byLine = new Map();
      for (const unit of chosen) {
        byLine.set(unit.id, (byLine.get(unit.id) || 0) + unit.unitPrice);
      }
      const amount = [...byLine.values()].reduce((sum, value) => sum + value, 0);
      return {
        promotionId: promotion.id,
        amount,
        target: 'items',
        allocations: [...byLine.entries()].map(([lineItemId, value]) => ({ lineItemId, amount: value })),
        note: `${freeUnits} unidad(es) sin coste`,
      };
    }

    const base = target === 'shipping'
      ? context.shippingTotal || 0
      : items.reduce((sum, item) => sum + item.total, 0);

    let amount = method.type === 'percentage' ? percentage(base, method.value) : Math.min(base, Number(method.value || 0));
    if (method.maxDiscount) amount = Math.min(amount, method.maxDiscount);
    amount = Math.min(amount, base);

    if (target === 'shipping') {
      return { promotionId: promotion.id, amount, target, allocations: [], note: 'Descuento sobre el envío' };
    }

    // Reparto entre líneas con compensación de restos (M-0764, M-0820).
    const shares = distribute(amount, items.map(item => item.total));
    return {
      promotionId: promotion.id,
      amount,
      target: 'items',
      allocations: items.map((item, index) => ({ lineItemId: item.id, amount: shares[index] })).filter(entry => entry.amount > 0),
      note: method.type === 'percentage' ? `${method.value} % de descuento` : 'Descuento fijo',
    };
  }

  /**
   * Aplica todas las promociones elegibles a un contexto de carrito.
   * Respeta prioridad, exclusividad y el suelo de cero (M-0786 … M-0788, M-0846).
   */
  apply(context) {
    const evaluated = [];
    const applied = [];
    let discountTotal = 0;
    let shippingDiscount = 0;
    let stopStacking = false;
    const gifts = [];

    for (const { promotion, coupon } of this.candidates(context)) {
      if (stopStacking) {
        evaluated.push({ promotionId: promotion.id, eligible: false, reasons: ['Otra promoción exclusiva ya se aplicó.'] });
        continue;
      }
      if (coupon?.usageLimit && (coupon.usageCount || 0) >= coupon.usageLimit) {
        evaluated.push({ promotionId: promotion.id, eligible: false, reasons: ['El cupón agotó sus usos.'] });
        continue;
      }
      if (coupon?.expiresAt && !isActiveNow({ endsAt: coupon.expiresAt })) {
        evaluated.push({ promotionId: promotion.id, eligible: false, reasons: ['El cupón ha caducado.'] });
        continue;
      }

      const verdict = this.evaluate(promotion, context);
      if (!verdict.eligible) {
        evaluated.push({ promotionId: promotion.id, eligible: false, reasons: verdict.reasons });
        continue;
      }

      const discount = this.computeDiscount(promotion, context);
      // El descuento no puede pasar de lo que queda por descontar.
      const room = Math.max(0, context.subtotal - discountTotal);
      if (discount.target !== 'shipping') discount.amount = Math.min(discount.amount, room);
      if (discount.gift) gifts.push(discount.gift);

      if (discount.amount <= 0 && !discount.gift) {
        evaluated.push({ promotionId: promotion.id, eligible: false, reasons: ['El descuento calculado es cero.'] });
        continue;
      }

      if (discount.target === 'shipping') shippingDiscount += discount.amount;
      else discountTotal += discount.amount;

      applied.push({
        promotionId: promotion.id,
        code: coupon?.code || promotion.code,
        couponId: coupon?.id || null,
        label: promotion.label || promotion.name,
        ...discount,
      });
      evaluated.push({ promotionId: promotion.id, eligible: true, amount: discount.amount });
      if (promotion.exclusive) stopStacking = true;
    }

    return {
      applied,
      evaluated,
      gifts,
      discountTotal: clampToZero(Math.min(discountTotal, context.subtotal)),
      shippingDiscount: clampToZero(Math.min(shippingDiscount, context.shippingTotal || 0)),
    };
  }

  /** Registra el uso y consume presupuesto (M-0793, M-0800). */
  async registerUsage({ promotionId, couponId = null, orderId = null, cartId = null, customerId = null, discountAmount = 0, currencyCode = 'USD' }, ctx = null) {
    const promotion = this.repository.byId(promotionId);
    if (!promotion) return null;

    await this.usages.create({ promotionId, couponId, orderId, cartId, customerId, discountAmount, currencyCode }, ctx);
    await this.store.transaction(state => {
      this.repository.patch(state, promotionId, { usageCount: (promotion.usageCount || 0) + 1 });
      if (couponId) {
        const coupon = (state.coupons || []).find(row => row.id === couponId);
        if (coupon) coupon.usageCount = (coupon.usageCount || 0) + 1;
      }
    });
    if (promotion.campaignId) await this.campaigns.consume(promotion.campaignId, discountAmount, ctx);
    return { registered: true };
  }

  /** Generación masiva de códigos únicos (M-0790). */
  async generateCoupons(promotionId, { count = 10, prefix = '', usageLimit = 1 }, ctx = null) {
    this.repository.retrieve(promotionId);
    if (count > 1000) throw ValidationError.single('count', 'Como máximo 1000 códigos por operación.');
    const created = [];
    const existing = new Set(this.coupons.repository.all().map(coupon => coupon.code));
    for (let index = 0; index < count; index += 1) {
      let code = humanCode(prefix, 8, '');
      let guard = 0;
      while (existing.has(code) && guard < 50) {
        code = humanCode(prefix, 8, '');
        guard += 1;
      }
      existing.add(code);
      created.push(await this.coupons.create({ promotionId, code, usageLimit, active: true }, ctx));
    }
    return { created: created.length, codes: created.map(coupon => coupon.code) };
  }

  /** Activa y desactiva promociones programadas (M-0841 … M-0844). */
  async syncSchedules(ctx = null) {
    const all = this.repository.all();
    let activated = 0;
    let expired = 0;
    for (const promotion of all) {
      const shouldBeActive = isActiveNow(promotion);
      if (promotion.status === 'draft' && shouldBeActive && promotion.startsAt) {
        await this.update(promotion.id, { status: 'active' }, ctx);
        activated += 1;
      }
      if (promotion.status === 'active' && !shouldBeActive && promotion.endsAt) {
        await this.update(promotion.id, { status: 'expired' }, ctx);
        expired += 1;
      }
    }
    return { activated, expired };
  }

  /** Promociones que se pueden anunciar en el catálogo (M-0830, M-0831). */
  visibleInCatalog({ channelId = null } = {}) {
    return this.repository
      .all({ status: 'active', showInCatalog: true })
      .filter(promotion => isActiveNow(promotion))
      .filter(promotion => !promotion.channelIds?.length || (channelId && promotion.channelIds.includes(channelId)))
      .map(promotion => ({
        id: promotion.id,
        label: promotion.label || promotion.name,
        description: promotion.description,
        endsAt: promotion.endsAt || null,
        requiresCode: promotion.requiresCode,
        affiliateInfoOnly: Boolean(promotion.affiliateInfoOnly),
      }));
  }
}

export class GiftCardService extends BaseService {
  constructor(deps) {
    super(deps, giftCardResource);
  }

  async beforeCreate(data) {
    return {
      ...data,
      code: data.code || humanCode('GC', 12),
      balance: data.balance ?? data.initialAmount,
      movements: [{ amount: data.initialAmount, reason: 'Emisión', at: now() }],
    };
  }

  byCode(code) {
    return this.repository.find({ code: String(code || '').toUpperCase() });
  }

  /**
   * Consume saldo. La tarjeta regalo actúa como **pago**, no como descuento
   * (M-0811): no reduce el total, reduce lo que queda por cobrar.
   */
  async redeem(code, amount, { orderId = null } = {}, ctx = null) {
    const card = this.byCode(code);
    if (!card) throw ValidationError.single('code', 'La tarjeta regalo no existe.');
    if (card.status === 'blocked') throw new ConflictError('La tarjeta regalo está bloqueada.');
    if (card.status !== 'active') throw new ConflictError('La tarjeta regalo no tiene saldo disponible.');
    if (card.expiresAt && !isActiveNow({ endsAt: card.expiresAt })) {
      await this.update(card.id, { status: 'expired' }, ctx);
      throw new ConflictError('La tarjeta regalo ha caducado.');
    }
    const applied = Math.min(card.balance, Math.max(0, Number(amount)));
    if (applied <= 0) throw new ConflictError('La tarjeta regalo no tiene saldo.');

    const balance = card.balance - applied;
    const result = await this.store.transaction(state => this.repository.patch(state, card.id, {
      balance,
      status: balance === 0 ? 'redeemed' : 'active',
      movements: [...(card.movements || []), { amount: -applied, orderId, reason: 'Consumo', at: now() }].slice(-100),
    }));
    await this.emit('redeemed', result.after, ctx, card);
    return { applied, balance, currencyCode: card.currencyCode, giftCardId: card.id };
  }

  async refund(giftCardId, amount, { orderId = null, reason = 'Devolución' } = {}, ctx = null) {
    const card = this.repository.retrieve(giftCardId);
    const balance = card.balance + Math.max(0, Number(amount));
    const result = await this.store.transaction(state => this.repository.patch(state, giftCardId, {
      balance,
      status: 'active',
      movements: [...(card.movements || []), { amount, orderId, reason, at: now() }].slice(-100),
    }));
    return result.after;
  }

  publicView(card) {
    if (!card) return null;
    return {
      code: card.code,
      balance: card.balance,
      currencyCode: card.currencyCode,
      status: card.status,
      expiresAt: card.expiresAt || null,
    };
  }
}

export default {
  name: 'promotion',
  requires: ['store', 'events', 'audit', 'config', 'customFields', 'translations', 'settings', 'alert'],
  resources: [campaignResource, promotionResource, couponResource, promotionUsageResource, giftCardResource],
  permissions: [
    { resource: 'promotion', description: 'Promociones y descuentos.' },
    { resource: 'promotionCampaign', description: 'Campañas de promoción con presupuesto.' },
    { resource: 'coupon', description: 'Códigos de cupón.' },
    { resource: 'promotionUsage', actions: ['read'], description: 'Usos de promoción.' },
    { resource: 'giftCard', description: 'Tarjetas regalo.' },
  ],

  register(deps) {
    const campaigns = new PromotionCampaignService(deps);
    const coupons = new BaseService(deps, couponResource);
    const usages = new BaseService(deps, promotionUsageResource);
    const promotions = new PromotionService({ ...deps, campaigns, coupons, usages });
    const giftCards = new GiftCardService(deps);
    return { campaigns, coupons, usages, promotions, giftCards };
  },

  jobs: container => [
    {
      name: 'promotion.sync-schedules',
      everyMs: 15 * 60_000,
      handler: () => container.resolve('promotion').promotions.syncSchedules(),
    },
  ],

  routes: {
    admin: container => {
      const module = () => container.resolve('promotion');
      return [
        ...crudRoutes(campaignResource, () => module().campaigns, { permissionResource: 'promotionCampaign', tags: ['promociones'] }),
        ...crudRoutes(promotionResource, () => module().promotions, { tags: ['promociones'] }),
        ...crudRoutes(couponResource, () => module().coupons, { tags: ['promociones'] }),
        ...crudRoutes(giftCardResource, () => module().giftCards, { tags: ['promociones'] }),
        {
          method: 'GET',
          path: '/promotion-usages',
          permission: 'promotionUsage:read',
          summary: 'Usos registrados de promociones.',
          tags: ['promociones'],
          bodyless: true,
          handler: ctx => module().usages.list(ctx.query),
        },
        {
          method: 'POST',
          path: '/promotions/:id/coupons/generate',
          permission: 'coupon:create',
          summary: 'Genera códigos de cupón únicos en lote.',
          tags: ['promociones'],
          body: {
            count: rule.quantity({ default: 10, min: 1, max: 1000 }),
            prefix: rule.text(10),
            usageLimit: rule.quantity({ default: 1 }),
          },
          handler: ctx => module().promotions.generateCoupons(ctx.params.id, ctx.body, ctx),
        },
        {
          method: 'POST',
          path: '/promotions/simulate',
          permission: 'promotion:read',
          summary: 'Simula las promociones sobre un carrito de prueba y explica cada descarte.',
          tags: ['promociones'],
          body: {
            subtotal: rule.minor({ required: true }),
            shippingTotal: rule.minor({ default: 0 }),
            currencyCode: rule.currency(),
            channelId: rule.id(),
            regionId: rule.id(),
            customerId: rule.id(),
            customerOrderCount: rule.quantity({ default: 0 }),
            customerGroupIds: rule.list({ type: 'string' }),
            couponCodes: rule.list({ type: 'string' }),
            items: rule.list({
              type: 'object',
              shape: {
                id: rule.id({ required: true }),
                productId: rule.id(),
                variantId: rule.id(),
                categoryId: rule.id(),
                collectionIds: rule.list({ type: 'string' }),
                facetValueIds: rule.list({ type: 'string' }),
                quantity: rule.quantity({ required: true }),
                unitPrice: rule.minor({ required: true }),
                total: rule.minor({ required: true }),
                hasPriceListDiscount: rule.flag(),
              },
            }, { required: true }),
          },
          handler: ctx => {
            const context = {
              ...ctx.body,
              itemCount: (ctx.body.items || []).reduce((sum, item) => sum + item.quantity, 0),
            };
            return module().promotions.apply(context);
          },
        },
        {
          method: 'GET',
          path: '/promotions/:id/performance',
          permission: 'promotion:read',
          summary: 'Usos, descuento total y pedidos de una promoción.',
          tags: ['promociones'],
          bodyless: true,
          handler: ctx => {
            const usages = module().usages.repository.all({ promotionId: ctx.params.id });
            const orders = container.resolve('store').collection('orders');
            const related = orders.filter(order => usages.some(usage => usage.orderId === order.id));
            const revenue = related.reduce((sum, order) => sum + Number(order.total || 0), 0);
            return {
              promotionId: ctx.params.id,
              uses: usages.length,
              discountTotal: usages.reduce((sum, usage) => sum + Number(usage.discountAmount || 0), 0),
              orders: related.length,
              averageOrder: related.length ? Math.round(revenue / related.length) : 0,
            };
          },
        },
        {
          method: 'POST',
          path: '/gift-cards/:id/block',
          permission: 'giftCard:update',
          summary: 'Bloquea una tarjeta regalo por sospecha.',
          tags: ['promociones'],
          handler: ctx => module().giftCards.update(ctx.params.id, { status: 'blocked' }, ctx),
        },
      ];
    },

    store: container => {
      const module = () => container.resolve('promotion');
      return [
        {
          method: 'GET',
          path: '/promotions/visible',
          permission: null,
          summary: 'Promociones anunciables en el catálogo.',
          tags: ['store'],
          bodyless: true,
          handler: ctx => {
            const data = module().promotions.visibleInCatalog({ channelId: ctx.channelId });
            return { data, count: data.length };
          },
        },
        {
          method: 'GET',
          path: '/gift-cards/:code',
          permission: null,
          summary: 'Consulta el saldo de una tarjeta regalo.',
          tags: ['store'],
          bodyless: true,
          handler: ctx => {
            container.resolve('settings').settings.assertCapability('giftCard');
            const card = module().giftCards.byCode(ctx.params.code);
            if (!card) throw ValidationError.single('code', 'La tarjeta regalo no existe.');
            return module().giftCards.publicView(card);
          },
        },
      ];
    },
  },
};
