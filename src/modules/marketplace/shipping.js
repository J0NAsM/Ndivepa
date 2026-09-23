/**
 * Envío por tienda.
 *
 * Un carrito con tres tiendas puede necesitar tres entregas distintas: retiro en
 * una, entrega local en otra y envío nacional en la tercera. Este servicio arma
 * las opciones elegibles **por grupo** y valida la selección antes de guardarla;
 * los importes salen siempre de las opciones configuradas, nunca del cliente.
 */
import { ConflictError, ValidationError } from '../../framework/errors.js';
import { DELIVERY_MODE_LABELS } from './models.js';

/** Modo de entrega que representa una opción de envío. */
export function optionMode(option) {
  if (!option) return 'national_shipping';
  if (option.provider === 'pickup' || /retiro|pickup/i.test(option.code || '')) return 'pickup';
  if (/local/i.test(option.code || '')) return 'local_delivery';
  return 'national_shipping';
}

/**
 * Estimación de entrega antes de llegar al checkout.
 *
 * El coste de envío que aparece tarde es la primera causa de carritos
 * abandonados. Esto permite mostrarlo en la ficha y en el carrito usando las
 * mismas opciones reales que después se cobran: si no hay ninguna configurada
 * para esa localidad, se dice que no se pudo estimar en vez de inventar un
 * importe.
 */
export class DeliveryEstimateService {
  constructor({ fulfillment, channel, catalog, store, settings }) {
    this.fulfillment = fulfillment;
    this.channel = channel;
    this.catalog = catalog;
    this.store = store;
    this.settings = settings;
  }

  /** Dirección aproximada de una localidad: país y ciudad, nunca una calle. */
  addressFor(localityId) {
    const locality = localityId
      ? this.store.collection('localities').find(row => row.id === localityId && !row.deletedAt)
      : null;
    return {
      locality,
      address: { countryCode: locality?.countryCode || 'py', city: locality?.name || null },
    };
  }

  /** La más barata de cada modo de entrega: el comprador compara sin ruido. */
  static cheapestByMode(options) {
    const best = new Map();
    for (const option of options) {
      const current = best.get(option.mode);
      if (!current || option.amount < current.amount) best.set(option.mode, option);
    }
    return [...best.values()].sort((a, b) => a.amount - b.amount);
  }

  /**
   * Estimación para un producto suelto.
   * @returns {{localityId:string|null, localityName:string|null, options:Array, freeFrom:number|null, available:boolean}}
   */
  forProduct(product, { localityId = null, variantId = null, quantity = 1 } = {}) {
    const { locality, address } = this.addressFor(localityId);
    const currencyCode = this.settings.get('marketplace.currencyCode', 'PYG');
    const variants = this.catalog.variants.forProduct(product.id);
    const variant = (variantId ? variants.find(row => row.id === variantId) : null) || variants[0] || null;
    const amount = Number(product.price?.amount ?? 0) * quantity;
    const items = [{
      productId: product.id,
      variantId: variant?.id || null,
      quantity,
      requiresShipping: product.requiresShipping !== false,
      weight: variant?.weight || 0,
      total: amount,
    }];

    const seller = product.sellerId ? this.channel.sellers.repository.byId(product.sellerId) : null;
    const allowedModes = product.deliveryModes?.length
      ? product.deliveryModes
      : (seller?.deliveryModes?.length ? seller.deliveryModes : null);

    const eligible = this.fulfillment.options
      .eligible({ address, items, subtotal: amount, currencyCode })
      .map(option => ({ ...option, mode: optionMode(this.fulfillment.options.repository.byId(option.id)) }))
      .filter(option => !option.requiresCredentials)
      .filter(option => !allowedModes || allowedModes.includes(option.mode))
      .map(option => ({
        id: option.id,
        name: option.name,
        description: option.description || null,
        mode: option.mode,
        modeLabel: DELIVERY_MODE_LABELS[option.mode] || option.mode,
        amount: option.amount,
        currency: option.currencyCode || currencyCode,
        estimatedDaysMin: option.estimatedDaysMin ?? null,
        estimatedDaysMax: option.estimatedDaysMax ?? null,
        freeOverAmount: option.freeOverAmount ?? null,
      }));

    const freeFrom = eligible
      .map(option => option.freeOverAmount)
      .filter(value => typeof value === 'number' && value > 0)
      .sort((a, b) => a - b)[0] ?? null;

    return {
      localityId: locality?.id || null,
      localityName: locality?.name || null,
      options: DeliveryEstimateService.cheapestByMode(eligible),
      freeFrom,
      available: eligible.length > 0,
    };
  }
}

export class CartShippingService {
  constructor({ cart, fulfillment, channel, customer, catalog, vendorOrders, store }) {
    this.cart = cart;
    this.fulfillment = fulfillment;
    this.channel = channel;
    this.customer = customer;
    this.catalog = catalog;
    this.vendorOrders = vendorOrders;
    this.store = store;
  }

  /** Agrupa las líneas por responsable, con su título y sus modos de entrega. */
  groups(cart) {
    const groups = new Map();
    for (const line of cart.items || []) {
      const party = this.vendorOrders.partyOf(line);
      if (!groups.has(party.key)) {
        const seller = party.sellerId ? this.channel.sellers.repository.byId(party.sellerId) : null;
        const supplier = party.supplierId ? this.store.collection('suppliers').find(row => row.id === party.supplierId) : null;
        groups.set(party.key, {
          key: party.key,
          partyType: party.partyType,
          sellerId: party.sellerId || null,
          supplierId: party.supplierId || null,
          title: seller?.name || (supplier ? 'Proveedor aliado' : 'Vendido por Ndivepa'),
          allowedModes: seller?.deliveryModes?.length ? seller.deliveryModes : null,
          items: [],
          subtotal: 0,
          requiresShipping: false,
        });
      }
      const group = groups.get(party.key);
      group.items.push(line);
      group.subtotal += Number(line.subtotalAfterDiscount ?? line.total ?? 0);
      if (line.requiresShipping) group.requiresShipping = true;
    }
    return [...groups.values()];
  }

  /**
   * Opciones elegibles para cada grupo, ya filtradas por lo que ofrece la tienda.
   * `fallbackAddress` permite estimar el envío antes de que el carrito tenga
   * dirección; la selección real sigue validándose contra la dirección guardada.
   */
  optionsFor(cart, { fallbackAddress = null } = {}) {
    const customerGroupIds = cart.customerId ? this.customer.customers.groupsFor(cart.customerId) : [];
    const selected = new Map((cart.shippingMethods || []).map(method => [method.groupKey, method.shippingOptionId]));
    const stored = cart.shippingAddress || {};
    const address = stored.countryCode || stored.city ? stored : (fallbackAddress || stored);
    return this.groups(cart).map(group => {
      const eligible = this.fulfillment.options.eligible({
        address,
        items: group.items,
        subtotal: group.subtotal,
        channelId: cart.channelId,
        currencyCode: cart.currencyCode,
        customerGroupIds,
      });
      const options = eligible
        .map(option => ({ ...option, mode: optionMode(this.fulfillment.options.repository.byId(option.id)) }))
        .filter(option => !group.allowedModes || group.allowedModes.includes(option.mode))
        .filter(option => !option.requiresCredentials)
        .map(option => ({ ...option, modeLabel: DELIVERY_MODE_LABELS[option.mode] || option.mode }));
      return {
        key: group.key,
        title: group.title,
        partyType: group.partyType,
        sellerId: group.sellerId,
        itemCount: group.items.reduce((sum, item) => sum + item.quantity, 0),
        subtotal: group.subtotal,
        requiresShipping: group.requiresShipping,
        selectedOptionId: selected.get(group.key) || null,
        options,
      };
    });
  }

  /**
   * Guarda una selección por grupo. Rechaza grupos desconocidos, opciones no
   * elegibles y selecciones incompletas.
   */
  async select(cartId, selections, ctx = null) {
    const cart = this.cart.repository.retrieve(cartId);
    const groups = this.optionsFor(cart);
    const byKey = new Map(groups.map(group => [group.key, group]));
    const methods = [];
    const issues = [];

    for (const selection of selections) {
      const group = byKey.get(selection.group);
      if (!group) {
        issues.push({ field: 'group', message: `Grupo desconocido: ${selection.group}.` });
        continue;
      }
      const option = group.options.find(entry => entry.id === selection.shippingOptionId);
      if (!option) {
        issues.push({ field: 'shippingOptionId', message: `La opción elegida no está disponible para ${group.title}.` });
        continue;
      }
      methods.push({
        groupKey: group.key,
        sellerId: group.sellerId,
        supplierId: group.supplierId || null,
        shippingOptionId: option.id,
        name: option.name,
        amount: option.amount,
        taxable: option.taxable,
        mode: option.mode,
        estimatedDaysMin: option.estimatedDaysMin ?? null,
        estimatedDaysMax: option.estimatedDaysMax ?? null,
      });
    }
    if (issues.length) throw new ValidationError(issues);

    const covered = new Set(methods.map(method => method.groupKey));
    const missing = groups.filter(group => !covered.has(group.key));
    if (missing.length) {
      throw new ConflictError(`Falta elegir la entrega de: ${missing.map(group => group.title).join(', ')}.`, {
        missing: missing.map(group => group.key),
      });
    }
    return this.cart.setShippingMethods(cartId, methods, ctx);
  }
}
