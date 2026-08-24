/**
 * Pagos (M-0651 … M-0670).
 *
 * Estructura de Medusa: **colección de pago** por pedido, **sesiones** por proveedor
 * y **pagos** con sus capturas y reembolsos.
 *
 * Solo hay proveedores manuales (transferencia, contra entrega, tarjeta regalo).
 * Stripe y cualquier pasarela real quedan como contrato preparado y sin activar:
 * requieren credenciales que el proyecto no tiene (M-0667). Regla firme: **no se
 * guarda ningún dato de tarjeta** (M-0665).
 */
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule } from '../../framework/validate.js';
import { ConflictError, NotAllowedError, NotFoundError, ValidationError } from '../../framework/errors.js';
import { id as generateId } from '../../framework/ids.js';
import { now } from '../../framework/dates.js';
import { verifySignature } from '../../framework/webhooks.js';

export const PAYMENT_STATES = ['pending', 'authorized', 'captured', 'partially_captured', 'cancelled', 'refunded', 'partially_refunded', 'failed'];

/** Campos que nunca se aceptan ni se almacenan. */
const FORBIDDEN_FIELDS = ['cardNumber', 'pan', 'cvv', 'cvc', 'securityCode', 'expiry', 'track2'];

export const paymentMethodResource = defineResource({
  name: 'paymentMethod',
  collection: 'paymentMethods',
  prefix: 'pmeth',
  route: 'payment-methods',
  unique: ['code'],
  searchable: ['name', 'code'],
  translatable: ['name', 'description'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(120, { required: true }),
    description: rule.text(500),
    provider: rule.enumOf(['manual_transfer', 'cash_on_delivery', 'in_store', 'gift_card', 'external'], { required: true }),
    instructions: rule.text(2000),
    // Elegibilidad del método (M-0655).
    regionIds: rule.list({ type: 'string' }, { default: [] }),
    channelIds: rule.list({ type: 'string' }, { default: [] }),
    currencyCodes: rule.list({ type: 'string' }, { default: [] }),
    minTotal: rule.minor(),
    maxTotal: rule.minor(),
    // `capturesImmediately` indica si el cobro se considera hecho al confirmar.
    capturesImmediately: rule.flag({ default: false }),
    surchargePercent: rule.percent({ default: 0 }),
    surchargeFlat: rule.minor({ default: 0 }),
    rank: { type: 'integer', coerce: true, min: 0, default: 100 },
    active: rule.flag({ default: true }),
    metadata: rule.metadata(),
  },
});

export const paymentCollectionResource = defineResource({
  name: 'paymentCollection',
  collection: 'paymentCollections',
  prefix: 'paycol',
  route: 'payment-collections',
  searchable: ['orderId'],
  fields: {
    orderId: rule.id(),
    cartId: rule.id(),
    currencyCode: rule.currency({ required: true }),
    requiredAmount: rule.minor({ required: true }),
    authorizedAmount: rule.minor({ default: 0 }),
    capturedAmount: rule.minor({ default: 0 }),
    refundedAmount: rule.minor({ default: 0 }),
    status: rule.enumOf(['not_paid', 'awaiting', 'authorized', 'partially_paid', 'paid', 'refunded', 'cancelled'], { default: 'not_paid' }),
    metadata: rule.metadata(),
  },
});

export const paymentSessionResource = defineResource({
  name: 'paymentSession',
  collection: 'paymentSessions',
  prefix: 'pases',
  route: 'payment-sessions',
  searchable: [],
  fields: {
    paymentCollectionId: rule.id({ required: true }),
    paymentMethodId: rule.id({ required: true }),
    provider: rule.text(60, { required: true }),
    amount: rule.minor({ required: true }),
    currencyCode: rule.currency({ required: true }),
    status: rule.enumOf(['pending', 'requires_action', 'authorized', 'error', 'cancelled'], { default: 'pending' }),
    // Solo datos no sensibles: referencias e instrucciones (M-0664, M-0665).
    providerData: rule.metadata(),
    idempotencyKey: rule.text(120),
    metadata: rule.metadata(),
  },
});

export const paymentResource = defineResource({
  name: 'payment',
  collection: 'payments',
  prefix: 'pay',
  route: 'payments',
  searchable: ['reference'],
  fields: {
    paymentCollectionId: rule.id({ required: true }),
    paymentSessionId: rule.id(),
    orderId: rule.id(),
    paymentMethodId: rule.id(),
    provider: rule.text(60, { required: true }),
    amount: rule.minor({ required: true }),
    capturedAmount: rule.minor({ default: 0 }),
    refundedAmount: rule.minor({ default: 0 }),
    currencyCode: rule.currency({ required: true }),
    status: rule.enumOf(PAYMENT_STATES, { default: 'pending' }),
    reference: rule.text(200),
    authorizedAt: rule.date(),
    capturedAt: rule.date(),
    cancelledAt: rule.date(),
    providerResponses: { type: 'array', default: [] },
    idempotencyKey: rule.text(120),
    metadata: rule.metadata(),
  },
});

/** Proveedor manual: autoriza siempre y captura cuando el operador lo confirma. */
export class ManualPaymentProvider {
  constructor({ code = 'manual_transfer', capturesImmediately = false } = {}) {
    this.code = code;
    this.capturesImmediately = capturesImmediately;
  }

  async createSession({ amount, currencyCode, method }) {
    return {
      status: 'requires_action',
      providerData: {
        instructions: method?.instructions || 'Sigue las instrucciones de pago indicadas por la tienda.',
        reference: generateId('ref'),
        amount,
        currencyCode,
      },
    };
  }

  async authorize({ session }) {
    return { status: 'authorized', reference: session.providerData?.reference || generateId('ref'), response: { provider: this.code, authorized: true } };
  }

  async capture({ payment, amount }) {
    return { status: 'completed', reference: payment.reference, amount, response: { provider: this.code, captured: amount } };
  }

  async cancel() {
    return { status: 'cancelled', response: { provider: this.code, cancelled: true } };
  }

  async refund({ payment, amount }) {
    return { status: 'completed', reference: payment.reference, amount, response: { provider: this.code, refunded: amount } };
  }
}

/**
 * Contrato para una pasarela real. No se registra por defecto: sin credenciales
 * ni contrato firmado, activarlo daría una falsa sensación de que el cobro funciona.
 */
export class ExternalGatewayProvider {
  constructor({ code = 'external' } = {}) {
    this.code = code;
    this.requiresCredentials = true;
  }

  unavailable() {
    throw new NotAllowedError(
      `El proveedor de pago "${this.code}" requiere credenciales que no están configuradas`,
      'sin_credenciales',
    );
  }

  async createSession() { return this.unavailable(); }
  async authorize() { return this.unavailable(); }
  async capture() { return this.unavailable(); }
  async cancel() { return this.unavailable(); }
  async refund() { return this.unavailable(); }
}

export class PaymentService {
  constructor({ store, events, audit, settings, orders, methods, collections, sessions, payments, promotion, config, alerts }) {
    this.store = store;
    this.events = events;
    this.audit = audit;
    this.settings = settings;
    this.orders = orders;
    this.methods = methods;
    this.collections = collections;
    this.sessions = sessions;
    this.payments = payments;
    this.promotion = promotion;
    this.config = config;
    this.alerts = alerts;
    this.providers = new Map([
      ['manual_transfer', new ManualPaymentProvider({ code: 'manual_transfer' })],
      ['cash_on_delivery', new ManualPaymentProvider({ code: 'cash_on_delivery' })],
      ['in_store', new ManualPaymentProvider({ code: 'in_store', capturesImmediately: true })],
      ['gift_card', new ManualPaymentProvider({ code: 'gift_card', capturesImmediately: true })],
      ['external', new ExternalGatewayProvider()],
    ]);
    this.webhookSeen = new Set();
  }

  registerProvider(code, provider) {
    this.providers.set(code, provider);
    return this;
  }

  provider(code) {
    const implementation = this.providers.get(code);
    if (!implementation) throw new NotFoundError('proveedor de pago', code);
    return implementation;
  }

  assertEnabled() {
    this.settings.assertCapability('payment');
  }

  assertNoCardData(input) {
    const found = FORBIDDEN_FIELDS.filter(field => input && Object.hasOwn(input, field));
    if (found.length) {
      throw new ValidationError(
        found.map(field => ({ field, message: 'No se admiten datos de tarjeta: el proyecto no los procesa ni los almacena.' })),
      );
    }
  }

  /** Métodos elegibles para un contexto (M-0655). */
  eligibleMethods({ regionId = null, channelId = null, currencyCode = null, total = 0 } = {}) {
    return this.methods.repository
      .all({ active: true })
      .filter(method => !method.regionIds?.length || (regionId && method.regionIds.includes(regionId)))
      .filter(method => !method.channelIds?.length || (channelId && method.channelIds.includes(channelId)))
      .filter(method => !method.currencyCodes?.length || (currencyCode && method.currencyCodes.includes(currencyCode)))
      .filter(method => (method.minTotal === null || method.minTotal === undefined || total >= method.minTotal))
      .filter(method => (method.maxTotal === null || method.maxTotal === undefined || total <= method.maxTotal))
      .sort((a, b) => a.rank - b.rank)
      .map(method => ({
        id: method.id,
        code: method.code,
        name: method.name,
        description: method.description,
        provider: method.provider,
        instructions: method.instructions,
        surchargePercent: method.surchargePercent || 0,
        surchargeFlat: method.surchargeFlat || 0,
        requiresCredentials: this.providers.get(method.provider)?.requiresCredentials || false,
      }));
  }

  async ensureCollection({ orderId = null, cartId = null, currencyCode, requiredAmount }, ctx = null) {
    this.assertEnabled();
    const existing = orderId
      ? this.collections.repository.find({ orderId })
      : this.collections.repository.find({ cartId });
    if (existing) {
      if (existing.requiredAmount !== requiredAmount) {
        const result = await this.store.transaction(state => this.collections.repository.patch(state, existing.id, { requiredAmount }));
        return result.after;
      }
      return existing;
    }
    return this.collections.create({ orderId, cartId, currencyCode, requiredAmount, status: 'not_paid' }, ctx);
  }

  async createSession(collectionId, { paymentMethodId, amount = null, idempotencyKey = null }, ctx = null) {
    this.assertEnabled();
    const collection = this.collections.repository.retrieve(collectionId);
    const method = this.methods.repository.retrieve(paymentMethodId);
    if (!method.active) throw new ConflictError('El método de pago no está activo.', { paymentMethodId });

    if (idempotencyKey) {
      const existing = this.sessions.repository.find({ idempotencyKey });
      if (existing) return existing;
    }

    const value = amount ?? (collection.requiredAmount - collection.authorizedAmount);
    if (value <= 0) throw new ConflictError('La colección de pago ya está cubierta.', { collectionId });

    const provider = this.provider(method.provider);
    const result = await provider.createSession({ amount: value, currencyCode: collection.currencyCode, method });

    return this.sessions.create({
      paymentCollectionId: collectionId,
      paymentMethodId,
      provider: method.provider,
      amount: value,
      currencyCode: collection.currencyCode,
      status: result.status,
      providerData: result.providerData || {},
      idempotencyKey,
    }, ctx);
  }

  async authorize(sessionId, input = {}, ctx = null) {
    this.assertEnabled();
    this.assertNoCardData(input);
    const session = this.sessions.repository.retrieve(sessionId);
    if (session.status === 'authorized') {
      return this.payments.repository.find({ paymentSessionId: sessionId });
    }
    const collection = this.collections.repository.retrieve(session.paymentCollectionId);
    const provider = this.provider(session.provider);
    const result = await provider.authorize({ session, input });

    const payment = await this.payments.create({
      paymentCollectionId: collection.id,
      paymentSessionId: session.id,
      orderId: collection.orderId,
      paymentMethodId: session.paymentMethodId,
      provider: session.provider,
      amount: session.amount,
      currencyCode: session.currencyCode,
      status: 'authorized',
      reference: result.reference,
      authorizedAt: now(),
      providerResponses: [{ at: now(), action: 'authorize', response: sanitizeResponse(result.response) }],
      idempotencyKey: session.idempotencyKey,
    }, ctx);

    await this.store.transaction(state => {
      this.sessions.repository.patch(state, sessionId, { status: 'authorized' });
      this.collections.repository.patch(state, collection.id, {
        authorizedAmount: (collection.authorizedAmount || 0) + session.amount,
        status: 'authorized',
      });
    });

    if (collection.orderId) {
      await this.orders.addTransaction(collection.orderId, {
        type: 'authorization',
        amount: session.amount,
        reference: result.reference,
        provider: session.provider,
      }, ctx);
    }

    const method = this.methods.repository.byId(session.paymentMethodId);
    if (method?.capturesImmediately) await this.capture(payment.id, { amount: session.amount }, ctx);

    await this.events.emit('payment.authorized', { paymentId: payment.id, orderId: collection.orderId, amount: session.amount });
    return this.payments.repository.retrieve(payment.id);
  }

  /** Captura total o parcial, idempotente por clave (M-0657, M-0663). */
  async capture(paymentId, { amount = null, idempotencyKey = null } = {}, ctx = null) {
    this.assertEnabled();
    const payment = this.payments.repository.retrieve(paymentId);
    if (!['authorized', 'partially_captured'].includes(payment.status)) {
      throw new ConflictError(`No se puede capturar un pago en estado "${payment.status}".`, { status: payment.status });
    }
    const pending = payment.amount - (payment.capturedAmount || 0);
    const value = Math.min(amount ?? pending, pending);
    if (value <= 0) throw new ConflictError('No queda importe por capturar.', { paymentId });

    if (idempotencyKey && (payment.metadata?.captureKeys || []).includes(idempotencyKey)) {
      return payment;
    }

    const provider = this.provider(payment.provider);
    const result = await provider.capture({ payment, amount: value });
    const captured = (payment.capturedAmount || 0) + value;

    const updated = await this.store.transaction(state => {
      const collection = (state.paymentCollections || []).find(row => row.id === payment.paymentCollectionId);
      if (collection) {
        collection.capturedAmount = (collection.capturedAmount || 0) + value;
        collection.status = collection.capturedAmount >= collection.requiredAmount ? 'paid' : 'partially_paid';
      }
      return this.payments.repository.patch(state, paymentId, {
        capturedAmount: captured,
        status: captured >= payment.amount ? 'captured' : 'partially_captured',
        capturedAt: now(),
        providerResponses: [...(payment.providerResponses || []), { at: now(), action: 'capture', response: sanitizeResponse(result.response) }],
        metadata: { ...(payment.metadata || {}), captureKeys: [...((payment.metadata || {}).captureKeys || []), idempotencyKey].filter(Boolean) },
      }).after;
    });

    if (payment.orderId) {
      await this.orders.addTransaction(payment.orderId, {
        type: 'capture',
        amount: value,
        reference: payment.reference,
        provider: payment.provider,
      }, ctx);
    }
    await this.events.emit('payment.captured', { paymentId, orderId: payment.orderId, amount: value });
    return updated;
  }

  async cancel(paymentId, ctx = null) {
    const payment = this.payments.repository.retrieve(paymentId);
    if (payment.capturedAmount > 0) {
      throw new ConflictError('El pago ya tiene importe capturado; usa un reembolso.', { capturedAmount: payment.capturedAmount });
    }
    const provider = this.provider(payment.provider);
    const result = await provider.cancel({ payment });
    const updated = await this.store.transaction(state => this.payments.repository.patch(state, paymentId, {
      status: 'cancelled',
      cancelledAt: now(),
      providerResponses: [...(payment.providerResponses || []), { at: now(), action: 'cancel', response: sanitizeResponse(result.response) }],
    }).after);
    await this.events.emit('payment.cancelled', { paymentId, orderId: payment.orderId });
    return updated;
  }

  async refund(paymentId, { amount, reason }, ctx = null) {
    this.assertEnabled();
    const payment = this.payments.repository.retrieve(paymentId);
    const refundable = (payment.capturedAmount || 0) - (payment.refundedAmount || 0);
    const value = Math.min(Number(amount), refundable);
    if (!(value > 0)) throw new ConflictError('No hay importe reembolsable en este pago.', { refundable });

    const provider = this.provider(payment.provider);
    const result = await provider.refund({ payment, amount: value });
    const refunded = (payment.refundedAmount || 0) + value;

    const updated = await this.store.transaction(state => {
      const collection = (state.paymentCollections || []).find(row => row.id === payment.paymentCollectionId);
      if (collection) {
        collection.refundedAmount = (collection.refundedAmount || 0) + value;
        if (collection.refundedAmount >= collection.capturedAmount) collection.status = 'refunded';
      }
      return this.payments.repository.patch(state, paymentId, {
        refundedAmount: refunded,
        status: refunded >= (payment.capturedAmount || 0) ? 'refunded' : 'partially_refunded',
        providerResponses: [...(payment.providerResponses || []), { at: now(), action: 'refund', response: sanitizeResponse(result.response) }],
      }).after;
    });

    if (payment.orderId) {
      await this.orders.addTransaction(payment.orderId, {
        type: 'refund',
        amount: value,
        reference: payment.reference,
        provider: payment.provider,
        note: reason,
      }, ctx);
    }
    await this.events.emit('payment.refunded', { paymentId, orderId: payment.orderId, amount: value });
    return updated;
  }

  /**
   * Webhook de pago con verificación de firma e idempotencia (M-0666).
   * No hay proveedor real conectado, pero el contrato queda probado.
   */
  async handleWebhook({ provider, payload, signature, timestamp, secret, eventId }) {
    if (!secret) throw new NotAllowedError('Webhook de pago sin secreto configurado', 'sin_credenciales');
    if (!verifySignature(secret, payload, timestamp, signature)) {
      throw new ValidationError([{ field: 'signature', message: 'La firma del webhook no es válida.' }]);
    }
    if (eventId && this.webhookSeen.has(eventId)) return { duplicate: true };
    if (eventId) {
      this.webhookSeen.add(eventId);
      if (this.webhookSeen.size > 5000) this.webhookSeen.clear();
    }
    const data = JSON.parse(payload);
    await this.events.emit(`payment.webhook.${provider}`, data);
    return { received: true, provider, type: data.type || null };
  }

  /** Conciliación entre pagos y total del pedido (M-0668). */
  reconcile(orderId) {
    const order = this.orders.repository.retrieve(orderId);
    const payments = this.payments.repository.all({ orderId });
    const captured = payments.reduce((sum, payment) => sum + Number(payment.capturedAmount || 0), 0);
    const refunded = payments.reduce((sum, payment) => sum + Number(payment.refundedAmount || 0), 0);
    const expected = Number(order.total || 0) - Number(order.giftCardTotal || 0);
    const difference = captured - refunded - expected;
    return {
      orderId,
      code: order.code,
      expected,
      captured,
      refunded,
      difference,
      balanced: difference === 0,
      payments: payments.map(payment => ({
        id: payment.id,
        provider: payment.provider,
        status: payment.status,
        amount: payment.amount,
        capturedAmount: payment.capturedAmount,
        refundedAmount: payment.refundedAmount,
      })),
    };
  }
}

/** Nunca se guarda una respuesta que contenga algo parecido a datos de tarjeta. */
function sanitizeResponse(response) {
  if (!response || typeof response !== 'object') return response ?? null;
  const clean = {};
  for (const [key, value] of Object.entries(response)) {
    if (FORBIDDEN_FIELDS.some(field => key.toLowerCase().includes(field.toLowerCase()))) continue;
    clean[key] = typeof value === 'object' ? sanitizeResponse(value) : value;
  }
  return clean;
}

const SEED_METHODS = [
  {
    id: 'pmeth_transfer',
    code: 'transferencia',
    name: 'Transferencia bancaria',
    provider: 'manual_transfer',
    description: 'Realiza una transferencia y envía el comprobante.',
    instructions: 'Los datos bancarios se envían tras confirmar el pedido. Configúralos en Ajustes antes de publicar.',
    rank: 10,
    active: true,
  },
  {
    id: 'pmeth_cod',
    code: 'contra-entrega',
    name: 'Pago contra entrega',
    provider: 'cash_on_delivery',
    description: 'Paga al recibir el pedido.',
    rank: 20,
    active: true,
  },
  {
    id: 'pmeth_store',
    code: 'en-tienda',
    name: 'Pago en tienda',
    provider: 'in_store',
    description: 'Paga al retirar el pedido en el punto de recogida.',
    capturesImmediately: true,
    rank: 30,
    active: true,
  },
];

export default {
  name: 'payment',
  requires: ['store', 'events', 'audit', 'config', 'customFields', 'translations', 'settings', 'order', 'promotion', 'alert'],
  resources: [paymentMethodResource, paymentCollectionResource, paymentSessionResource, paymentResource],
  permissions: [
    { resource: 'payment', description: 'Pagos y capturas.' },
    { resource: 'paymentMethod', description: 'Métodos de pago.' },
    { resource: 'paymentCollection', description: 'Colecciones de pago.' },
  ],

  register(deps) {
    const methods = new BaseService(deps, paymentMethodResource);
    const collections = new BaseService(deps, paymentCollectionResource);
    const sessions = new BaseService(deps, paymentSessionResource);
    const payments = new BaseService(deps, paymentResource);
    const service = new PaymentService({
      store: deps.store,
      events: deps.events,
      audit: deps.audit,
      settings: deps.settings,
      orders: deps.order.orders,
      promotion: deps.promotion,
      config: deps.config,
      alerts: deps.alert,
      methods,
      collections,
      sessions,
      payments,
    });
    return { methods, collections, sessions, payments, service };
  },

  async seed(service) {
    await service.methods.seed(SEED_METHODS, 'id');
  },

  routes: {
    admin: container => {
      const module = () => container.resolve('payment');
      return [
        ...crudRoutes(paymentMethodResource, () => module().methods, { tags: ['pagos'] }),
        ...crudRoutes(paymentCollectionResource, () => module().collections, { tags: ['pagos'] }),
        ...crudRoutes(paymentResource, () => module().payments, { tags: ['pagos'] }),
        {
          method: 'POST',
          path: '/payments/:id/capture',
          permission: 'payment:update',
          summary: 'Captura total o parcial de un pago autorizado.',
          tags: ['pagos'],
          body: { amount: rule.minor(), idempotencyKey: rule.text(120) },
          handler: ctx => module().service.capture(ctx.params.id, ctx.body, ctx),
        },
        {
          method: 'POST',
          path: '/payments/:id/cancel',
          permission: 'payment:update',
          summary: 'Cancela una autorización sin capturar.',
          tags: ['pagos'],
          handler: ctx => module().service.cancel(ctx.params.id, ctx),
        },
        {
          method: 'POST',
          path: '/payments/:id/refund',
          permission: 'payment:update',
          summary: 'Reembolsa total o parcialmente un pago capturado.',
          tags: ['pagos'],
          body: { amount: rule.minor({ required: true }), reason: rule.text(300, { required: true }) },
          handler: ctx => module().service.refund(ctx.params.id, ctx.body, ctx),
        },
        {
          method: 'GET',
          path: '/orders/:id/payment-reconciliation',
          permission: 'payment:read',
          summary: 'Conciliación entre los pagos y el total del pedido.',
          tags: ['pagos'],
          bodyless: true,
          handler: ctx => module().service.reconcile(ctx.params.id),
        },
        {
          method: 'GET',
          path: '/payments/providers',
          permission: 'paymentMethod:read',
          summary: 'Proveedores registrados y si requieren credenciales.',
          tags: ['pagos'],
          bodyless: true,
          handler: () => ({
            data: [...module().service.providers.entries()].map(([code, provider]) => ({
              code,
              requiresCredentials: Boolean(provider.requiresCredentials),
              available: !provider.requiresCredentials,
            })),
          }),
        },
      ];
    },

    store: container => {
      const module = () => container.resolve('payment');
      return [
        {
          method: 'GET',
          path: '/carts/:id/payment-methods',
          permission: null,
          summary: 'Métodos de pago elegibles para el carrito.',
          tags: ['store'],
          bodyless: true,
          handler: ctx => {
            const cart = container.resolve('cart').repository.retrieve(ctx.params.id);
            const data = module().service.eligibleMethods({
              regionId: cart.regionId,
              channelId: cart.channelId,
              currencyCode: cart.currencyCode,
              total: cart.payableTotal ?? cart.total,
            });
            return { data, count: data.length };
          },
        },
        {
          method: 'POST',
          path: '/carts/:id/payment-sessions',
          permission: null,
          csrf: false,
          summary: 'Crea una sesión de pago para el carrito.',
          tags: ['store'],
          status: 201,
          body: { paymentMethodId: rule.id({ required: true }), idempotencyKey: rule.text(120) },
          handler: async ctx => {
            const cart = container.resolve('cart').repository.retrieve(ctx.params.id);
            const collection = await module().service.ensureCollection({
              cartId: cart.id,
              currencyCode: cart.currencyCode,
              requiredAmount: cart.payableTotal ?? cart.total,
            }, ctx);
            return module().service.createSession(collection.id, ctx.body, ctx);
          },
        },
      ];
    },
  },
};
