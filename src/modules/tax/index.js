/**
 * Impuestos (M-0219 … M-0228).
 *
 * Categorías y tasas al estilo Vendure (`taxCategory` + `taxRate` por zona), con el
 * cálculo por línea de Medusa. Dos decisiones importantes:
 *
 *  - el impuesto se calcula **por línea** y se redondea por línea, que es lo que
 *    hace cuadrar el desglose con el total;
 *  - `taxInclusive` de la región decide si el precio ya lleva impuesto o se añade.
 */
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule } from '../../framework/validate.js';
import { distribute, percentage, splitTaxInclusive } from '../../framework/money.js';

export const taxCategoryResource = defineResource({
  name: 'taxCategory',
  collection: 'taxCategories',
  prefix: 'txcat',
  route: 'tax-categories',
  unique: ['code'],
  searchable: ['name', 'code'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(100, { required: true }),
    description: rule.text(300),
    isDefault: rule.flag({ default: false }),
    metadata: rule.metadata(),
  },
});

export const taxRateResource = defineResource({
  name: 'taxRate',
  collection: 'taxRates',
  prefix: 'txrate',
  route: 'tax-rates',
  searchable: ['name', 'code'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(100, { required: true }),
    zoneId: rule.id({ required: true }),
    taxCategoryId: rule.id(),
    customerGroupIds: rule.list({ type: 'string' }, { default: [] }),
    rate: rule.percent({ required: true }),
    // `combinable` decide si esta tasa se suma a otras o las sustituye.
    combinable: rule.flag({ default: false }),
    priority: { type: 'integer', coerce: true, min: 0, max: 1000, default: 100 },
    active: rule.flag({ default: true }),
    metadata: rule.metadata(),
  },
});

export class TaxCategoryService extends BaseService {
  constructor(deps) {
    super(deps, taxCategoryResource);
  }

  default() {
    return this.repository.find({ isDefault: true }) || this.repository.all()[0] || null;
  }

  async beforeCreate(data) {
    if (data.isDefault) await this.clearDefault();
    return data;
  }

  async beforeUpdate(existing, changes) {
    if (changes.isDefault) await this.clearDefault(existing.id);
    return changes;
  }

  async clearDefault(exceptId = null) {
    const current = this.repository.all({ isDefault: true }).filter(row => row.id !== exceptId);
    if (!current.length) return;
    await this.store.transaction(state => {
      for (const row of current) this.repository.patch(state, row.id, { isDefault: false });
    });
  }
}

export class TaxRateService extends BaseService {
  constructor(deps) {
    super(deps, taxRateResource);
  }

  /**
   * Tasas aplicables a una zona y categoría. Si hay una no combinable, gana la de
   * mayor prioridad y se descarta el resto: dos IVA sumados serían un error caro.
   */
  applicable({ zoneId, taxCategoryId = null, customerGroupIds = [] }) {
    const candidates = this.repository
      .all({ active: true, zoneId })
      .filter(rate => !rate.taxCategoryId || rate.taxCategoryId === taxCategoryId)
      .filter(rate => !rate.customerGroupIds?.length || rate.customerGroupIds.some(groupId => customerGroupIds.includes(groupId)))
      .sort((a, b) => b.priority - a.priority);

    const exclusive = candidates.find(rate => !rate.combinable);
    return exclusive ? [exclusive] : candidates;
  }
}

export class TaxCalculationService {
  constructor({ store, geography, taxRates, settings }) {
    this.store = store;
    this.geography = geography;
    this.taxRates = taxRates;
    this.settings = settings;
  }

  /**
   * Calcula el impuesto de un conjunto de líneas.
   *
   * @param {object} input
   * @param {Array<{id:string, amount:number, taxCategoryId?:string}>} input.lines importes en unidades mínimas
   * @param {object} input.address dirección de destino
   * @param {object} input.region
   * @param {string[]} input.customerGroupIds
   * @param {boolean} input.taxExempt exención por cliente con número fiscal (M-0224)
   * @returns {{lines:Array, totalTax:number, inclusive:boolean, breakdown:Array}}
   */
  calculate({ lines = [], address = {}, region = null, customerGroupIds = [], taxExempt = false, shipping = null }) {
    const effectiveRegion = region || this.geography.regions.forCountry(address.countryCode);
    const inclusive = Boolean(effectiveRegion?.taxInclusive);

    if (taxExempt || !effectiveRegion?.automaticTaxes) {
      return {
        lines: lines.map(line => ({ ...line, taxLines: [], tax: 0, net: line.amount, gross: line.amount })),
        shipping: shipping ? { ...shipping, taxLines: [], tax: 0 } : null,
        totalTax: 0,
        inclusive,
        exempt: taxExempt,
        breakdown: [],
      };
    }

    const zone = this.geography.zones.resolve(address)
      || this.geography.zones.repository.byId(effectiveRegion?.zoneIds?.[0]);

    const computed = lines.map(line => {
      const rates = zone
        ? this.taxRates.applicable({ zoneId: zone.id, taxCategoryId: line.taxCategoryId || null, customerGroupIds })
        : [];
      const totalRate = rates.reduce((sum, rate) => sum + Number(rate.rate || 0), 0);

      if (!totalRate) {
        return { ...line, taxLines: [], tax: 0, net: line.amount, gross: line.amount };
      }

      if (inclusive) {
        const split = splitTaxInclusive(line.amount, totalRate);
        return {
          ...line,
          taxLines: shareTax(rates, split.tax, totalRate),
          tax: split.tax,
          net: split.net,
          gross: split.gross,
        };
      }
      const tax = percentage(line.amount, totalRate);
      return {
        ...line,
        taxLines: shareTax(rates, tax, totalRate),
        tax,
        net: line.amount,
        gross: line.amount + tax,
      };
    });

    let shippingResult = null;
    if (shipping && effectiveRegion?.shippingTaxable !== false && shipping.amount) {
      const rates = zone ? this.taxRates.applicable({ zoneId: zone.id, customerGroupIds }) : [];
      const totalRate = rates.reduce((sum, rate) => sum + Number(rate.rate || 0), 0);
      if (totalRate) {
        const value = inclusive ? splitTaxInclusive(shipping.amount, totalRate) : { tax: percentage(shipping.amount, totalRate) };
        shippingResult = { ...shipping, taxLines: shareTax(rates, value.tax, totalRate), tax: value.tax };
      } else {
        shippingResult = { ...shipping, taxLines: [], tax: 0 };
      }
    } else if (shipping) {
      shippingResult = { ...shipping, taxLines: [], tax: 0 };
    }

    const totalTax = computed.reduce((sum, line) => sum + line.tax, 0) + (shippingResult?.tax || 0);

    return {
      lines: computed,
      shipping: shippingResult,
      totalTax,
      inclusive,
      exempt: false,
      zoneId: zone?.id || null,
      regionId: effectiveRegion?.id || null,
      breakdown: buildBreakdown(computed, shippingResult),
    };
  }
}

/** Reparte el impuesto entre las tasas que lo componen, sin perder unidades. */
function shareTax(rates, taxAmount, totalRate) {
  if (!rates.length || !taxAmount) return [];
  const shares = distribute(taxAmount, rates.map(rate => Number(rate.rate || 0) / (totalRate || 1)));
  return rates.map((rate, index) => ({
    taxRateId: rate.id,
    code: rate.code,
    name: rate.name,
    rate: rate.rate,
    amount: shares[index],
  }));
}

/** Desglose por tasa para el pedido (M-0226). */
function buildBreakdown(lines, shipping) {
  const totals = new Map();
  const collect = taxLines => {
    for (const taxLine of taxLines || []) {
      const current = totals.get(taxLine.taxRateId) || { ...taxLine, amount: 0 };
      current.amount += taxLine.amount;
      totals.set(taxLine.taxRateId, current);
    }
  };
  for (const line of lines) collect(line.taxLines);
  collect(shipping?.taxLines);
  return [...totals.values()].sort((a, b) => b.amount - a.amount);
}

export default {
  name: 'tax',
  requires: ['store', 'events', 'audit', 'config', 'customFields', 'geography', 'settings'],
  resources: [taxCategoryResource, taxRateResource],
  permissions: [
    { resource: 'taxCategory', description: 'Categorías de impuesto.' },
    { resource: 'taxRate', description: 'Tasas de impuesto por zona.' },
  ],
  strategies: {
    /** Estrategia de cálculo de impuesto reemplazable (M-0227). */
    'tax.calculation': ({ geography, taxRates, settings, store }) => new TaxCalculationService({ geography, taxRates, settings, store }),
  },

  register(deps) {
    const categories = new TaxCategoryService(deps);
    const rates = new TaxRateService(deps);
    return {
      categories,
      rates,
      calculation: new TaxCalculationService({
        store: deps.store,
        geography: deps.geography,
        taxRates: rates,
        settings: deps.settings,
      }),
    };
  },

  async seed(service) {
    await service.categories.seed([
      { id: 'txcat_standard', code: 'standard', name: 'Tasa estándar', isDefault: true },
      { id: 'txcat_reduced', code: 'reduced', name: 'Tasa reducida' },
      { id: 'txcat_zero', code: 'zero', name: 'Exento' },
      { id: 'txcat_digital', code: 'digital', name: 'Servicios digitales' },
    ], 'id');
    await service.rates.seed([
      { id: 'txrate_py_standard', code: 'py-iva-10', name: 'IVA Paraguay 10 %', zoneId: 'zone_py', taxCategoryId: 'txcat_standard', rate: 10 },
      { id: 'txrate_py_reduced', code: 'py-iva-5', name: 'IVA Paraguay 5 %', zoneId: 'zone_py', taxCategoryId: 'txcat_reduced', rate: 5 },
      { id: 'txrate_py_zero', code: 'py-exento', name: 'Exento Paraguay', zoneId: 'zone_py', taxCategoryId: 'txcat_zero', rate: 0 },
    ], 'id');
  },

  routes: {
    admin: container => {
      const module = () => container.resolve('tax');
      return [
        ...crudRoutes(taxCategoryResource, () => module().categories, { tags: ['impuestos'] }),
        ...crudRoutes(taxRateResource, () => module().rates, { tags: ['impuestos'] }),
        {
          method: 'POST',
          path: '/tax/calculate',
          permission: 'taxRate:read',
          summary: 'Simula el cálculo de impuesto sobre unas líneas.',
          tags: ['impuestos'],
          body: {
            lines: rule.list({ type: 'object', shape: { id: rule.id(), amount: rule.minor({ required: true }), taxCategoryId: rule.id() } }, { required: true }),
            address: { type: 'object', shape: { countryCode: rule.country(), provinceId: rule.id(), postalCode: rule.text(20) } },
            regionId: rule.id(),
            customerGroupIds: rule.list({ type: 'string' }),
            taxExempt: rule.flag(),
            shipping: { type: 'object', shape: { amount: rule.minor() } },
          },
          handler: ctx => {
            const geography = container.resolve('geography');
            const region = ctx.body.regionId ? geography.regions.repository.byId(ctx.body.regionId) : null;
            return module().calculation.calculate({ ...ctx.body, region });
          },
        },
      ];
    },
  },
};
