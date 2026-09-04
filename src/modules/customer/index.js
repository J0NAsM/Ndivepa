/**
 * Clientes, grupos y direcciones (M-0264 … M-0276).
 *
 * Un cliente puede ser invitado o registrado; al registrarse conserva su historial
 * (M-0265). La anonimización borra los datos personales **sin** romper la integridad
 * del pedido, porque un pedido sin líneas ni totales no se puede auditar (M-0275).
 */
import { randomUUID } from 'node:crypto';
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule, validate } from '../../framework/validate.js';
import { ConflictError, UnauthorizedError, ValidationError } from '../../framework/errors.js';
import { hashPassword, verifyPassword, assertPasswordPolicy } from '../access/index.js';
import { token as generateToken, id as generateId } from '../../framework/ids.js';
import { safeEqual } from '../../framework/strings.js';
import { now, plusMinutes, toDate } from '../../framework/dates.js';
import { issueCsrfToken } from '../../framework/http/middlewares.js';

export const customerGroupResource = defineResource({
  name: 'customerGroup',
  collection: 'customerGroups',
  prefix: 'cgroup',
  route: 'customer-groups',
  unique: ['code'],
  searchable: ['name', 'code'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(100, { required: true }),
    description: rule.text(300),
    // Un grupo puede ser automático: se evalúa por reglas al vuelo.
    automatic: rule.flag({ default: false }),
    rules: {
      type: 'object',
      shape: {
        minOrders: { type: 'integer', coerce: true, min: 0 },
        minSpend: rule.minor(),
        countryCodes: rule.list({ type: 'string' }),
        tags: rule.list({ type: 'string' }),
      },
    },
    taxExempt: rule.flag({ default: false }),
    priority: { type: 'integer', coerce: true, min: 0, max: 1000, default: 100 },
    metadata: rule.metadata(),
  },
});

export const addressResource = defineResource({
  name: 'address',
  collection: 'addresses',
  prefix: 'addr',
  route: 'addresses',
  searchable: ['firstName', 'lastName', 'city', 'company'],
  fields: {
    customerId: rule.id(),
    label: rule.text(60),
    firstName: rule.text(80),
    lastName: rule.text(80),
    company: rule.text(120),
    address1: rule.text(200),
    address2: rule.text(200),
    city: rule.text(100),
    provinceId: rule.id(),
    province: rule.text(100),
    postalCode: rule.text(20),
    countryCode: rule.country(),
    phone: rule.text(40),
    isDefaultShipping: rule.flag({ default: false }),
    isDefaultBilling: rule.flag({ default: false }),
    instructions: rule.text(300),
    metadata: rule.metadata(),
  },
});

export const customerResource = defineResource({
  name: 'customer',
  collection: 'customers',
  prefix: 'cus',
  route: 'customers',
  unique: ['email'],
  searchable: ['email', 'firstName', 'lastName', 'phone', 'company'],
  fields: {
    email: rule.email({ required: true }),
    firstName: rule.text(80),
    lastName: rule.text(80),
    company: rule.text(120),
    phone: rule.text(40),
    taxId: rule.text(40),
    taxExempt: rule.flag({ default: false }),
    hasAccount: rule.flag({ default: false }),
    groupIds: rule.list({ type: 'string' }, { default: [] }),
    tags: rule.list({ type: 'string' }, { default: [] }),
    locale: rule.text(10, { default: 'es' }),
    preferredCurrency: rule.currency(),
    consent: {
      type: 'object',
      shape: {
        marketing: rule.flag({ default: false }),
        analytics: rule.flag({ default: false }),
        updatedAt: rule.date(),
      },
    },
    status: rule.enumOf(['active', 'blocked', 'anonymized'], { default: 'active' }),
    notes: rule.text(2000),
    metadata: rule.metadata(),
  },
});

/** Sesiones opacas: la cookie nunca contiene ni expone el ID del cliente. */
export const customerSessionResource = defineResource({
  name: 'customerSession',
  collection: 'customerSessions',
  prefix: 'csess',
  route: 'customer-sessions',
  softDelete: false,
  unique: ['token'],
  searchable: ['customerId'],
  fields: {
    customerId: rule.id({ required: true }),
    token: rule.text(160, { required: true }),
    expiresAt: rule.date({ required: true }),
    lastSeenAt: rule.date(),
  },
});

export class CustomerGroupService extends BaseService {
  constructor(deps) {
    super(deps, customerGroupResource);
  }

  byCode(code) {
    return this.repository.find({ code });
  }

  /** Grupos manuales asignados más los automáticos que cumple el cliente. */
  resolveFor(customer, metrics) {
    const manual = customer?.groupIds || [];
    const automatic = this.repository
      .all({ automatic: true })
      .filter(group => this.matches(group, customer, metrics))
      .map(group => group.id);
    return [...new Set([...manual, ...automatic])];
  }

  matches(group, customer, metrics = {}) {
    const rules = group.rules || {};
    if (rules.minOrders && (metrics.orders || 0) < rules.minOrders) return false;
    if (rules.minSpend && (metrics.spend || 0) < rules.minSpend) return false;
    if (rules.countryCodes?.length && !rules.countryCodes.includes(metrics.countryCode)) return false;
    if (rules.tags?.length && !rules.tags.some(tag => (customer?.tags || []).includes(tag))) return false;
    return true;
  }
}

export class AddressService extends BaseService {
  constructor(deps) {
    super(deps, addressResource);
    this.geography = deps.geography;
  }

  /** Valida los campos que el país exige (M-0268). */
  assertComplete(address) {
    const { required, postalCodePattern } = this.geography.countries.addressRequirements(address.countryCode);
    const issues = [];
    for (const field of required) {
      if (!address[field]) issues.push({ field, message: 'Este campo es obligatorio para el país indicado.' });
    }
    if (postalCodePattern && address.postalCode && !new RegExp(postalCodePattern).test(address.postalCode)) {
      issues.push({ field: 'postalCode', message: 'El código postal no tiene el formato esperado para ese país.' });
    }
    if (issues.length) throw new ValidationError(issues);
    return true;
  }

  async beforeCreate(data) {
    if (data.countryCode) this.assertComplete(data);
    return data;
  }

  async afterCreate(record) {
    await this.enforceSingleDefault(record);
  }

  async afterUpdate(_before, after) {
    await this.enforceSingleDefault(after);
  }

  /** Solo puede haber una dirección predeterminada de cada tipo por cliente. */
  async enforceSingleDefault(address) {
    if (!address.customerId) return;
    if (!address.isDefaultShipping && !address.isDefaultBilling) return;
    const siblings = this.repository.all({ customerId: address.customerId }).filter(row => row.id !== address.id);
    const updates = siblings.filter(
      row => (address.isDefaultShipping && row.isDefaultShipping) || (address.isDefaultBilling && row.isDefaultBilling),
    );
    if (!updates.length) return;
    await this.store.transaction(state => {
      for (const row of updates) {
        this.repository.patch(state, row.id, {
          isDefaultShipping: address.isDefaultShipping ? false : row.isDefaultShipping,
          isDefaultBilling: address.isDefaultBilling ? false : row.isDefaultBilling,
        });
      }
    });
  }

  forCustomer(customerId) {
    return this.repository.all({ customerId });
  }
}

export class CustomerService extends BaseService {
  constructor(deps) {
    super(deps, customerResource);
    this.groups = deps.groups;
    this.addresses = deps.addresses;
    this.config = deps.config;
    this.notifications = deps.notifications;
    this.sessions = deps.sessions;
  }

  async createSession(customerId) {
    const token = generateToken(32);
    return this.sessions.create({
      customerId,
      token,
      expiresAt: plusMinutes(now(), 30 * 24 * 60),
      lastSeenAt: now(),
    });
  }

  customerFromSession(token) {
    if (!token) return null;
    const session = this.sessions.repository.find({ token });
    if (!session || (toDate(session.expiresAt)?.getTime() ?? 0) <= Date.now()) return null;
    const customer = this.repository.byId(session.customerId);
    return customer?.hasAccount && customer.status === 'active' ? customer : null;
  }

  customerFromRequest(ctx) {
    return this.customerFromSession(ctx.cookies[ctx.config.session.customerCookieName]);
  }

  async revokeSession(token) {
    const session = this.sessions.repository.find({ token });
    if (session) await this.store.transaction(state => this.sessions.repository.remove(state, session.id));
  }

  publicView(customer) {
    if (!customer) return null;
    return {
      id: customer.id,
      email: customer.email,
      firstName: customer.firstName || null,
      lastName: customer.lastName || null,
      company: customer.company || null,
      phone: customer.phone || null,
      hasAccount: Boolean(customer.hasAccount),
      groupIds: customer.groupIds || [],
      locale: customer.locale || 'es',
      consent: customer.consent || { marketing: false, analytics: false },
      createdAt: customer.createdAt,
    };
  }

  byEmail(email) {
    const normalized = String(email || '').trim().toLowerCase();
    return this.store.collection('customers').find(row => String(row.email || '').toLowerCase() === normalized) || null;
  }

  /** Métricas por cliente calculadas desde los pedidos (M-0272). */
  metrics(customerId) {
    const orders = this.store.collection('orders').filter(
      order => order.customerId === customerId && !['draft', 'cancelled'].includes(order.status),
    );
    const spend = orders.reduce((sum, order) => sum + Number(order.total || 0), 0);
    const dates = orders.map(order => order.placedAt || order.createdAt).filter(Boolean).sort();
    return {
      orders: orders.length,
      spend,
      averageOrder: orders.length ? Math.round(spend / orders.length) : 0,
      firstOrderAt: dates[0] || null,
      lastOrderAt: dates.at(-1) || null,
      currency: orders[0]?.currencyCode || null,
    };
  }

  /** Grupos efectivos, incluidos los automáticos. */
  groupsFor(customerId) {
    const customer = this.repository.byId(customerId);
    if (!customer) return [];
    return this.groups.resolveFor(customer, this.metrics(customerId));
  }

  /** Cliente invitado: existe para poder atribuir un pedido sin exigir cuenta. */
  async ensureGuest({ email, firstName = null, lastName = null, locale = 'es' }, ctx = null) {
    const existing = this.byEmail(email);
    if (existing) return existing;
    return this.create({ email, firstName, lastName, locale, hasAccount: false }, ctx);
  }

  /** Registro con contraseña. Si ya existía como invitado, se conserva el historial. */
  async register({ email, password, firstName = null, lastName = null, locale = 'es' }, ctx = null) {
    assertPasswordPolicy(password, { minLength: this.config.security.passwordMinLength });
    const existing = this.byEmail(email);
    if (existing?.hasAccount) throw new ConflictError('Ya existe una cuenta con ese correo.');
    const salt = randomUUID();
    const credentials = {
      salt,
      passwordHash: hashPassword(password, salt),
      hasAccount: true,
      verifiedAt: null,
      verificationToken: generateToken(24),
    };

    const customer = existing
      ? (await this.store.transaction(state => this.repository.patch(state, existing.id, {
        ...credentials,
        firstName: firstName || existing.firstName,
        lastName: lastName || existing.lastName,
      }))).after
      : await this.store.transaction(state => this.repository.insert(state, {
        ...customerResource.defaults,
        email: String(email).toLowerCase(),
        firstName,
        lastName,
        locale,
        groupIds: [],
        tags: [],
        status: 'active',
        consent: { marketing: false, analytics: false, updatedAt: now() },
        ...credentials,
      }));

    await this.emit('registered', this.publicView(customer), ctx);
    await this.notifications?.send({
      template: 'customer.verify',
      to: customer.email,
      entityId: customer.id,
      data: { token: credentials.verificationToken },
    });
    return this.publicView(customer);
  }

  async authenticate({ email, password }) {
    const customer = this.byEmail(email);
    const invalid = new UnauthorizedError('Correo o contraseña incorrectos.');
    if (!customer?.hasAccount || !password) throw invalid;
    if (customer.status !== 'active') throw new UnauthorizedError('La cuenta no está disponible.');
    if (!verifyPassword(password, customer.salt, customer.passwordHash)) throw invalid;
    return customer;
  }

  async requestPasswordReset(email) {
    const customer = this.byEmail(email);
    // Respuesta idéntica exista o no la cuenta: no se filtra qué correos hay.
    if (!customer?.hasAccount) return { requested: true };
    const resetToken = generateToken(24);
    await this.store.transaction(state => this.repository.patch(state, customer.id, {
      resetToken,
      resetExpiresAt: plusMinutes(now(), 60),
    }));
    await this.notifications?.send({
      template: 'customer.reset',
      to: customer.email,
      entityId: customer.id,
      data: { token: resetToken },
    });
    return { requested: true };
  }

  async resetPassword({ token: presented, password }) {
    assertPasswordPolicy(password, { minLength: this.config.security.passwordMinLength });
    const customer = this.repository.all({ hasAccount: true }).find(row => row.resetToken && safeEqual(row.resetToken, presented));
    if (!customer) throw new UnauthorizedError('El código de restablecimiento no es válido.');
    if ((toDate(customer.resetExpiresAt)?.getTime() ?? 0) < Date.now()) {
      throw new UnauthorizedError('El código de restablecimiento ha caducado.');
    }
    const salt = randomUUID();
    await this.store.transaction(state => this.repository.patch(state, customer.id, {
      salt,
      passwordHash: hashPassword(password, salt),
      resetToken: null,
      resetExpiresAt: null,
      passwordChangedAt: now(),
    }));
    return { message: 'Contraseña actualizada.' };
  }

  async verifyEmail(presented) {
    const customer = this.repository.all().find(row => row.verificationToken && safeEqual(row.verificationToken, presented));
    if (!customer) throw new UnauthorizedError('El código de verificación no es válido.');
    await this.store.transaction(state => this.repository.patch(state, customer.id, {
      verifiedAt: now(),
      verificationToken: null,
    }));
    return { verified: true };
  }

  async setConsent(customerId, consent, ctx = null) {
    const value = validate(consent, { marketing: rule.flag(), analytics: rule.flag() }, { partial: true });
    const result = await this.store.transaction(state => this.repository.patch(state, customerId, {
      consent: { ...(this.repository.byId(customerId)?.consent || {}), ...value, updatedAt: now() },
    }));
    await this.emit('consent_updated', result.after, ctx);
    return result.after.consent;
  }

  /** Exportación de datos del cliente (M-0274). */
  exportData(customerId) {
    const customer = this.repository.retrieve(customerId);
    const { passwordHash: _hash, salt: _salt, resetToken: _reset, verificationToken: _verify, ...profile } = customer;
    return {
      exportedAt: now(),
      profile,
      addresses: this.addresses.forCustomer(customerId),
      orders: this.store.collection('orders')
        .filter(order => order.customerId === customerId)
        .map(order => ({
          id: order.id,
          code: order.code,
          status: order.status,
          total: order.total,
          currencyCode: order.currencyCode,
          placedAt: order.placedAt,
          items: (order.items || []).map(item => ({ title: item.title, quantity: item.quantity, total: item.total })),
        })),
      history: this.store.collection('historyEntries').filter(entry => entry.customerId === customerId),
    };
  }

  /**
   * Anonimización (M-0275). Se sustituyen los datos personales por marcadores y se
   * conservan los importes: sin ellos la contabilidad del pedido deja de cuadrar.
   */
  async anonymize(customerId, ctx = null) {
    const customer = this.repository.retrieve(customerId);
    const anonymousEmail = `anonimo+${customer.id}@ndivepa.invalid`;
    const result = await this.store.transaction(state => {
      for (const address of (state.addresses || []).filter(row => row.customerId === customerId)) {
        Object.assign(address, {
          firstName: 'Anonimizado', lastName: '', company: null, address1: '[borrado]', address2: null,
          phone: null, instructions: null, postalCode: null,
        });
      }
      for (const order of (state.orders || []).filter(row => row.customerId === customerId)) {
        order.email = anonymousEmail;
        if (order.shippingAddress) Object.assign(order.shippingAddress, { firstName: 'Anonimizado', lastName: '', phone: null, address1: '[borrado]' });
        if (order.billingAddress) Object.assign(order.billingAddress, { firstName: 'Anonimizado', lastName: '', phone: null, address1: '[borrado]' });
      }
      return this.repository.patch(state, customerId, {
        email: anonymousEmail,
        firstName: 'Anonimizado',
        lastName: '',
        company: null,
        phone: null,
        taxId: null,
        notes: null,
        status: 'anonymized',
        hasAccount: false,
        passwordHash: null,
        salt: null,
        anonymizedAt: now(),
      }).after;
    });
    await this.emit('anonymized', { id: customerId }, ctx);
    return this.publicView(result);
  }
}

export default {
  name: 'customer',
  requires: ['store', 'events', 'audit', 'config', 'customFields', 'geography', 'notifications'],
  resources: [customerGroupResource, addressResource, customerResource, customerSessionResource],
  permissions: [
    { resource: 'customer', description: 'Clientes.' },
    { resource: 'customerGroup', description: 'Grupos de cliente.' },
    { resource: 'address', description: 'Direcciones.' },
  ],

  register(deps) {
    const groups = new CustomerGroupService(deps);
    const addresses = new AddressService(deps);
    const sessions = new BaseService(deps, customerSessionResource);
    return { groups, addresses, sessions, customers: new CustomerService({ ...deps, groups, addresses, sessions }) };
  },

  async seed(service) {
    await service.groups.seed([
      { id: 'cgroup_general', code: 'general', name: 'Clientes generales', priority: 100 },
      { id: 'cgroup_vip', code: 'vip', name: 'VIP', automatic: true, rules: { minOrders: 3 }, priority: 200 },
      { id: 'cgroup_wholesale', code: 'mayorista', name: 'Mayorista', taxExempt: false, priority: 300 },
    ], 'id');
  },

  routes: {
    admin: container => {
      const module = () => container.resolve('customer');
      return [
        ...crudRoutes(customerGroupResource, () => module().groups, { tags: ['clientes'] }),
        ...crudRoutes(addressResource, () => module().addresses, { tags: ['clientes'] }),
        ...crudRoutes(customerResource, () => module().customers, { tags: ['clientes'] }),
        {
          method: 'GET',
          path: '/customers/:id/metrics',
          permission: 'customer:read',
          summary: 'Pedidos, gasto y ticket medio del cliente.',
          tags: ['clientes'],
          bodyless: true,
          handler: ctx => ({
            ...module().customers.metrics(ctx.params.id),
            groupIds: module().customers.groupsFor(ctx.params.id),
          }),
        },
        {
          method: 'GET',
          path: '/customers/:id/export',
          permission: 'customer:read',
          summary: 'Exporta todos los datos del cliente en JSON.',
          tags: ['clientes'],
          bodyless: true,
          handler: ctx => module().customers.exportData(ctx.params.id),
        },
        {
          method: 'POST',
          path: '/customers/:id/anonymize',
          permission: 'customer:delete',
          summary: 'Anonimiza el cliente conservando la integridad de sus pedidos.',
          tags: ['clientes'],
          handler: ctx => module().customers.anonymize(ctx.params.id, ctx),
        },
      ];
    },

    store: container => {
      const module = () => container.resolve('customer');
      const requireCustomer = ctx => {
        const customer = module().customers.customerFromRequest(ctx);
        if (!customer) throw new UnauthorizedError('Inicia sesión para continuar.');
        return customer;
      };
      return [
        {
          method: 'POST',
          path: '/customers/register',
          permission: null,
          csrf: false,
          summary: 'Crea una cuenta de cliente.',
          tags: ['store'],
          status: 201,
          body: {
            email: rule.email({ required: true }),
            password: { type: 'string', required: true, minLength: 12, maxLength: 200 },
            firstName: rule.text(80),
            lastName: rule.text(80),
            locale: rule.text(10),
          },
          handler: ctx => module().customers.register(ctx.body, ctx),
        },
        {
          method: 'POST',
          path: '/customers/login',
          permission: null,
          csrf: false,
          summary: 'Autentica un cliente y emite su cookie.',
          tags: ['store'],
          body: {
            email: rule.email({ required: true }),
            password: { type: 'string', required: true, maxLength: 200 },
          },
          handler: async ctx => {
            const customer = await module().customers.authenticate(ctx.body);
            const session = await module().customers.createSession(customer.id);
            const sessionConfig = container.resolve('config').session;
            const secure = sessionConfig.secure;
            const csrfToken = issueCsrfToken();
            ctx.res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
              'Set-Cookie': [
                `${sessionConfig.customerCookieName}=${session.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`,
                `ndivepa_csrf=${csrfToken}; SameSite=Lax; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`,
              ],
            });
            ctx.res.end(JSON.stringify({ customer: module().customers.publicView(customer), csrfToken }));
          },
        },
        {
          method: 'POST',
          path: '/customers/logout',
          permission: null,
          summary: 'Cierra la sesión del cliente.',
          tags: ['store'],
          handler: async ctx => {
            const cookieName = container.resolve('config').session.customerCookieName;
            await module().customers.revokeSession(ctx.cookies[cookieName]);
            ctx.res.writeHead(204, { 'Set-Cookie': [`${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`, 'ndivepa_csrf=; SameSite=Lax; Path=/; Max-Age=0'] });
            ctx.res.end();
          },
        },
        {
          method: 'GET',
          path: '/customers/me',
          permission: null,
          summary: 'Perfil del cliente autenticado.',
          tags: ['store'],
          bodyless: true,
          handler: ctx => {
            const customer = module().customers.customerFromRequest(ctx);
            return { customer: module().customers.publicView(customer) };
          },
        },
        {
          method: 'PATCH',
          path: '/customers/me',
          permission: null,
          summary: 'Actualiza el perfil propio.',
          tags: ['store'],
          body: {
            firstName: rule.text(80),
            lastName: rule.text(80),
            phone: rule.text(40),
            company: rule.text(120),
            locale: rule.text(10),
          },
          handler: async ctx => {
            const customer = requireCustomer(ctx);
            return module().customers.publicView(await module().customers.update(customer.id, ctx.body, ctx));
          },
        },
        {
          method: 'POST',
          path: '/customers/me/consent',
          permission: null,
          summary: 'Registra el consentimiento de marketing y analítica.',
          tags: ['store'],
          body: { marketing: rule.flag(), analytics: rule.flag() },
          handler: ctx => module().customers.setConsent(requireCustomer(ctx).id, ctx.body, ctx),
        },
        {
          method: 'GET',
          path: '/customers/me/addresses',
          permission: null,
          summary: 'Direcciones del cliente.',
          tags: ['store'],
          bodyless: true,
          handler: ctx => {
            const data = module().addresses.forCustomer(requireCustomer(ctx).id);
            return { data, count: data.length };
          },
        },
        {
          method: 'POST',
          path: '/customers/me/addresses',
          permission: null,
          summary: 'Añade una dirección.',
          tags: ['store'],
          status: 201,
          body: addressResource.fields,
          handler: ctx => module().addresses.create({ ...ctx.body, customerId: requireCustomer(ctx).id }, ctx),
        },
        {
          method: 'PATCH',
          path: '/customers/me/addresses/:id',
          permission: null,
          summary: 'Actualiza una dirección propia.',
          tags: ['store'],
          body: addressResource.fields,
          handler: ctx => {
            const customer = requireCustomer(ctx);
            const address = module().addresses.repository.retrieve(ctx.params.id);
            if (address.customerId !== customer.id) throw new UnauthorizedError();
            return module().addresses.update(address.id, ctx.body, ctx);
          },
        },
        {
          method: 'DELETE',
          path: '/customers/me/addresses/:id',
          permission: null,
          summary: 'Borra una dirección propia.',
          tags: ['store'],
          bodyless: true,
          handler: ctx => {
            const customer = requireCustomer(ctx);
            const address = module().addresses.repository.retrieve(ctx.params.id);
            if (address.customerId !== customer.id) throw new UnauthorizedError();
            return module().addresses.delete(address.id, ctx);
          },
        },
        {
          method: 'POST',
          path: '/customers/password-reset',
          permission: null,
          csrf: false,
          summary: 'Solicita un código de restablecimiento.',
          tags: ['store'],
          body: { email: rule.email({ required: true }) },
          handler: ctx => module().customers.requestPasswordReset(ctx.body.email),
        },
        {
          method: 'POST',
          path: '/customers/password-reset/confirm',
          permission: null,
          csrf: false,
          summary: 'Define una contraseña nueva con el código recibido.',
          tags: ['store'],
          body: {
            token: rule.text(200, { required: true }),
            password: { type: 'string', required: true, minLength: 12, maxLength: 200 },
          },
          handler: ctx => module().customers.resetPassword(ctx.body),
        },
        {
          method: 'POST',
          path: '/customers/verify',
          permission: null,
          csrf: false,
          summary: 'Verifica el correo con el código recibido.',
          tags: ['store'],
          body: { token: rule.text(200, { required: true }) },
          handler: ctx => module().customers.verifyEmail(ctx.body.token),
        },
      ];
    },
  },
};
