/**
 * Precios (M-0461 … M-0490).
 *
 * Modelo tomado de Medusa: una variante tiene un **conjunto de precios**, cada
 * precio pertenece a una moneda y puede llevar **reglas** (región, canal, grupo de
 * cliente, cantidad). El precio calculado elige la regla más específica y desempata
 * de forma determinista, porque un precio que cambia según el orden de lectura del
 * disco es imposible de auditar.
 *
 * Las **listas de precios** son la capa de rebaja o sobrescritura, con vigencia.
 */
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule } from '../../framework/validate.js';
import { ValidationError } from '../../framework/errors.js';
import { discountPercent, splitTaxInclusive } from '../../framework/money.js';
import { isActiveNow, now } from '../../framework/dates.js';

export const priceResource = defineResource({
  name: 'price',
  collection: 'prices',
  prefix: 'price',
  route: 'prices',
  searchable: [],
  fields: {
    variantId: rule.id({ required: true }),
    currencyCode: rule.currency({ required: true }),
    amount: rule.minor({ required: true, min: 0 }),
    // Precio de referencia para mostrar el descuento, no para cobrar.
    compareAtAmount: rule.minor({ min: 0 }),
    priceListId: rule.id(),
    regionId: rule.id(),
    channelId: rule.id(),
    customerGroupId: rule.id(),
    minQuantity: rule.quantity({ default: 1 }),
    maxQuantity: rule.quantity(),
    includesTax: rule.flag({ default: false }),
    unitLabel: rule.text(20),
    unitDivisor: { type: 'number', coerce: true, min: 0 },
    active: rule.flag({ default: true }),
    metadata: rule.metadata(),
  },
});

export const priceListResource = defineResource({
  name: 'priceList',
  collection: 'priceLists',
  prefix: 'plist',
  route: 'price-lists',
  unique: ['code'],
  searchable: ['name', 'code'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(120, { required: true }),
    description: rule.text(500),
    // `sale` muestra precio anterior tachado; `override` sustituye sin más.
    type: rule.enumOf(['sale', 'override'], { default: 'sale' }),
    status: rule.enumOf(['draft', 'active', 'expired'], { default: 'draft' }),
    startsAt: rule.date(),
    endsAt: rule.date(),
    customerGroupIds: rule.list({ type: 'string' }, { default: [] }),
    channelIds: rule.list({ type: 'string' }, { default: [] }),
    priority: { type: 'integer', coerce: true, min: 0, max: 1000, default: 100 },
    metadata: rule.metadata(),
  },
});

export class PriceListService extends BaseService {
  constructor(deps) {
    super(deps, priceListResource);
  }

  /** Listas vigentes para un contexto. */
  applicable({ channelId = null, customerGroupIds = [] } = {}) {
    return this.repository
      .all({ status: 'active' })
      .filter(list => isActiveNow(list))
      .filter(list => !list.channelIds?.length || (channelId && list.channelIds.includes(channelId)))
      .filter(list => !list.customerGroupIds?.length || list.customerGroupIds.some(groupId => customerGroupIds.includes(groupId)))
      .sort((a, b) => b.priority - a.priority);
  }

  /** Marca como caducadas las listas cuya vigencia ya pasó (M-0470). */
  async expireOutdated() {
    const outdated = this.repository.all({ status: 'active' }).filter(list => !isActiveNow(list) && list.endsAt);
    if (!outdated.length) return { expired: 0 };
    await this.store.transaction(state => {
      for (const list of outdated) this.repository.patch(state, list.id, { status: 'expired' });
    });
    return { expired: outdated.length };
  }
}

export class PriceService extends BaseService {
  constructor(deps) {
    super(deps, priceResource);
  }

  async beforeCreate(data) {
    if (data.maxQuantity && data.minQuantity && data.maxQuantity < data.minQuantity) {
      throw ValidationError.single('maxQuantity', 'La cantidad máxima no puede ser menor que la mínima.');
    }
    return data;
  }

  forVariant(variantId) {
    return this.repository.all({ variantId, active: true });
  }
}

/**
 * Cálculo del precio efectivo.
 *
 * Especificidad: cada dimensión que coincide suma puntos. Región y canal pesan más
 * que grupo de cliente, y la cantidad desempata al final. Si dos reglas empatan,
 * gana la de importe menor: ante la duda, el cliente paga menos.
 */
export class PriceCalculationService {
  constructor({ prices, priceLists, geography, settings, cache, taxCalculation }) {
    this.prices = prices;
    this.priceLists = priceLists;
    this.geography = geography;
    this.settings = settings;
    this.cache = cache;
    this.taxCalculation = taxCalculation;
  }

  specificity(price, context) {
    let points = 0;
    if (price.regionId) {
      if (price.regionId !== context.regionId) return -1;
      points += 40;
    }
    if (price.channelId) {
      if (price.channelId !== context.channelId) return -1;
      points += 30;
    }
    if (price.customerGroupId) {
      if (!(context.customerGroupIds || []).includes(price.customerGroupId)) return -1;
      points += 20;
    }
    const quantity = context.quantity || 1;
    if (price.minQuantity > 1) {
      if (quantity < price.minQuantity) return -1;
      points += 10;
    }
    if (price.maxQuantity && quantity > price.maxQuantity) return -1;
    if (price.priceListId) points += 5;
    return points;
  }

  /**
   * @returns {{amount:number|null, currencyCode:string, originalAmount:number|null,
   *            discountPercent:number|null, priceListId:string|null, priceId:string|null,
   *            includesTax:boolean, taxAmount:number|null}}
   */
  calculate({ variantId, currencyCode, regionId = null, channelId = null, customerGroupIds = [], quantity = 1, taxCategoryId = null, address = null }) {
    const currency = String(currencyCode || this.settings.get('defaultCurrency', 'USD')).toUpperCase();
    const cacheKey = `price:${variantId}:${currency}:${regionId}:${channelId}:${customerGroupIds.join('|')}:${quantity}`;
    const cached = this.cache?.get(cacheKey);
    if (cached) return cached;

    const context = { regionId, channelId, customerGroupIds, quantity };
    const activeLists = new Map(this.priceLists.applicable({ channelId, customerGroupIds }).map(list => [list.id, list]));

    const candidates = this.prices
      .forVariant(variantId)
      .filter(price => price.currencyCode === currency)
      // Un precio de lista solo cuenta si su lista está vigente (M-0489).
      .filter(price => !price.priceListId || activeLists.has(price.priceListId))
      .map(price => ({ price, points: this.specificity(price, context) }))
      .filter(entry => entry.points >= 0)
      .sort((a, b) => b.points - a.points || a.price.amount - b.price.amount);

    if (!candidates.length) {
      const empty = {
        amount: null, currencyCode: currency, originalAmount: null, discountPercent: null,
        priceListId: null, priceId: null, includesTax: false, taxAmount: null, quantity,
      };
      return empty;
    }

    const best = candidates[0].price;
    const baseline = candidates.find(entry => !entry.price.priceListId)?.price || null;
    const originalAmount = best.compareAtAmount
      ?? (best.priceListId && baseline && baseline.amount > best.amount ? baseline.amount : null);

    const result = {
      amount: best.amount,
      currencyCode: currency,
      originalAmount,
      discountPercent: discountPercent(originalAmount, best.amount),
      priceListId: best.priceListId || null,
      priceListType: best.priceListId ? activeLists.get(best.priceListId)?.type || null : null,
      priceId: best.id,
      includesTax: Boolean(best.includesTax),
      quantity,
      unitLabel: best.unitLabel || null,
      pricePerUnit: best.unitDivisor ? Math.round(best.amount / best.unitDivisor) : null,
    };

    // Precio con impuesto según la región (M-0476).
    if (address || regionId) {
      const region = regionId ? this.geography.regions.repository.byId(regionId) : null;
      if (region?.taxInclusive && !best.includesTax) {
        const calculation = this.taxCalculation?.calculate({
          lines: [{ id: variantId, amount: best.amount, taxCategoryId }],
          address: address || {},
          region,
          customerGroupIds,
        });
        result.taxAmount = calculation?.totalTax ?? null;
        result.amountWithTax = best.amount + (calculation?.totalTax ?? 0);
      } else if (best.includesTax) {
        const split = splitTaxInclusive(best.amount, 0);
        result.taxAmount = split.tax;
        result.amountWithTax = best.amount;
      }
    }

    this.cache?.set(cacheKey, result, { ttlMs: 30_000, tags: [`price:${variantId}`, 'price'] });
    return result;
  }

  /** Rango de precios de un producto con varias variantes (M-0474). */
  rangeForVariants(variantIds, context) {
    const amounts = variantIds
      .map(variantId => this.calculate({ ...context, variantId }).amount)
      .filter(amount => Number.isFinite(amount));
    if (!amounts.length) return { min: null, max: null };
    return { min: Math.min(...amounts), max: Math.max(...amounts) };
  }

  invalidate(variantId = null) {
    if (variantId) return this.cache?.invalidateTag(`price:${variantId}`);
    return this.cache?.invalidateTag('price');
  }
}

export default {
  name: 'pricing',
  requires: ['store', 'events', 'audit', 'config', 'customFields', 'geography', 'settings', 'cache', 'tax'],
  resources: [priceResource, priceListResource],
  permissions: [
    { resource: 'pricing', description: 'Precios de variante.' },
    { resource: 'priceList', description: 'Listas de precios.' },
  ],
  strategies: {
    /** Estrategia de cálculo de precio de línea reemplazable (M-0477). */
    'pricing.calculation': deps => new PriceCalculationService(deps),
  },

  register(deps) {
    const prices = new PriceService(deps);
    const priceLists = new PriceListService(deps);
    return {
      prices,
      priceLists,
      calculation: new PriceCalculationService({
        prices,
        priceLists,
        geography: deps.geography,
        settings: deps.settings,
        cache: deps.cache,
        taxCalculation: deps.tax.calculation,
      }),
    };
  },

  subscribers: container => [
    // La caché de precio se invalida por cambio de precio o de regla (M-0540).
    { event: 'price.*', handler: () => container.resolve('pricing').calculation.invalidate() },
    { event: 'priceList.*', handler: () => container.resolve('pricing').calculation.invalidate() },
  ],

  jobs: container => [
    {
      name: 'pricing.expire-lists',
      everyMs: 3_600_000,
      handler: () => container.resolve('pricing').priceLists.expireOutdated(),
    },
  ],

  routes: {
    admin: container => {
      const module = () => container.resolve('pricing');
      return [
        ...crudRoutes(priceResource, () => module().prices, { permissionResource: 'pricing', tags: ['precios'] }),
        ...crudRoutes(priceListResource, () => module().priceLists, { tags: ['precios'] }),
        {
          method: 'POST',
          path: '/pricing/simulate',
          permission: 'pricing:read',
          summary: 'Simula el precio de una variante en un contexto concreto.',
          tags: ['precios'],
          body: {
            variantId: rule.id({ required: true }),
            currencyCode: rule.currency(),
            regionId: rule.id(),
            channelId: rule.id(),
            customerGroupIds: rule.list({ type: 'string' }),
            quantity: rule.quantity(),
            taxCategoryId: rule.id(),
            address: { type: 'object', shape: { countryCode: rule.country(), postalCode: rule.text(20), provinceId: rule.id() } },
          },
          handler: ctx => module().calculation.calculate(ctx.body),
        },
        {
          method: 'POST',
          path: '/pricing/bulk-adjust',
          permission: 'pricing:update',
          summary: 'Ajusta precios en lote por porcentaje.',
          tags: ['precios'],
          body: {
            priceIds: rule.list({ type: 'string' }, { required: true, maxItems: 1000 }),
            percent: { type: 'number', coerce: true, required: true, min: -90, max: 900 },
            keepCompareAt: rule.flag({ default: true }),
          },
          handler: async ctx => {
            const { priceIds, percent, keepCompareAt } = ctx.body;
            const service = module().prices;
            return service.bulk(async priceId => {
              const price = service.repository.retrieve(priceId);
              const amount = Math.max(0, Math.round(price.amount * (1 + percent / 100)));
              return service.update(priceId, {
                amount,
                compareAtAmount: keepCompareAt && amount < price.amount ? price.amount : price.compareAtAmount,
              }, ctx);
            }, priceIds, ctx);
          },
        },
        {
          method: 'GET',
          path: '/pricing/coverage',
          permission: 'pricing:read',
          summary: 'Variantes publicadas sin precio en alguna moneda soportada.',
          tags: ['precios'],
          bodyless: true,
          handler: () => {
            const settings = container.resolve('settings').settings;
            const catalog = container.resolve('catalog');
            const currencies = settings.get('currencies', ['USD']);
            const published = new Set(catalog.products.published().map(product => product.id));
            const gaps = [];
            for (const variant of catalog.variants.repository.all({ active: true })) {
              if (!published.has(variant.productId)) continue;
              const prices = module().prices.forVariant(variant.id);
              const missing = currencies.filter(code => !prices.some(price => price.currencyCode === code));
              if (missing.length) gaps.push({ variantId: variant.id, sku: variant.sku, title: variant.title, missing });
            }
            return { checkedAt: now(), currencies, gaps, count: gaps.length };
          },
        },
      ];
    },
  },
};
