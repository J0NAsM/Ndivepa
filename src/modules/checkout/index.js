/**
 * Checkout (M-0711 … M-0730).
 *
 * El único proceso del proyecto que toca cinco dominios a la vez —carrito,
 * inventario, pedido, pago y promoción— y por eso es un **workflow con
 * compensación** al estilo de `@medusajs/orchestration`: si el pago falla después de
 * reservar stock, la compensación libera la reserva y anula el pedido. Nadie tiene
 * que acordarse de hacerlo en un `catch`.
 */
import { rule } from '../../framework/validate.js';
import { ConflictError, ValidationError } from '../../framework/errors.js';

export const CHECKOUT_STEPS = ['cart', 'contact', 'address', 'shipping', 'payment', 'review', 'complete'];

export class CheckoutService {
  constructor({ container, settings, workflows, logger }) {
    this.container = container;
    this.settings = settings;
    this.workflows = workflows;
    this.logger = logger;
    this.definition = null;
  }

  get cart() { return this.container.resolve('cart'); }
  get orders() { return this.container.resolve('order').orders; }
  get payment() { return this.container.resolve('payment'); }
  get inventory() { return this.container.resolve('inventory').service; }
  get fulfillment() { return this.container.resolve('fulfillment'); }

  assertEnabled() {
    this.settings.assertCapability('checkout');
  }

  /** Paso alcanzado y qué falta para poder confirmar (M-0711). */
  progress(cart) {
    const steps = {
      cart: (cart.items || []).length > 0,
      contact: Boolean(cart.email || cart.customerId),
      address: Boolean(cart.shippingAddress?.address1 && cart.shippingAddress?.countryCode),
      shipping: Boolean(cart.shippingMethod) || !(cart.items || []).some(item => item.requiresShipping),
      payment: true,
      review: true,
    };
    const missing = Object.entries(steps).filter(([, ok]) => !ok).map(([step]) => step);
    return {
      steps,
      currentStep: missing[0] || 'review',
      missing,
      ready: missing.length === 0,
      blockers: (cart.warnings || []).filter(warning => ['insufficient_stock', 'line_unavailable'].includes(warning.code)),
    };
  }

  /** Registra el workflow una sola vez, con su compensación por paso. */
  register() {
    if (this.definition) return this.definition;
    this.definition = this.workflows.define('checkout.complete', flow => {
      flow
        .step(
          'validate-cart',
          async context => {
            const cart = await this.cart.recalculate(context.input.cartId, context.actor ? { actor: context.actor } : null);
            const progress = this.progress(cart);
            if (!progress.ready) {
              throw new ValidationError(progress.missing.map(step => ({ field: step, message: `Falta completar el paso "${step}".` })));
            }
            if (progress.blockers.length) {
              throw new ConflictError('El carrito tiene líneas sin disponibilidad.', { blockers: progress.blockers });
            }
            if (cart.status !== 'active') throw new ConflictError('El carrito ya no está activo.', { status: cart.status });
            return cart;
          },
        )
        .step(
          'reserve-stock',
          async context => {
            const cart = context.results['validate-cart'];
            const reservations = await this.cart.reserveStock(cart, null);
            return { cartId: cart.id, reservations: reservations.length };
          },
          // Compensación: liberar el stock reservado (M-0718).
          async output => {
            await this.inventory.release({ reference: output.cartId });
          },
        )
        .step(
          'create-order',
          async context => {
            const cart = context.results['validate-cart'];
            return this.orders.createFromCart(cart, { idempotencyKey: context.input.idempotencyKey }, null);
          },
          // Compensación: cancelar el pedido creado (M-0719).
          async output => {
            if (output?.id) {
              await this.orders.repository.retrieve(output.id);
              await this.orders.cancel(output.id, 'Compensación automática del checkout', null).catch(() => {});
            }
          },
        )
        .step(
          'collect-payment',
          async context => {
            const order = context.results['create-order'];
            const cart = context.results['validate-cart'];
            const payable = cart.payableTotal ?? cart.total;
            if (payable <= 0) return { skipped: true, reason: 'total_cubierto_por_tarjeta_regalo' };
            if (!context.input.paymentMethodId) {
              throw ValidationError.single('paymentMethodId', 'Selecciona un método de pago.');
            }
            const collection = await this.payment.service.ensureCollection({
              orderId: order.id,
              currencyCode: order.currencyCode,
              requiredAmount: payable,
            }, null);
            const session = await this.payment.service.createSession(collection.id, {
              paymentMethodId: context.input.paymentMethodId,
              idempotencyKey: context.input.idempotencyKey,
            }, null);
            const payment = await this.payment.service.authorize(session.id, {}, null);
            return { collectionId: collection.id, sessionId: session.id, paymentId: payment?.id || null };
          },
          async output => {
            if (output?.paymentId) await this.payment.service.cancel(output.paymentId, null).catch(() => {});
          },
        )
        .step(
          'confirm-order',
          async context => {
            const order = context.results['create-order'];
            return this.orders.confirm(order.id, null);
          },
        )
        .step(
          'close-cart',
          async context => {
            const cart = context.results['validate-cart'];
            await this.cart.store.transaction(state => this.cart.repository.patch(state, cart.id, {
              status: 'completed',
              completedAt: new Date().toISOString(),
            }));
            return { cartId: cart.id };
          },
        );
    });
    return this.definition;
  }

  /**
   * Completa el checkout. Reintentar con la misma `idempotencyKey` devuelve el mismo
   * resultado en lugar de crear un segundo pedido (M-0720, M-0728).
   */
  async complete({ cartId, paymentMethodId = null, idempotencyKey = null }, ctx = null) {
    this.assertEnabled();
    this.register();
    const result = await this.workflows.run(
      'checkout.complete',
      { cartId, paymentMethodId, idempotencyKey },
      { idempotencyKey: idempotencyKey ? `checkout:${idempotencyKey}` : null, actor: ctx?.actor || null },
    );
    const order = result.results['confirm-order'] || result.results['create-order'];
    return {
      order: this.orders.publicView(order),
      payment: result.results['collect-payment'] || null,
      workflow: { runId: result.runId, idempotent: Boolean(result.idempotent), trace: result.trace },
    };
  }
}

export default {
  name: 'checkout',
  requires: ['container', 'settings', 'workflows', 'logger'],

  register(deps) {
    const service = new CheckoutService(deps);
    return service;
  },

  routes: {
    store: container => {
      const service = () => container.resolve('checkout');
      const cart = () => container.resolve('cart');
      const assertCartOwner = ctx => {
        const record = cart().repository.retrieve(ctx.params.id);
        if (record.customerId) {
          const customer = container.resolve('customer').customers.customerFromRequest(ctx);
          if (!customer || customer.id !== record.customerId) throw new ConflictError('El carrito no pertenece al cliente autenticado.');
        }
        return record;
      };
      return [
        {
          method: 'GET',
          path: '/carts/:id/checkout',
          permission: null,
          summary: 'Estado del checkout: paso actual, lo que falta y bloqueos.',
          tags: ['store'],
          bodyless: true,
          handler: ctx => {
            container.resolve('settings').settings.assertCapability('checkout');
            const record = assertCartOwner(ctx);
            return { cart: cart().publicView(record), ...service().progress(record) };
          },
        },
        {
          method: 'POST',
          path: '/carts/:id/complete',
          permission: null,
          summary: 'Completa el checkout como workflow con compensación.',
          tags: ['store'],
          status: 201,
          body: {
            paymentMethodId: rule.id(),
            idempotencyKey: rule.text(120),
          },
          handler: ctx => {
            const record = assertCartOwner(ctx);
            if (record.customerId) {
              container.resolve('b2b').service.assertCheckout(record, record.customerId);
            }
            return service().complete({
              cartId: ctx.params.id,
              paymentMethodId: ctx.body.paymentMethodId || null,
              idempotencyKey: ctx.body.idempotencyKey || ctx.req.headers['idempotency-key'] || null,
            }, ctx);
          },
        },
      ];
    },

    admin: container => [
      {
        method: 'GET',
        path: '/workflows',
        permission: 'order:read',
        summary: 'Workflows registrados y últimas ejecuciones.',
        tags: ['operación'],
        bodyless: true,
        handler: () => {
          const workflows = container.resolve('workflows');
          return { definitions: workflows.list(), runs: workflows.runs({ limit: 30 }) };
        },
      },
    ],
  },
};
