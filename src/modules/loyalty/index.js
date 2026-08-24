/**
 * Fidelización y saldo de puntos.
 *
 * Los puntos se guardan en un libro mayor inmutable: el saldo es una proyección
 * que se actualiza en la misma transacción. Así no se pueden gastar dos veces al
 * recargar una página, y cada ajuste queda trazable por pedido o por operador.
 */
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule } from '../../framework/validate.js';
import { ConflictError, NotFoundError, ValidationError } from '../../framework/errors.js';
import { now, plusMinutes, toDate } from '../../framework/dates.js';

export const loyaltyProgramResource = defineResource({
  name: 'loyaltyProgram',
  collection: 'loyaltyPrograms',
  prefix: 'loyprog',
  route: 'loyalty-programs',
  unique: ['code'],
  searchable: ['code', 'name'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(120, { required: true }),
    currencyCode: rule.currency({ required: true }),
    // Puntos ganados por unidad menor de moneda; permite, por ejemplo, 0.01 = 1%.
    earnPointsPerMinor: { type: 'number', coerce: true, min: 0, max: 1000, default: 0 },
    // Valor de un punto, expresado en unidades menores de la moneda del programa.
    redeemMinorPerPoint: { type: 'integer', coerce: true, min: 1, max: 100_000_000, default: 1 },
    minRedeemPoints: rule.quantity({ default: 1, min: 1 }),
    reservationMinutes: rule.quantity({ default: 30, min: 1, max: 24 * 60 }),
    active: rule.flag({ default: true }),
    metadata: rule.metadata(),
  },
});

export const loyaltyAccountResource = defineResource({
  name: 'loyaltyAccount',
  collection: 'loyaltyAccounts',
  prefix: 'loyacc',
  route: 'loyalty-accounts',
  searchable: ['customerId', 'programId'],
  fields: {
    customerId: rule.id({ required: true }),
    programId: rule.id({ required: true }),
    pointsBalance: { type: 'integer', coerce: true, default: 0 },
    metadata: rule.metadata(),
  },
});

export const loyaltyTransactionResource = defineResource({
  name: 'loyaltyTransaction',
  collection: 'loyaltyTransactions',
  prefix: 'loytx',
  route: 'loyalty-transactions',
  softDelete: false,
  searchable: ['customerId', 'orderId', 'cartId', 'type', 'status'],
  fields: {
    accountId: rule.id({ required: true }),
    customerId: rule.id({ required: true }),
    programId: rule.id({ required: true }),
    orderId: rule.id(),
    cartId: rule.id(),
    type: rule.enumOf(['earned', 'reservation', 'redeemed', 'released', 'adjustment', 'expired'], { required: true }),
    status: rule.enumOf(['posted', 'reserved', 'released', 'expired'], { default: 'posted' }),
    // Negativo para consumos y positivo para abonos.
    points: { type: 'integer', coerce: true, required: true },
    amount: rule.minor({ default: 0 }),
    currencyCode: rule.currency({ required: true }),
    reason: rule.text(300),
    expiresAt: rule.date(),
    metadata: rule.metadata(),
  },
});

class LoyaltyService {
  constructor(deps) {
    this.deps = deps;
    this.store = deps.store;
    this.events = deps.events;
    this.audit = deps.audit;
    this.customer = deps.customer;
    this.programs = new BaseService(deps, loyaltyProgramResource);
    this.accounts = new BaseService(deps, loyaltyAccountResource);
    this.transactions = new BaseService(deps, loyaltyTransactionResource);
  }

  programForCurrency(currencyCode) {
    return this.programs.repository.all({ active: true })
      .find(program => program.currencyCode === currencyCode) || null;
  }

  accountFor(customerId, programId) {
    return this.accounts.repository.find({ customerId, programId });
  }

  /** Resumen seguro para tienda; no filtra movimientos de otros clientes. */
  summaryForCustomer(customerId) {
    this.customer.customers.repository.retrieve(customerId);
    const accounts = this.accounts.repository.all({ customerId });
    return accounts.map(account => {
      const program = this.programs.repository.byId(account.programId);
      return {
        ...account,
        program: program ? {
          id: program.id,
          code: program.code,
          name: program.name,
          currencyCode: program.currencyCode,
          redeemMinorPerPoint: program.redeemMinorPerPoint,
          minRedeemPoints: program.minRedeemPoints,
          active: program.active,
        } : null,
      };
    });
  }

  redemptionForCart(cartId, customerId, currencyCode) {
    return this.transactions.repository.all({ cartId, customerId, status: 'reserved' })
      .find(row => row.currencyCode === currencyCode && (toDate(row.expiresAt)?.getTime() ?? 0) > Date.now()) || null;
  }

  async ensureAccount(customerId, programId) {
    const existing = this.accountFor(customerId, programId);
    if (existing) return existing;
    return this.store.transaction(state => {
      const found = this.accounts.repository.raw(state).find(row => row.customerId === customerId && row.programId === programId && !row.deletedAt);
      return found || this.accounts.repository.insert(state, {
        customerId,
        programId,
        pointsBalance: 0,
        metadata: {},
      });
    });
  }

  async reserve({ customerId, cartId, currencyCode, points, maximumAmount }, ctx = null) {
    if (!Number.isInteger(Number(points)) || Number(points) < 1) {
      throw ValidationError.single('points', 'Indica una cantidad entera positiva de puntos.');
    }
    const program = this.programForCurrency(currencyCode);
    if (!program) throw new ConflictError('No hay un programa de fidelización activo para esta moneda.', { currencyCode });
    const wanted = Number(points);
    const maximumPoints = Math.floor(Math.max(0, Number(maximumAmount)) / program.redeemMinorPerPoint);
    const accepted = Math.min(wanted, maximumPoints);
    if (accepted < program.minRedeemPoints) {
      throw new ConflictError('El importe del carrito no alcanza el mínimo de canje.', { minRedeemPoints: program.minRedeemPoints });
    }

    const reservation = await this.store.transaction(state => {
      const accounts = this.accounts.repository.raw(state);
      let account = accounts.find(row => row.customerId === customerId && row.programId === program.id && !row.deletedAt);
      if (!account) account = this.accounts.repository.insert(state, { customerId, programId: program.id, pointsBalance: 0, metadata: {} });

      const rows = this.transactions.repository.raw(state);
      // Al editar el canje se libera primero la reserva anterior del mismo carrito.
      for (const row of rows.filter(row => row.cartId === cartId && row.customerId === customerId && row.status === 'reserved')) {
        account = this.accounts.repository.patch(state, account.id, {
          pointsBalance: account.pointsBalance - Number(row.points || 0),
        }).after;
        this.transactions.repository.patch(state, row.id, { type: 'released', status: 'released', reason: 'replaced_reservation' });
      }
      if (account.pointsBalance < accepted) {
        throw new ConflictError('No hay puntos suficientes para este canje.', { available: account.pointsBalance, requested: accepted });
      }
      const amount = accepted * program.redeemMinorPerPoint;
      const transaction = this.transactions.repository.insert(state, {
        accountId: account.id,
        customerId,
        programId: program.id,
        cartId,
        type: 'reservation',
        status: 'reserved',
        points: -accepted,
        amount,
        currencyCode,
        expiresAt: plusMinutes(now(), program.reservationMinutes),
        metadata: {},
      });
      this.accounts.repository.patch(state, account.id, { pointsBalance: account.pointsBalance - accepted });
      return { transactionId: transaction.id, programId: program.id, points: accepted, amount };
    });
    await this.events.emit('loyalty.reserved', { customerId, cartId, ...reservation });
    return reservation;
  }

  async releaseReservation({ cartId, customerId = null, reason = 'released' }, ctx = null) {
    const released = await this.store.transaction(state => {
      const rows = this.transactions.repository.raw(state)
        .filter(row => row.cartId === cartId && row.status === 'reserved' && (!customerId || row.customerId === customerId));
      for (const row of rows) {
        const account = this.accounts.repository.raw(state).find(item => item.id === row.accountId);
        if (account) this.accounts.repository.patch(state, account.id, { pointsBalance: account.pointsBalance - Number(row.points || 0) });
        this.transactions.repository.patch(state, row.id, { type: 'released', status: 'released', reason });
      }
      return rows.map(row => row.id);
    });
    if (released.length) await this.events.emit('loyalty.released', { cartId, customerId, transactions: released, reason });
    return { released: released.length };
  }

  async commitReservation({ cartId, orderId, customerId, amount }, ctx = null) {
    const result = await this.store.transaction(state => {
      const committed = this.transactions.repository.raw(state).find(row => row.orderId === orderId && row.type === 'redeemed');
      if (committed) return committed;
      const row = this.transactions.repository.raw(state)
        .find(item => item.cartId === cartId && item.customerId === customerId && item.status === 'reserved');
      if (!row) {
        if (Number(amount || 0) === 0) return null;
        throw new ConflictError('No existe una reserva de puntos válida para el carrito.', { cartId });
      }
      const program = this.programs.repository.raw(state).find(item => item.id === row.programId);
      const account = this.accounts.repository.raw(state).find(item => item.id === row.accountId);
      if (!program || !account) throw new NotFoundError('cuenta o programa de fidelización', row.accountId);
      const usedAmount = Math.min(Math.max(0, Number(amount || 0)), row.amount);
      const usedPoints = Math.ceil(usedAmount / program.redeemMinorPerPoint);
      const reservedPoints = Math.abs(Number(row.points || 0));
      const returnedPoints = reservedPoints - usedPoints;
      if (returnedPoints > 0) this.accounts.repository.patch(state, account.id, { pointsBalance: account.pointsBalance + returnedPoints });
      return this.transactions.repository.patch(state, row.id, {
        orderId,
        type: 'redeemed',
        status: 'posted',
        points: -usedPoints,
        amount: usedAmount,
        expiresAt: null,
        reason: 'order_checkout',
      }).after;
    });
    if (result) await this.events.emit('loyalty.redeemed', { transaction: result, ctx });
    return result;
  }

  async earnForOrder(order) {
    if (!order?.customerId || Number(order.total || 0) <= 0) return null;
    const program = this.programForCurrency(order.currencyCode);
    if (!program || !program.earnPointsPerMinor) return null;
    const points = Math.floor(Number(order.total) * Number(program.earnPointsPerMinor));
    if (points < 1) return null;
    const earned = await this.store.transaction(state => {
      const duplicate = this.transactions.repository.raw(state)
        .find(row => row.orderId === order.id && row.type === 'earned' && row.status === 'posted');
      if (duplicate) return duplicate;
      let account = this.accounts.repository.raw(state)
        .find(row => row.customerId === order.customerId && row.programId === program.id && !row.deletedAt);
      if (!account) account = this.accounts.repository.insert(state, { customerId: order.customerId, programId: program.id, pointsBalance: 0, metadata: {} });
      const transaction = this.transactions.repository.insert(state, {
        accountId: account.id,
        customerId: order.customerId,
        programId: program.id,
        orderId: order.id,
        type: 'earned',
        status: 'posted',
        points,
        amount: 0,
        currencyCode: order.currencyCode,
        reason: 'order_confirmed',
        metadata: {},
      });
      this.accounts.repository.patch(state, account.id, { pointsBalance: account.pointsBalance + points });
      return transaction;
    });
    await this.events.emit('loyalty.earned', { orderId: order.id, customerId: order.customerId, points, transaction: earned });
    return earned;
  }

  async adjust({ customerId, programId, points, reason }, ctx = null) {
    if (!Number.isInteger(Number(points)) || !Number(points)) throw ValidationError.single('points', 'El ajuste debe ser un entero distinto de cero.');
    const program = this.programs.repository.retrieve(programId);
    const account = await this.ensureAccount(customerId, programId);
    if (account.pointsBalance + Number(points) < 0) throw new ConflictError('El ajuste dejaría el saldo de puntos en negativo.');
    const transaction = await this.store.transaction(state => {
      const current = this.accounts.repository.retrieve(account.id);
      if (current.pointsBalance + Number(points) < 0) throw new ConflictError('El saldo cambió y ya no permite el ajuste.');
      const entry = this.transactions.repository.insert(state, {
        accountId: current.id, customerId, programId, type: 'adjustment', status: 'posted', points: Number(points),
        amount: 0, currencyCode: program.currencyCode, reason, metadata: {},
      });
      this.accounts.repository.patch(state, current.id, { pointsBalance: current.pointsBalance + Number(points) });
      return entry;
    });
    await this.events.emit('loyalty.adjusted', { transaction, actor: ctx?.actor?.id || null });
    return transaction;
  }

  async expireReservations() {
    const expired = this.transactions.repository.all({ status: 'reserved' })
      .filter(row => (toDate(row.expiresAt)?.getTime() ?? 0) <= Date.now());
    for (const row of expired) await this.releaseReservation({ cartId: row.cartId, customerId: row.customerId, reason: 'reservation_expired' });
    return { expired: expired.length };
  }
}

export default {
  name: 'loyalty',
  requires: ['store', 'events', 'audit', 'config', 'customFields', 'customer'],
  resources: [loyaltyProgramResource, loyaltyAccountResource, loyaltyTransactionResource],
  permissions: [
    { resource: 'loyaltyProgram', description: 'Programas de fidelización.' },
    { resource: 'loyaltyAccount', actions: ['read', 'update'], description: 'Saldos de fidelización.' },
    { resource: 'loyaltyTransaction', actions: ['read'], description: 'Libro mayor de puntos.' },
  ],

  register(deps) {
    const service = new LoyaltyService(deps);
    return { service, programs: service.programs, accounts: service.accounts, transactions: service.transactions };
  },

  async seed(module) {
    await module.programs.seed([{
      id: 'loyprog_ndivepa', code: 'ndivepa-rewards', name: 'Puntos Ndivepa', currencyCode: 'USD',
      earnPointsPerMinor: 0.01, redeemMinorPerPoint: 1, minRedeemPoints: 100, reservationMinutes: 30, active: true,
    }], 'id');
  },

  subscribers: container => [{
    event: 'order.confirmed',
    handler: ({ record }) => container.resolve('loyalty').service.earnForOrder(record),
  }],

  jobs: container => [{
    name: 'loyalty.expire-reservations',
    everyMs: 5 * 60_000,
    handler: () => container.resolve('loyalty').service.expireReservations(),
  }],

  routes: {
    admin: container => {
      const module = () => container.resolve('loyalty');
      return [
        ...crudRoutes(loyaltyProgramResource, () => module().programs, { tags: ['fidelización'] }),
        {
          method: 'GET', path: '/loyalty-accounts', permission: 'loyaltyAccount:read', bodyless: true,
          summary: 'Lista saldos de puntos con filtros y paginación.', tags: ['fidelización'],
          handler: ctx => module().accounts.list(ctx.query),
        },
        {
          method: 'GET', path: '/loyalty-transactions', permission: 'loyaltyTransaction:read', bodyless: true,
          summary: 'Consulta el libro mayor de fidelización.', tags: ['fidelización'],
          handler: ctx => module().transactions.list(ctx.query),
        },
        {
          method: 'POST', path: '/loyalty-accounts/adjust', permission: 'loyaltyAccount:update',
          summary: 'Añade o descuenta puntos dejando una transacción auditada.', tags: ['fidelización'],
          body: {
            customerId: rule.id({ required: true }), programId: rule.id({ required: true }),
            points: { type: 'integer', coerce: true, required: true, min: -1_000_000, max: 1_000_000 },
            reason: rule.text(300, { required: true }),
          },
          handler: ctx => module().service.adjust(ctx.body, ctx),
        },
      ];
    },
    store: container => [{
      method: 'GET', path: '/loyalty/me', permission: null, bodyless: true,
      summary: 'Devuelve los saldos de puntos del cliente autenticado.', tags: ['fidelización'],
      handler: ctx => {
        const customerId = container.resolve('customer').customers.customerFromRequest(ctx)?.id || null;
        if (!customerId) throw new ConflictError('Inicia sesión para consultar puntos.');
        return { accounts: container.resolve('loyalty').service.summaryForCustomer(customerId) };
      },
    }],
  },
};
