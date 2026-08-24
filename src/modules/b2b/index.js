/** Organizaciones B2B, miembros y circuito de aprobación de compras. */
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule } from '../../framework/validate.js';
import { ConflictError, NotFoundError, UnauthorizedError } from '../../framework/errors.js';
import { now } from '../../framework/dates.js';

export const companyResource = defineResource({
  name: 'b2bCompany', collection: 'b2bCompanies', prefix: 'b2b', route: 'b2b-companies', unique: ['handle'], searchable: ['name', 'handle'],
  fields: {
    name: rule.text(160, { required: true }), handle: rule.handle({ required: true }), taxId: rule.text(60),
    currencyCode: rule.currency({ required: true }), creditLimit: rule.minor({ default: 0 }), paymentTermsDays: rule.quantity({ default: 0, max: 365 }),
    approvalThreshold: rule.minor({ default: 0 }), status: rule.enumOf(['active', 'suspended'], { default: 'active' }), metadata: rule.metadata(),
  },
});
export const memberResource = defineResource({
  name: 'b2bMember', collection: 'b2bMembers', prefix: 'b2bm', route: 'b2b-members', searchable: ['companyId', 'customerId'],
  fields: { companyId: rule.id({ required: true }), customerId: rule.id({ required: true }), role: rule.enumOf(['owner', 'admin', 'buyer', 'approver'], { default: 'buyer' }), monthlySpendLimit: rule.minor({ default: 0 }), active: rule.flag({ default: true }), metadata: rule.metadata() },
});
export const purchaseOrderResource = defineResource({
  name: 'purchaseOrder', collection: 'purchaseOrders', prefix: 'po', route: 'purchase-orders', unique: ['number'], searchable: ['number', 'companyId', 'customerId'],
  fields: {
    number: rule.text(40), companyId: rule.id({ required: true }), customerId: rule.id({ required: true }), cartId: rule.id(), orderId: rule.id(),
    currencyCode: rule.currency({ required: true }), amount: rule.minor({ required: true }), status: rule.enumOf(['pending_approval', 'approved', 'rejected', 'ordered', 'cancelled'], { default: 'pending_approval' }),
    requestedAt: rule.date(), approvedAt: rule.date(), approvedBy: rule.id(), rejectionReason: rule.text(400), metadata: rule.metadata(),
  },
});

class B2bService {
  constructor(deps) { this.store = deps.store; this.customers = deps.customer.customers; this.companies = new BaseService(deps, companyResource); this.members = new BaseService(deps, memberResource); this.purchaseOrders = new BaseService(deps, purchaseOrderResource); }
  member(companyId, customerId) { return this.members.repository.find({ companyId, customerId, active: true }); }
  memberships(customerId) { return this.members.repository.all({ customerId, active: true }).map(member => ({ ...member, company: this.companies.repository.byId(member.companyId) })).filter(row => row.company?.status === 'active'); }
  assertRole(companyId, customerId, roles) { const member = this.member(companyId, customerId); if (!member || !roles.includes(member.role)) throw new UnauthorizedError('No tienes permiso en esta organización.'); return member; }
  async createCompany(input, customerId, ctx) {
    const company = await this.companies.create(input, ctx);
    await this.members.create({ companyId: company.id, customerId, role: 'owner', active: true, monthlySpendLimit: 0 }, ctx);
    return company;
  }
  nextNumber() { return `PO-${new Date().getUTCFullYear()}-${String(this.purchaseOrders.repository.count() + 1).padStart(6, '0')}`; }
  async requestPurchaseOrder({ companyId, cart, customerId }, ctx) {
    const member = this.assertRole(companyId, customerId, ['owner', 'admin', 'buyer', 'approver']);
    const company = this.companies.repository.retrieve(companyId);
    if (company.status !== 'active') throw new ConflictError('La organización está suspendida.');
    if (cart.currencyCode !== company.currencyCode) throw new ConflictError('La moneda del carrito no coincide con la organización.');
    if (cart.customerId !== customerId) throw new UnauthorizedError('El carrito no pertenece al cliente.');
    const existing = this.purchaseOrders.repository.find({ cartId: cart.id, companyId });
    if (existing && !['rejected', 'cancelled'].includes(existing.status)) return existing;
    const requiresApproval = company.approvalThreshold > 0 && cart.total >= company.approvalThreshold && !['owner', 'admin', 'approver'].includes(member.role);
    return this.purchaseOrders.create({ number: this.nextNumber(), companyId, customerId, cartId: cart.id, currencyCode: cart.currencyCode, amount: cart.total, status: requiresApproval ? 'pending_approval' : 'approved', requestedAt: now(), approvedAt: requiresApproval ? null : now(), approvedBy: requiresApproval ? null : customerId, metadata: {} }, ctx);
  }
  async decide(id, customerId, { approve, reason }, ctx) {
    const po = this.purchaseOrders.repository.retrieve(id); this.assertRole(po.companyId, customerId, ['owner', 'admin', 'approver']);
    if (po.status !== 'pending_approval') throw new ConflictError('La solicitud ya fue decidida.');
    return this.purchaseOrders.update(id, approve ? { status: 'approved', approvedAt: now(), approvedBy: customerId } : { status: 'rejected', rejectionReason: reason || 'Rechazada', approvedBy: customerId }, ctx);
  }
  assertCheckout(cart, customerId) {
    const requests = this.purchaseOrders.repository.all({ cartId: cart.id, customerId });
    if (!requests.length) return null;
    const po = requests.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (po.status !== 'approved') throw new ConflictError('La orden de compra B2B necesita aprobación antes del checkout.', { purchaseOrderId: po.id, status: po.status });
    return po;
  }
  async attachOrder(order) {
    if (!order?.cartId) return null;
    const po = this.purchaseOrders.repository.find({ cartId: order.cartId, status: 'approved' });
    return po ? this.purchaseOrders.update(po.id, { status: 'ordered', orderId: order.id }) : null;
  }
}

export default {
  name: 'b2b', requires: ['store', 'events', 'audit', 'config', 'customFields', 'customer'], resources: [companyResource, memberResource, purchaseOrderResource],
  permissions: [{ resource: 'b2bCompany', description: 'Organizaciones B2B.' }, { resource: 'b2bMember', description: 'Miembros B2B.' }, { resource: 'purchaseOrder', description: 'Órdenes de compra B2B.' }],
  register(deps) { const service = new B2bService(deps); return { service, companies: service.companies, members: service.members, purchaseOrders: service.purchaseOrders }; },
  subscribers: container => [{ event: 'order.created', handler: ({ record }) => container.resolve('b2b').service.attachOrder(record) }],
  routes: {
    admin: container => { const m = () => container.resolve('b2b'); return [...crudRoutes(companyResource, () => m().companies, { tags: ['B2B'] }), ...crudRoutes(memberResource, () => m().members, { tags: ['B2B'] }), ...crudRoutes(purchaseOrderResource, () => m().purchaseOrders, { tags: ['B2B'] })]; },
    store: container => { const m = () => container.resolve('b2b'); const customer = ctx => container.resolve('customer').customers.customerFromRequest(ctx); return [
      { method: 'GET', path: '/b2b/me', permission: null, bodyless: true, summary: 'Organizaciones B2B del cliente.', tags: ['B2B'], handler: ctx => { const actor = customer(ctx); if (!actor) throw new UnauthorizedError('Inicia sesión para continuar.'); return { data: m().service.memberships(actor.id) }; } },
      { method: 'POST', path: '/b2b/companies', permission: null, summary: 'Crea una organización B2B y asigna al creador como propietario.', tags: ['B2B'], status: 201, body: companyResource.fields, handler: ctx => { const actor = customer(ctx); if (!actor) throw new UnauthorizedError('Inicia sesión para continuar.'); return m().service.createCompany(ctx.body, actor.id, ctx); } },
      { method: 'POST', path: '/b2b/purchase-orders', permission: null, summary: 'Solicita aprobación de compra para un carrito B2B.', tags: ['B2B'], status: 201, body: { companyId: rule.id({ required: true }), cartId: rule.id({ required: true }) }, handler: ctx => { const actor = customer(ctx); if (!actor) throw new UnauthorizedError('Inicia sesión para continuar.'); const cart = container.resolve('cart').repository.retrieve(ctx.body.cartId); return m().service.requestPurchaseOrder({ companyId: ctx.body.companyId, cart, customerId: actor.id }, ctx); } },
      { method: 'POST', path: '/b2b/purchase-orders/:id/decision', permission: null, summary: 'Aprueba o rechaza una orden de compra B2B.', tags: ['B2B'], body: { approve: rule.flag({ required: true }), reason: rule.text(400) }, handler: ctx => { const actor = customer(ctx); if (!actor) throw new UnauthorizedError('Inicia sesión para continuar.'); return m().service.decide(ctx.params.id, actor.id, ctx.body, ctx); } },
    ]; },
  },
};
