/**
 * Dropshipping (v4).
 *
 *   Proveedor -> Catálogo -> Producto -> Pedido -> Proveedor -> Despacho -> Cliente
 *
 * El proveedor no es una tienda: la plataforma vende con su precio y su margen, y
 * el proveedor despacha. Por eso el producto es `DROPSHIPPING` y el subpedido
 * tiene `partyType: 'supplier'`.
 *
 * Nada de este módulo llama a una API de proveedor: la integración es manual o
 * por CSV hasta que exista un proveedor con contrato y API documentada. El
 * adaptador se elige por proveedor (`integrationType`) y se puede sustituir sin
 * tocar el resto (`marketplace/adapters.js`).
 */
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule } from '../../framework/validate.js';
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '../../framework/errors.js';
import { now } from '../../framework/dates.js';
import { LISTING_INPUT } from '../marketplace/listings.js';

export const SUPPLIER_ORDER_STATUSES = ['pending', 'sent', 'accepted', 'shipped', 'delivered', 'cancelled', 'failed'];

const SUPPLIER_ORDER_TRANSITIONS = {
  pending: ['sent', 'cancelled'],
  sent: ['accepted', 'shipped', 'cancelled', 'failed'],
  accepted: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  failed: ['sent', 'cancelled'],
  delivered: [],
  cancelled: [],
};

export const supplierResource = defineResource({
  name: 'supplier', collection: 'suppliers', prefix: 'sup', route: 'suppliers', unique: ['code'], searchable: ['name', 'code'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(120, { required: true }),
    status: rule.enumOf(['pending', 'active', 'suspended'], { default: 'pending' }),
    contactEmail: rule.email(),
    contactPhone: rule.text(40),
    website: rule.url(),
    // `manual` y `csv` funcionan hoy; `api` exige un adaptador real registrado.
    integrationType: rule.enumOf(['manual', 'csv', 'api'], { default: 'manual' }),
    defaultLeadTimeDays: { type: 'integer', coerce: true, min: 0, max: 120, default: 5 },
    shippingPolicy: rule.text(1000),
    notes: rule.text(1000),
    metadata: rule.metadata(),
  },
});

export const supplierMemberResource = defineResource({
  name: 'supplierMember', collection: 'supplierMembers', prefix: 'supm', route: 'supplier-members', searchable: ['supplierId'],
  fields: {
    supplierId: rule.id({ required: true }),
    customerId: rule.id({ required: true }),
    role: rule.enumOf(['owner', 'staff'], { default: 'owner' }),
    status: rule.enumOf(['active', 'revoked'], { default: 'active' }),
  },
});

export const supplierProductResource = defineResource({
  name: 'supplierProduct', collection: 'supplierProducts', prefix: 'supp', route: 'supplier-products', searchable: ['supplierSku'],
  fields: {
    supplierId: rule.id({ required: true }),
    productId: rule.id({ required: true }),
    variantId: rule.id(),
    supplierSku: rule.text(80, { required: true }),
    // Costo del proveedor en unidades mínimas de `currencyCode`.
    cost: rule.minor({ required: true, min: 0 }),
    currencyCode: rule.currency({ default: 'PYG' }),
    stock: { type: 'integer', coerce: true, min: 0, max: 1_000_000 },
    stockSyncedAt: rule.date(),
    costUpdatedAt: rule.date(),
    leadTimeDays: { type: 'integer', coerce: true, min: 0, max: 120 },
    active: rule.flag({ default: true }),
    metadata: rule.metadata(),
  },
});

export const supplierOrderResource = defineResource({
  name: 'supplierOrder', collection: 'supplierOrders', prefix: 'supo', route: 'supplier-orders', searchable: ['externalReference'],
  fields: {
    supplierId: rule.id({ required: true }),
    vendorOrderId: rule.id({ required: true }),
    orderId: rule.id({ required: true }),
    code: rule.text(60),
    items: { type: 'array', default: [] },
    costTotal: rule.minor({ default: 0 }),
    currencyCode: rule.currency({ required: true }),
    status: rule.enumOf(SUPPLIER_ORDER_STATUSES, { default: 'pending' }),
    externalReference: rule.text(120),
    tracking: { type: 'object', shape: { carrier: rule.text(80), trackingNumber: rule.text(120), trackingUrl: rule.url() } },
    shippingAddress: { type: 'object', shape: {}, allowUnknown: true },
    events: { type: 'array', default: [] },
    sentAt: rule.date(),
    metadata: rule.metadata(),
  },
});

export class DropshippingService {
  constructor(deps) {
    this.store = deps.store;
    this.events = deps.events;
    this.settings = deps.settings;
    this.catalog = deps.catalog;
    this.inventory = deps.inventory;
    this.order = deps.order;
    this.customer = deps.customer;
    this.marketplace = deps.marketplace;
    this.suppliers = new BaseService(deps, supplierResource);
    this.members = new BaseService(deps, supplierMemberResource);
    this.products = new BaseService(deps, supplierProductResource);
    this.orders = new BaseService(deps, supplierOrderResource);
  }

  get currency() { return this.settings.get('marketplace.currencyCode', 'PYG'); }

  adapterFor(supplier) {
    const name = supplier.integrationType === 'api' ? supplier.code : supplier.integrationType || 'manual';
    return this.marketplace.adapters.get('dropshipping', name);
  }

  /** Cada proveedor activo tiene su ubicación de stock `dropship`. */
  async ensureLocation(supplier, ctx = null) {
    const code = `proveedor-${supplier.code}`.slice(0, 110);
    const existing = this.inventory.locations.repository.find({ code });
    if (existing) return existing;
    return this.inventory.locations.create({
      code, name: `Stock de ${supplier.name}`.slice(0, 120), type: 'dropship', priority: 80, active: true, metadata: { supplierId: supplier.id },
    }, ctx);
  }

  async activate(supplierId, status, ctx) {
    const supplier = await this.suppliers.update(supplierId, { status }, ctx);
    if (status === 'active') await this.ensureLocation(supplier, ctx);
    await this.events.emit('marketplace.seller.supplier_status', { supplierId, status });
    return supplier;
  }

  margin(price, cost) {
    const value = Number(price || 0) - Number(cost || 0);
    return { amount: value, percent: price ? Math.round((value / price) * 1000) / 10 : null };
  }

  /** Alta de un producto de proveedor: ficha DROPSHIPPING + costo. El margen no puede ser negativo. */
  async createProduct({ supplierId, supplierSku, cost, leadTimeDays = null, ...listing }, ctx = null) {
    const supplier = this.suppliers.repository.retrieve(supplierId);
    if (supplier.status !== 'active') throw new ConflictError('Activa el proveedor antes de cargar productos.');
    const price = listing.variants?.[0]?.price ?? listing.price;
    if (!(price > cost)) throw ValidationError.single('price', `El precio (${price}) debe superar el costo del proveedor (${cost}).`);
    if (this.products.repository.find({ supplierId, supplierSku })) throw new ConflictError(`El SKU del proveedor ${supplierSku} ya está cargado.`);
    const created = await this.marketplace.listings.create({ supplierId }, { ...listing, deliveryModes: ['supplier_shipping'] }, ctx);
    const variant = created.variants[0];
    const record = await this.products.create({
      supplierId, productId: created.id, variantId: variant.id, supplierSku, cost, currencyCode: this.currency,
      stock: listing.stock ?? null, stockSyncedAt: listing.stock !== undefined ? now() : null, costUpdatedAt: now(),
      leadTimeDays: leadTimeDays ?? supplier.defaultLeadTimeDays, active: true,
    }, ctx);
    return { product: created, supplierProduct: record, margin: this.margin(price, cost) };
  }

  /** Actualiza costo, stock o disponibilidad; el stock se refleja en inventario. */
  async updateProduct(id, { cost, stock, active, leadTimeDays }, ctx = null) {
    const record = this.products.repository.retrieve(id);
    const changes = {};
    if (cost !== undefined) {
      const price = this.catalog.products.repository.byId(record.productId)?.price?.amount || 0;
      if (!(price > cost)) throw ValidationError.single('cost', `Con ese costo el margen queda negativo (precio ${price}).`);
      Object.assign(changes, { cost, costUpdatedAt: now() });
    }
    if (active !== undefined) changes.active = active;
    if (leadTimeDays !== undefined) changes.leadTimeDays = leadTimeDays;
    if (stock !== undefined && stock !== null) {
      const variant = this.catalog.variants.repository.retrieve(record.variantId);
      await this.marketplace.listings.setStock(variant, stock, { owner: { supplierId: record.supplierId }, reason: 'Sincronización de stock del proveedor' }, ctx);
      Object.assign(changes, { stock, stockSyncedAt: now() });
    }
    if (!Object.keys(changes).length) throw ValidationError.single('body', 'Nada que actualizar.');
    const updated = await this.products.update(id, changes, ctx);
    if (active === false) await this.marketplace.listings.unpublish(record.productId, ctx);
    return updated;
  }

  /**
   * Importación de catálogo del proveedor: actualiza costo y stock de los SKU ya
   * vinculados. Los SKU desconocidos se informan, no se convierten en productos:
   * publicar requiere revisión humana del precio y la ficha.
   */
  async importCatalog(supplierId, { csv, dryRun = true }, ctx = null) {
    const supplier = this.suppliers.repository.retrieve(supplierId);
    const rows = await this.marketplace.adapters.get('dropshipping', 'csv').importCatalog({ csv });
    const report = { dryRun, supplier: supplier.code, total: rows.length, updated: 0, unknown: 0, invalid: 0, rows: [] };
    for (const row of rows) {
      if (!row.supplierSku) {
        report.invalid += 1;
        report.rows.push({ line: row.line, status: 'error', issues: ['Falta supplier_sku.'] });
        continue;
      }
      const linked = this.products.repository.find({ supplierId, supplierSku: row.supplierSku });
      if (!linked) {
        report.unknown += 1;
        report.rows.push({ line: row.line, status: 'unknown', supplierSku: row.supplierSku, name: row.name });
        continue;
      }
      const issues = [];
      if (row.cost !== null && !(Number.isInteger(row.cost) && row.cost >= 0)) issues.push('Costo inválido.');
      if (row.stock !== null && !(Number.isInteger(row.stock) && row.stock >= 0)) issues.push('Stock inválido.');
      if (issues.length) {
        report.invalid += 1;
        report.rows.push({ line: row.line, status: 'error', supplierSku: row.supplierSku, issues });
        continue;
      }
      if (!dryRun) {
        try {
          await this.updateProduct(linked.id, {
            cost: row.cost ?? undefined, stock: row.stock ?? undefined, leadTimeDays: row.leadTimeDays ?? undefined,
          }, ctx);
        } catch (error) {
          report.invalid += 1;
          report.rows.push({ line: row.line, status: 'error', supplierSku: row.supplierSku, issues: [error.message] });
          continue;
        }
      }
      report.updated += 1;
      report.rows.push({ line: row.line, status: dryRun ? 'valid' : 'updated', supplierSku: row.supplierSku });
    }
    return report;
  }

  /** Pedido al proveedor a partir de su subpedido. Idempotente por subpedido. */
  async createFromVendorOrder(vendorOrder) {
    if (vendorOrder.partyType !== 'supplier') return null;
    const existing = this.orders.repository.find({ vendorOrderId: vendorOrder.id });
    if (existing) return existing;
    const order = this.order.orders.repository.byId(vendorOrder.orderId);
    const items = (vendorOrder.items || []).map(item => {
      const link = this.products.repository.all({ supplierId: vendorOrder.supplierId })
        .find(row => row.variantId === item.variantId || row.productId === item.productId);
      return {
        lineItemId: item.lineItemId, productId: item.productId, variantId: item.variantId, title: item.title,
        supplierSku: link?.supplierSku || null, quantity: item.quantity, unitCost: link ? link.cost : null,
      };
    });
    const record = await this.orders.create({
      supplierId: vendorOrder.supplierId,
      vendorOrderId: vendorOrder.id,
      orderId: vendorOrder.orderId,
      code: `PRV-${vendorOrder.code}`,
      items,
      costTotal: vendorOrder.supplierCost,
      currencyCode: vendorOrder.currencyCode,
      status: 'pending',
      // El proveedor recibe solo lo necesario para despachar.
      shippingAddress: order?.shippingAddress ? {
        firstName: order.shippingAddress.firstName, lastName: order.shippingAddress.lastName, address1: order.shippingAddress.address1,
        address2: order.shippingAddress.address2, city: order.shippingAddress.city, province: order.shippingAddress.province,
        countryCode: order.shippingAddress.countryCode, phone: order.shippingAddress.phone,
      } : {},
      events: [{ at: now(), status: 'pending', note: 'Generado desde el subpedido' }],
    });
    await this.notifySupplier(record, { type: 'supplier_order', title: `Nuevo pedido ${record.code}`, body: `${items.length} artículo(s) para despachar.` });
    return record;
  }

  async notifySupplier(supplierOrder, message) {
    for (const member of this.members.repository.all({ supplierId: supplierOrder.supplierId, status: 'active' })) {
      await this.marketplace.inbox.notify({
        recipientId: member.customerId, audience: 'supplier', link: `/cuenta/proveedor/${supplierOrder.supplierId}`, ...message,
      });
    }
  }

  /** Envío al proveedor mediante su adaptador. El manual solo registra el envío. */
  async send(supplierOrderId, { externalReference = null } = {}, ctx = null) {
    const supplierOrder = this.orders.repository.retrieve(supplierOrderId);
    const vendorOrder = this.marketplace.vendorOrders.repository.retrieve(supplierOrder.vendorOrderId);
    if (!['paid', 'preparing'].includes(vendorOrder.status) && !['cash_on_delivery'].includes(vendorOrder.paymentProvider)) {
      throw new ConflictError('El pedido aún no está pagado; no se envía al proveedor.');
    }
    const supplier = this.suppliers.repository.retrieve(supplierOrder.supplierId);
    const result = await this.adapterFor(supplier).placeOrder(supplierOrder);
    return this.transition(supplierOrderId, 'sent', { externalReference: externalReference || result.externalReference, note: result.note }, ctx);
  }

  /**
   * Estado del pedido del proveedor y su reflejo en el subpedido del marketplace.
   * Aceptado -> en preparación; enviado -> enviado (con seguimiento); entregado.
   */
  async transition(supplierOrderId, target, { tracking = null, externalReference = null, note = null } = {}, ctx = null) {
    const supplierOrder = this.orders.repository.retrieve(supplierOrderId);
    const allowed = SUPPLIER_ORDER_TRANSITIONS[supplierOrder.status] || [];
    if (!allowed.includes(target)) throw new ConflictError(`No se puede pasar el pedido del proveedor de "${supplierOrder.status}" a "${target}".`, { allowed });
    const patch = {
      status: target,
      events: [...(supplierOrder.events || []), { at: now(), status: target, note }],
    };
    if (target === 'sent') patch.sentAt = now();
    if (externalReference) patch.externalReference = externalReference;
    if (tracking) patch.tracking = { ...(supplierOrder.tracking || {}), ...tracking };
    const updated = await this.orders.update(supplierOrderId, patch, ctx);

    const vendorOrders = this.marketplace.vendorOrders;
    const walk = async (targets, options = {}) => {
      for (const status of targets) {
        const current = vendorOrders.repository.retrieve(supplierOrder.vendorOrderId);
        if (current.status === status) continue;
        await vendorOrders.transition(current.id, status, { actorType: 'supplier', ctx, ...options });
      }
    };
    const vendorOrder = vendorOrders.repository.retrieve(supplierOrder.vendorOrderId);
    if (target === 'accepted' && ['paid', 'payment_pending'].includes(vendorOrder.status)) await walk(['preparing']);
    if (target === 'shipped') {
      const path = ['paid', 'payment_pending'].includes(vendorOrder.status) ? ['preparing', 'ready_to_ship', 'shipped']
        : vendorOrder.status === 'preparing' ? ['ready_to_ship', 'shipped'] : vendorOrder.status === 'ready_to_ship' ? ['shipped'] : [];
      await walk(path, { tracking: updated.tracking || null });
    }
    if (target === 'delivered' && ['shipped', 'in_transit'].includes(vendorOrders.repository.retrieve(vendorOrder.id).status)) await walk(['delivered']);
    if (target === 'cancelled' && !['shipped', 'in_transit', 'delivered', 'cancelled'].includes(vendorOrder.status)) {
      await vendorOrders.transition(vendorOrder.id, 'cancelled', { actorType: 'supplier', note: note || 'Cancelado por el proveedor', ctx });
    }
    return updated;
  }

  requireMember(ctx, supplierId) {
    const customer = this.customer.customers.customerFromRequest(ctx);
    if (!customer) throw new UnauthorizedError('Inicia sesión para continuar.');
    const member = this.members.repository.find({ supplierId, customerId: customer.id, status: 'active' });
    if (!member) throw new NotFoundError('proveedor', supplierId);
    return { customer, supplier: this.suppliers.repository.retrieve(supplierId), actorCtx: { actor: { id: customer.id, type: 'customer', permissions: new Set() }, ip: ctx.ip, requestId: ctx.requestId } };
  }

  summary() {
    const vendorOrders = this.store.collection('vendorOrders').filter(row => row.partyType === 'supplier' && row.status !== 'cancelled');
    return this.suppliers.repository.all().map(supplier => {
      const rows = vendorOrders.filter(row => row.supplierId === supplier.id);
      const sales = rows.reduce((sum, row) => sum + row.total, 0);
      const cost = rows.reduce((sum, row) => sum + row.supplierCost, 0);
      return {
        supplierId: supplier.id, name: supplier.name, status: supplier.status, integrationType: supplier.integrationType,
        products: this.products.repository.count({ supplierId: supplier.id }), orders: rows.length, sales, cost, margin: rows.reduce((sum, row) => sum + row.platformMargin, 0),
        pendingOrders: this.orders.repository.all({ supplierId: supplier.id }).filter(row => ['pending', 'sent', 'accepted'].includes(row.status)).length,
        marginPercent: sales ? Math.round(((sales - cost) / sales) * 1000) / 10 : null,
      };
    });
  }
}

export default {
  name: 'dropshipping',
  requires: ['store', 'events', 'audit', 'config', 'customFields', 'settings', 'catalog', 'inventory', 'order', 'customer', 'marketplace'],
  resources: [supplierResource, supplierMemberResource, supplierProductResource, supplierOrderResource],
  permissions: [
    { resource: 'supplier', description: 'Proveedores de dropshipping.' },
    { resource: 'supplierMember', description: 'Cuentas de proveedores.' },
    { resource: 'supplierProduct', description: 'Catálogo, costos y stock de proveedores.' },
    { resource: 'supplierOrder', description: 'Pedidos a proveedores.' },
  ],

  register(deps) {
    return new DropshippingService(deps);
  },

  subscribers: container => [
    { event: 'vendorOrder.created', handler: payload => container.resolve('dropshipping').createFromVendorOrder(payload.record) },
  ],

  routes: {
    admin: container => {
      const service = () => container.resolve('dropshipping');
      const tags = ['dropshipping'];
      return [
        ...crudRoutes(supplierResource, () => service().suppliers, { tags }),
        ...crudRoutes(supplierMemberResource, () => service().members, { tags }),
        ...crudRoutes(supplierProductResource, () => service().products, { tags }).filter(route => route.method === 'GET'),
        ...crudRoutes(supplierOrderResource, () => service().orders, { tags }).filter(route => route.method === 'GET'),
        {
          method: 'POST', path: '/dropshipping/suppliers/:id/status', permission: 'supplier:update', tags,
          body: { status: rule.enumOf(['active', 'suspended', 'pending'], { required: true }) },
          summary: 'Activa o suspende un proveedor (crea su ubicación de stock).',
          handler: ctx => service().activate(ctx.params.id, ctx.body.status, ctx),
        },
        {
          method: 'POST', path: '/dropshipping/products', permission: 'supplierProduct:create', status: 201, tags,
          body: { ...LISTING_INPUT, supplierId: rule.id({ required: true }), supplierSku: rule.text(80, { required: true }), cost: rule.minor({ required: true, min: 0 }), leadTimeDays: { type: 'integer', coerce: true, min: 0, max: 120 } },
          summary: 'Carga un producto de proveedor con su costo; el precio debe dejar margen positivo.',
          handler: ctx => service().createProduct(ctx.body, ctx),
        },
        {
          method: 'PATCH', path: '/dropshipping/supplier-products/:id', permission: 'supplierProduct:update', tags,
          body: { cost: rule.minor({ min: 0 }), stock: { type: 'integer', coerce: true, min: 0 }, active: rule.flag(), leadTimeDays: { type: 'integer', coerce: true, min: 0, max: 120 } },
          summary: 'Actualiza costo, stock o disponibilidad de un producto de proveedor.',
          handler: ctx => service().updateProduct(ctx.params.id, ctx.body, ctx),
        },
        {
          method: 'POST', path: '/dropshipping/suppliers/:id/catalog-import', permission: 'supplierProduct:update', tags,
          maxBodyBytes: 900_000,
          body: { csv: { type: 'string', required: true, maxLength: 800_000 }, dryRun: rule.flag({ default: true }) },
          summary: 'Sincroniza costo y stock desde el CSV del proveedor (informe por fila).',
          handler: ctx => service().importCatalog(ctx.params.id, ctx.body, ctx),
        },
        {
          method: 'POST', path: '/dropshipping/supplier-orders/:id/send', permission: 'supplierOrder:update', tags,
          body: { externalReference: rule.text(120) },
          summary: 'Envía el pedido al proveedor mediante su adaptador.',
          handler: ctx => service().send(ctx.params.id, ctx.body, ctx),
        },
        {
          method: 'POST', path: '/dropshipping/supplier-orders/:id/status', permission: 'supplierOrder:update', tags,
          body: {
            status: rule.enumOf(SUPPLIER_ORDER_STATUSES, { required: true }), note: rule.text(300), externalReference: rule.text(120),
            tracking: { type: 'object', shape: { carrier: rule.text(80), trackingNumber: rule.text(120), trackingUrl: rule.url() } },
          },
          summary: 'Registra el avance del pedido del proveedor y lo refleja en el subpedido.',
          handler: ctx => service().transition(ctx.params.id, ctx.body.status, ctx.body, ctx),
        },
        {
          method: 'GET', path: '/dropshipping/summary', permission: 'supplier:read', bodyless: true, tags,
          summary: 'Ventas, costos y margen por proveedor.',
          handler: () => ({ data: service().summary(), count: service().suppliers.repository.count() }),
        },
      ];
    },

    store: container => {
      const service = () => container.resolve('dropshipping');
      const tags = ['dropshipping'];
      return [
        {
          method: 'GET', path: '/dropshipping/portal/:supplierId/orders', permission: null, bodyless: true, tags,
          summary: 'Portal del proveedor: pedidos a despachar.',
          handler: ctx => {
            service().requireMember(ctx, ctx.params.supplierId);
            const data = service().orders.repository.all({ supplierId: ctx.params.supplierId }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
            return { data, count: data.length };
          },
        },
        {
          method: 'POST', path: '/dropshipping/portal/:supplierId/orders/:id/status', permission: null, tags,
          body: {
            status: rule.enumOf(['accepted', 'shipped', 'delivered', 'cancelled'], { required: true }), note: rule.text(300),
            tracking: { type: 'object', shape: { carrier: rule.text(80), trackingNumber: rule.text(120), trackingUrl: rule.url() } },
          },
          summary: 'El proveedor informa aceptación, despacho (con seguimiento) o entrega.',
          handler: ctx => {
            const { actorCtx } = service().requireMember(ctx, ctx.params.supplierId);
            const order = service().orders.repository.byId(ctx.params.id);
            if (!order || order.supplierId !== ctx.params.supplierId) throw new NotFoundError('pedido', ctx.params.id);
            return service().transition(order.id, ctx.body.status, ctx.body, actorCtx);
          },
        },
        {
          method: 'GET', path: '/dropshipping/portal/:supplierId/products', permission: null, bodyless: true, tags,
          summary: 'Portal del proveedor: sus productos, costos y stock.',
          handler: ctx => {
            service().requireMember(ctx, ctx.params.supplierId);
            const catalog = container.resolve('catalog');
            const data = service().products.repository.all({ supplierId: ctx.params.supplierId }).map(row => ({
              ...row, productName: catalog.products.repository.byId(row.productId)?.name || null,
            }));
            return { data, count: data.length };
          },
        },
        {
          method: 'PATCH', path: '/dropshipping/portal/:supplierId/products/:id', permission: null, tags,
          body: { stock: { type: 'integer', coerce: true, min: 0, required: true } },
          summary: 'El proveedor actualiza su stock disponible.',
          handler: ctx => {
            const { actorCtx } = service().requireMember(ctx, ctx.params.supplierId);
            const record = service().products.repository.byId(ctx.params.id);
            if (!record || record.supplierId !== ctx.params.supplierId) throw new NotFoundError('producto', ctx.params.id);
            return service().updateProduct(record.id, { stock: ctx.body.stock }, actorCtx);
          },
        },
      ];
    },
  },
};
