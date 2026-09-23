/**
 * Cuentas de tienda, capacidades y alta de vendedores.
 *
 * Un **cliente** (la cuenta de tienda pública) puede tener varias capacidades a la
 * vez: comprador siempre, vendedor si administra una tienda, proveedor si opera un
 * catálogo de dropshipping. No hay un campo `role` rígido: las capacidades se
 * deducen de las membresías vigentes. El personal de administración y
 * moderación sigue siendo `users` con el RBAC existente.
 */
import { BaseService, defineResource } from '../base.js';
import { rule, validate } from '../../framework/validate.js';
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '../../framework/errors.js';
import { uniqueSlug } from '../../framework/strings.js';
import { now } from '../../framework/dates.js';
import {
  sellerApplicationResource, sellerMemberResource, SELLER_STATUS_LABELS, stockAlertResource,
} from './models.js';

/** Bandeja de notificaciones dentro de la plataforma (comprador, tienda, administración). */
export const inboxResource = defineResource({
  name: 'inboxNotification',
  collection: 'inboxNotifications',
  prefix: 'inbox',
  route: 'inbox',
  softDelete: false,
  searchable: ['title'],
  fields: {
    // `customer`: un cliente concreto; `staff`: la bandeja de administración.
    recipientType: rule.enumOf(['customer', 'staff'], { required: true }),
    recipientId: rule.text(80, { required: true }),
    type: rule.text(60, { required: true }),
    title: rule.text(160, { required: true }),
    body: rule.text(600),
    link: rule.text(300),
    audience: rule.enumOf(['buyer', 'seller', 'supplier', 'admin'], { default: 'buyer' }),
    sellerId: rule.id(),
    readAt: rule.date(),
    data: rule.metadata(),
  },
});

export class InboxService extends BaseService {
  constructor(deps) {
    super(deps, inboxResource);
    this.notifications = deps.notifications;
  }

  /**
   * Notifica y registra. Nunca lanza: una notificación fallida no debe tumbar el
   * pedido o la reseña que la originó.
   */
  async notify({ recipientType = 'customer', recipientId, type, title, body = null, link = null, audience = 'buyer', sellerId = null, data = {}, email = null }) {
    if (!recipientId) return null;
    try {
      const record = await this.store.transaction(state => this.repository.insert(state, {
        recipientType, recipientId: String(recipientId), type, title, body, link, audience, sellerId, data, readAt: null,
      }));
      if (email) {
        await this.notifications?.send({ template: 'marketplace.notice', to: email, entityId: record.id, data: { title, body: body || '', link: link || '/', type } });
      }
      return record;
    } catch {
      return null;
    }
  }

  async notifyStaff({ type, title, body = null, link = null, data = {} }) {
    return this.notify({ recipientType: 'staff', recipientId: 'all', type, title, body, link, audience: 'admin', data });
  }

  forRecipient(recipientType, recipientId, { limit = 50, unreadOnly = false } = {}) {
    return this.repository
      .all({ recipientType, recipientId: String(recipientId) })
      .filter(row => !unreadOnly || !row.readAt)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }

  unreadCount(recipientType, recipientId) {
    return this.repository.all({ recipientType, recipientId: String(recipientId) }).filter(row => !row.readAt).length;
  }

  async markRead(recipientType, recipientId, ids = null) {
    const rows = this.repository.all({ recipientType, recipientId: String(recipientId) })
      .filter(row => !row.readAt && (!ids || ids.includes(row.id)));
    if (!rows.length) return { updated: 0 };
    await this.store.transaction(state => {
      for (const row of rows) this.repository.patch(state, row.id, { readAt: now() });
    });
    return { updated: rows.length };
  }
}

/** Campos que una tienda edita por sí misma. Estado, comisión y plan son de administración. */
export const STORE_PROFILE_FIELDS = {
  name: rule.text(120),
  type: rule.enumOf(['commerce', 'artisan', 'entrepreneur', 'services']),
  tagline: rule.text(160),
  description: rule.text(3000),
  logoUrl: rule.text(500),
  bannerUrl: rule.text(500),
  categoryIds: rule.list({ type: 'string' }, { maxItems: 8 }),
  localityId: rule.id(),
  location: {
    type: 'object',
    shape: {
      area: rule.text(120),
      address: rule.text(200),
      public: rule.flag(),
      lat: { type: 'number', coerce: true, min: -90, max: 90 },
      lng: { type: 'number', coerce: true, min: -180, max: 180 },
    },
  },
  hours: {
    type: 'array',
    maxItems: 7,
    items: {
      type: 'object',
      shape: {
        day: rule.enumOf(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'], { required: true }),
        opens: { type: 'string', pattern: /^([01]\d|2[0-3]):[0-5]\d$/, patternMessage: 'Formato HH:MM.' },
        closes: { type: 'string', pattern: /^([01]\d|2[0-3]):[0-5]\d$/, patternMessage: 'Formato HH:MM.' },
        closed: rule.flag(),
      },
    },
  },
  social: {
    type: 'object',
    shape: {
      instagram: rule.text(80),
      facebook: rule.text(120),
      tiktok: rule.text(80),
      whatsapp: { type: 'string', maxLength: 20, pattern: /^\+?[0-9 ]{6,20}$/, patternMessage: 'Solo dígitos y +.' },
    },
  },
  deliveryModes: rule.list({ type: 'string', enum: ['pickup', 'local_delivery', 'national_shipping'] }),
  businessInfo: rule.text(1000),
  website: rule.url(),
  // Privados: solo los ve la propia tienda y la administración.
  legalName: rule.text(160),
  taxId: rule.text(40),
  contactEmail: rule.email(),
  contactPhone: rule.text(40),
};

export class SellerAccountService {
  constructor({ store, events, audit, settings, channel, customer, inventory, inbox, members, applications, logger }) {
    this.store = store;
    this.events = events;
    this.audit = audit;
    this.settings = settings;
    this.channel = channel;
    this.customer = customer;
    this.inventory = inventory;
    this.inbox = inbox;
    this.members = members;
    this.applications = applications;
    this.logger = logger;
  }

  get sellers() {
    return this.channel.sellers;
  }

  /** Contexto de auditoría para acciones de un cliente (no es personal del panel). */
  static customerContext(ctx, customer) {
    return {
      actor: { id: customer.id, type: 'customer', permissions: new Set() },
      ip: ctx?.ip || null,
      requestId: ctx?.requestId || null,
    };
  }

  requireCustomer(ctx) {
    const customer = this.customer.customers.customerFromRequest(ctx);
    if (!customer) throw new UnauthorizedError('Inicia sesión con tu cuenta para continuar.');
    return customer;
  }

  membershipsFor(customerId) {
    return this.members.repository.all({ customerId, status: 'active' });
  }

  /** Capacidades de la cuenta: nunca un rol fijo, siempre deducidas de datos reales. */
  capabilities(customerId) {
    const capabilities = ['buyer'];
    const stores = this.membershipsFor(customerId)
      .map(member => ({ member, seller: this.sellers.repository.byId(member.sellerId) }))
      .filter(entry => entry.seller);
    if (stores.length) capabilities.push('seller');
    const supplierMemberships = this.store.collection('supplierMembers')
      .filter(row => row.customerId === customerId && row.status === 'active' && !row.deletedAt);
    if (supplierMemberships.length) capabilities.push('supplier');
    const customer = this.customer.customers.repository.byId(customerId);
    if ((customer?.tags || []).includes('afiliado')) capabilities.push('affiliate');
    return {
      capabilities,
      stores: stores.map(({ member, seller }) => ({
        sellerId: seller.id,
        code: seller.code,
        name: seller.name,
        status: seller.status,
        statusLabel: SELLER_STATUS_LABELS[seller.status] || seller.status,
        role: member.role,
      })),
      suppliers: supplierMemberships.map(row => ({ supplierId: row.supplierId, role: row.role })),
    };
  }

  /**
   * Autorización por recurso: la tienda debe existir **y** el cliente debe ser
   * miembro activo. Si no lo es se responde 404, no 403, para no confirmar que la
   * tienda existe a quien no tiene relación con ella.
   */
  requireMember(ctx, sellerId, { roles = ['owner', 'manager', 'staff'] } = {}) {
    const customer = this.requireCustomer(ctx);
    const seller = this.sellers.repository.byId(sellerId);
    const member = seller
      ? this.members.repository.find({ sellerId, customerId: customer.id, status: 'active' })
      : null;
    if (!seller || !member) throw new NotFoundError('tienda', sellerId);
    if (!roles.includes(member.role)) throw new NotFoundError('tienda', sellerId);
    return { customer, seller, member, actorCtx: SellerAccountService.customerContext(ctx, customer) };
  }

  /** Vista privada de la tienda para sus miembros: incluye datos comerciales. */
  privateView(seller) {
    const application = this.applications.repository
      .all({ sellerId: seller.id })
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
    return {
      ...this.sellers.publicView(seller),
      legalName: seller.legalName || null,
      taxId: seller.taxId || null,
      contactEmail: seller.contactEmail || null,
      contactPhone: seller.contactPhone || null,
      location: seller.location || {},
      planId: seller.planId || null,
      statusLabel: SELLER_STATUS_LABELS[seller.status] || seller.status,
      statusReason: seller.statusReason || null,
      termsVersion: seller.termsVersion || null,
      termsAcceptedAt: seller.termsAcceptedAt || null,
      application: application && {
        id: application.id,
        status: application.status,
        submittedAt: application.submittedAt,
        reviewedAt: application.reviewedAt,
        decisionNote: application.decisionNote,
      },
      checklist: this.checklist(seller),
    };
  }

  /** Qué le falta a una tienda para poder enviarse a revisión. */
  checklist(seller) {
    const items = [
      { key: 'name', label: 'Nombre de la tienda', ok: Boolean(seller.name && seller.name.length >= 3) },
      { key: 'description', label: 'Descripción (mínimo 40 caracteres)', ok: Boolean(seller.description && seller.description.length >= 40) },
      { key: 'category', label: 'Al menos una categoría', ok: (seller.categoryIds || []).length > 0 },
      { key: 'locality', label: 'Localidad', ok: Boolean(seller.localityId) },
      { key: 'area', label: 'Zona general', ok: Boolean(seller.location?.area) },
      { key: 'contact', label: 'Teléfono de contacto', ok: Boolean(seller.contactPhone || seller.social?.whatsapp) },
      { key: 'delivery', label: 'Al menos un modo de entrega', ok: (seller.deliveryModes || []).length > 0 },
    ];
    return { items, complete: items.every(item => item.ok) };
  }

  sanitizeProfile(input, { partial = true } = {}) {
    return validate(input, STORE_PROFILE_FIELDS, { partial });
  }

  assertLocality(localityId) {
    if (!localityId) return;
    const locality = this.store.collection('localities').find(row => row.id === localityId && !row.deletedAt);
    if (!locality) throw ValidationError.single('localityId', 'La localidad no existe.');
    if (locality.launchStatus === 'hidden') throw ValidationError.single('localityId', 'La localidad no está habilitada.');
  }

  assertCategories(categoryIds = []) {
    const known = new Set(this.store.collection('categories').filter(row => !row.deletedAt).map(row => row.id));
    const unknown = categoryIds.filter(id => !known.has(id));
    if (unknown.length) throw ValidationError.single('categoryIds', `Categorías desconocidas: ${unknown.join(', ')}.`);
  }

  /** Paso «Crear tienda»: la tienda nace pendiente y con su solicitud en borrador. */
  async createStore(ctx, input) {
    const customer = this.requireCustomer(ctx);
    const owned = this.membershipsFor(customer.id).filter(member => member.role === 'owner');
    if (owned.length >= 3) throw new ConflictError('Una cuenta puede administrar hasta tres tiendas.');
    const profile = this.sanitizeProfile(input, { partial: true });
    if (!profile.name) throw ValidationError.single('name', 'Indica el nombre de la tienda.');
    this.assertLocality(profile.localityId);
    this.assertCategories(profile.categoryIds);
    const actorCtx = SellerAccountService.customerContext(ctx, customer);
    const taken = new Set(this.sellers.repository.all({}, { withDeleted: true }).map(row => row.code));
    const code = uniqueSlug(profile.name, taken, { maxLength: 60, fallback: 'tienda' });
    const defaultLocality = this.settings.get('marketplace.defaultLocalityId', null);

    const seller = await this.sellers.create({
      ...profile,
      code,
      status: 'pending',
      localityId: profile.localityId || defaultLocality || null,
      payoutCurrency: this.settings.get('marketplace.currencyCode', 'PYG'),
      contactEmail: profile.contactEmail || customer.email,
      ownerCustomerId: customer.id,
    }, actorCtx);
    await this.members.create({ sellerId: seller.id, customerId: customer.id, role: 'owner', status: 'active' }, actorCtx);
    await this.applications.create({ sellerId: seller.id, customerId: customer.id, status: 'draft' }, actorCtx);
    return this.privateView(this.sellers.repository.retrieve(seller.id));
  }

  async updateProfile(ctx, sellerId, input) {
    const { seller, actorCtx } = this.requireMember(ctx, sellerId, { roles: ['owner', 'manager'] });
    const changes = this.sanitizeProfile(input, { partial: true });
    if (changes.localityId) this.assertLocality(changes.localityId);
    if (changes.categoryIds) this.assertCategories(changes.categoryIds);
    if (changes.location) changes.location = { ...(seller.location || {}), ...changes.location };
    if (changes.social) changes.social = { ...(seller.social || {}), ...changes.social };
    if (!Object.keys(changes).length) throw ValidationError.single('body', 'Envía al menos un campo para actualizar.');
    await this.sellers.update(sellerId, changes, actorCtx);
    return this.privateView(this.sellers.repository.retrieve(sellerId));
  }

  /** Paso «Aceptar términos» + «Enviar solicitud». */
  async submit(ctx, sellerId, { acceptTerms }) {
    const { seller, customer, actorCtx } = this.requireMember(ctx, sellerId, { roles: ['owner'] });
    if (acceptTerms !== true) throw ValidationError.single('acceptTerms', 'Debes aceptar los términos para vendedores.');
    if (seller.status === 'active') throw new ConflictError('La tienda ya está aprobada.');
    if (seller.status === 'suspended') throw new ConflictError('La tienda está suspendida; contacta con la administración.');
    const { complete, items } = this.checklist(seller);
    if (!complete) {
      throw new ValidationError(items.filter(item => !item.ok).map(item => ({ field: item.key, message: `Falta: ${item.label}.` })));
    }
    const termsVersion = this.settings.get('marketplace.sellerTermsVersion', '2026-09');
    const application = this.applications.repository
      .all({ sellerId })
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    const payload = { status: 'pending', termsVersion, termsAcceptedAt: now(), submittedAt: now(), checklist: { items } };
    const record = application && ['draft', 'rejected'].includes(application.status)
      ? await this.applications.update(application.id, payload, actorCtx)
      : await this.applications.create({ sellerId, customerId: customer.id, ...payload }, actorCtx);
    await this.sellers.update(sellerId, { status: 'pending', termsVersion, termsAcceptedAt: now(), statusReason: null }, actorCtx);

    if (!this.settings.get('marketplace.sellerApprovalRequired', true)) {
      return this.decide(record.id, { decision: 'approve', note: 'Aprobación automática por configuración.' }, null);
    }
    await this.inbox.notifyStaff({
      type: 'seller_application',
      title: `Nueva solicitud de tienda: ${seller.name}`,
      body: 'Revisa la solicitud en la bandeja de vendedores.',
      link: `/admin/vendedores?solicitud=${record.id}`,
      data: { sellerId, applicationId: record.id },
    });
    return this.privateView(this.sellers.repository.retrieve(sellerId));
  }

  /** Revisión administrativa de una solicitud. */
  async decide(applicationId, { decision, note = null }, ctx = null) {
    const application = this.applications.repository.retrieve(applicationId);
    if (application.status !== 'pending') {
      throw new ConflictError(`La solicitud está en estado "${application.status}" y no admite revisión.`);
    }
    if (!['approve', 'reject'].includes(decision)) throw ValidationError.single('decision', 'Decisión no válida.');
    if (decision === 'reject' && !note) throw ValidationError.single('note', 'Indica el motivo del rechazo.');
    const approved = decision === 'approve';
    await this.applications.update(applicationId, {
      status: approved ? 'approved' : 'rejected',
      reviewedAt: now(),
      reviewerId: ctx?.actor?.id || null,
      decisionNote: note,
    }, ctx);
    const seller = await this.sellers.update(application.sellerId, {
      status: approved ? 'active' : 'rejected',
      approvedAt: approved ? now() : null,
      statusReason: approved ? null : note,
    }, ctx);
    if (approved) await this.ensureStockLocation(seller, ctx);
    await this.events.emit(approved ? 'marketplace.seller.approved' : 'marketplace.seller.rejected', { sellerId: seller.id });
    await this.notifyOwners(seller, {
      type: approved ? 'store_approved' : 'store_rejected',
      title: approved ? `¡Tu tienda ${seller.name} fue aprobada!` : `Tu solicitud para ${seller.name} fue rechazada`,
      body: approved ? 'Ya puedes publicar productos.' : `Motivo: ${note}. Puedes corregir y volver a enviarla.`,
      link: `/mi-tienda/${seller.id}`,
    });
    return this.privateView(this.sellers.repository.retrieve(seller.id));
  }

  /** Suspensión y reactivación: los productos de una tienda suspendida dejan de mostrarse. */
  async setStatus(sellerId, { status, reason = null }, ctx = null) {
    const seller = this.sellers.repository.retrieve(sellerId);
    const allowed = { suspend: 'suspended', reactivate: 'active' };
    const target = allowed[status];
    if (!target) throw ValidationError.single('status', 'Acción no válida.');
    if (target === 'suspended' && !reason) throw ValidationError.single('reason', 'Indica el motivo de la suspensión.');
    if (target === 'active' && !['suspended'].includes(seller.status)) {
      throw new ConflictError('Solo se puede reactivar una tienda suspendida.');
    }
    const updated = await this.sellers.update(sellerId, { status: target, statusReason: reason }, ctx);
    await this.events.emit(`marketplace.seller.${target === 'active' ? 'reactivated' : 'suspended'}`, { sellerId });
    await this.notifyOwners(updated, {
      type: target === 'active' ? 'store_reactivated' : 'store_suspended',
      title: target === 'active' ? `Tu tienda ${updated.name} fue reactivada` : `Tu tienda ${updated.name} fue suspendida`,
      body: reason,
      link: `/mi-tienda/${updated.id}`,
    });
    return this.privateView(this.sellers.repository.retrieve(sellerId));
  }

  /** Cada tienda aprobada tiene su propia ubicación de stock. */
  async ensureStockLocation(seller, ctx = null) {
    const code = `tienda-${seller.code}`.slice(0, 110);
    const existing = this.inventory.locations.repository.find({ code });
    if (existing) return existing;
    return this.inventory.locations.create({
      code,
      name: `Stock de ${seller.name}`.slice(0, 120),
      type: 'store',
      priority: 50,
      allowsPickup: (seller.deliveryModes || []).includes('pickup'),
      active: true,
      metadata: { sellerId: seller.id },
    }, ctx);
  }

  stockLocationFor(sellerId) {
    return this.inventory.locations.repository.all().find(location => location.metadata?.sellerId === sellerId) || null;
  }

  /** Notifica a todos los miembros activos de una tienda. */
  async notifyOwners(seller, { type, title, body = null, link = null, data = {} }) {
    for (const member of this.members.repository.all({ sellerId: seller.id, status: 'active' })) {
      const customer = this.customer.customers.repository.byId(member.customerId);
      await this.inbox.notify({
        recipientType: 'customer', recipientId: member.customerId, type, title, body, link,
        audience: 'seller', sellerId: seller.id, data, email: customer?.email || null,
      });
    }
  }

  /** Alta de un miembro adicional (encargado o colaborador) por la dueña de la tienda. */
  async addMember(ctx, sellerId, { email, role = 'staff' }) {
    const { actorCtx } = this.requireMember(ctx, sellerId, { roles: ['owner'] });
    const target = this.customer.customers.byEmail(email);
    if (!target?.hasAccount) throw new NotFoundError('cuenta', email);
    const existing = this.members.repository.find({ sellerId, customerId: target.id });
    if (existing?.status === 'active') throw new ConflictError('Esa cuenta ya es miembro de la tienda.');
    if (!['manager', 'staff'].includes(role)) throw ValidationError.single('role', 'Rol no válido.');
    if (existing) return this.members.update(existing.id, { status: 'active', role }, actorCtx);
    return this.members.create({ sellerId, customerId: target.id, role, status: 'active' }, actorCtx);
  }
}

export { sellerApplicationResource, sellerMemberResource };

/**
 * Avisos de reposición.
 *
 * Cuando alguien quiere algo que está agotado, la venta no está perdida: está
 * aplazada. Se guarda quién lo pidió y se avisa en cuanto vuelve, una sola vez
 * y solo si el producto realmente tiene stock otra vez.
 */
export class StockAlertService extends BaseService {
  constructor(deps) {
    super(deps, stockAlertResource);
    this.catalog = deps.catalog;
    this.inventory = deps.inventory;
    this.notifications = deps.notifications;
  }

  /** Alta idempotente: pedirlo dos veces no genera dos avisos. */
  async request({ productId, variantId = null, email, customerId = null }, ctx = null) {
    const product = this.catalog.products.repository.retrieve(productId);
    const existing = this.repository.all({ status: 'pending' })
      .find(row => row.productId === productId && row.email === email && (row.variantId || null) === (variantId || null));
    if (existing) return existing;
    return this.create({ productId, variantId, email, customerId, metadata: { productName: product.name } }, ctx);
  }

  /** ¿Volvió a haber stock de esta variante? */
  hasStock(variantId) {
    try {
      return this.inventory.service.publicAvailability(variantId).hasStock;
    } catch {
      return false;
    }
  }

  /**
   * Avisa a quien esperaba por las variantes indicadas. Devuelve cuántos avisos
   * salieron, para que la operación pueda medirlo.
   */
  async notifyRestocked(variantIds = []) {
    const targets = new Set(variantIds.filter(Boolean));
    if (!targets.size) return { notified: 0 };
    const pending = this.repository.all({ status: 'pending' });
    let notified = 0;
    for (const alert of pending) {
      const variants = alert.variantId
        ? [alert.variantId]
        : this.catalog.variants.forProduct(alert.productId).map(variant => variant.id);
      if (!variants.some(id => targets.has(id))) continue;
      if (!variants.some(id => this.hasStock(id))) continue;
      const product = this.catalog.products.repository.byId(alert.productId);
      if (!product || product.status !== 'published') continue;
      await this.notifications?.send({
        template: 'stock.back',
        to: alert.email,
        entityId: alert.productId,
        data: { product: product.name, link: `/producto/${product.handle}` },
      });
      await this.update(alert.id, { status: 'notified', notifiedAt: now() });
      notified += 1;
    }
    return { notified };
  }
}
