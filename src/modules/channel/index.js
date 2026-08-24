/**
 * Canales de venta y vendedores (M-0229 … M-0239).
 *
 * Un **canal** es el equivalente a `sales-channel` de Medusa y a `channel` de
 * Vendure: decide qué catálogo se ve, con qué precios y con qué inventario. Un
 * **vendedor** (marketplace) se asocia a un canal y recibe su parte del pedido.
 */
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule } from '../../framework/validate.js';
import { ConflictError, UnauthorizedError } from '../../framework/errors.js';
import { token as generateToken } from '../../framework/ids.js';
import { mask, safeEqual } from '../../framework/strings.js';
import { distribute, percentage } from '../../framework/money.js';

export const channelResource = defineResource({
  name: 'channel',
  collection: 'channels',
  prefix: 'chan',
  route: 'channels',
  unique: ['code'],
  searchable: ['name', 'code'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(100, { required: true }),
    description: rule.text(300),
    type: rule.enumOf(['web', 'marketplace', 'social', 'affiliate', 'pos', 'api'], { default: 'web' }),
    defaultCurrencyCode: rule.currency(),
    defaultRegionId: rule.id(),
    defaultStockLocationId: rule.id(),
    sellerId: rule.id(),
    // Token público de solo lectura para la API de tienda (M-0234).
    publishableKey: rule.text(120),
    priceMultiplier: { type: 'number', coerce: true, min: 0.01, max: 100, default: 1 },
    isDefault: rule.flag({ default: false }),
    isAdmin: rule.flag({ default: false }),
    active: rule.flag({ default: true }),
    metadata: rule.metadata(),
  },
});

export const sellerResource = defineResource({
  name: 'seller',
  collection: 'sellers',
  prefix: 'sell',
  route: 'sellers',
  unique: ['code'],
  searchable: ['name', 'code', 'contactEmail'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(120, { required: true }),
    legalName: rule.text(160),
    taxId: rule.text(40),
    contactEmail: rule.email(),
    contactPhone: rule.text(40),
    website: rule.url(),
    // Comisión que retiene la plataforma sobre las ventas del vendedor (M-0238).
    commissionPercent: rule.percent({ default: 0 }),
    commissionFlat: rule.minor({ default: 0 }),
    payoutCurrency: rule.currency(),
    status: rule.enumOf(['pending', 'active', 'suspended'], { default: 'pending' }),
    metadata: rule.metadata(),
  },
});

export class ChannelService extends BaseService {
  constructor(deps) {
    super(deps, channelResource);
  }

  async beforeCreate(data) {
    if (data.isDefault) await this.clearDefault();
    return { ...data, publishableKey: data.publishableKey || `pk_${generateToken(24)}` };
  }

  async beforeUpdate(existing, changes) {
    if (changes.isDefault) await this.clearDefault(existing.id);
    // La clave publicable no se cambia por un PATCH cualquiera: hay una ruta para rotarla.
    delete changes.publishableKey;
    return changes;
  }

  async clearDefault(exceptId = null) {
    const current = this.repository.all({ isDefault: true }).filter(row => row.id !== exceptId);
    if (!current.length) return;
    await this.store.transaction(state => {
      for (const row of current) this.repository.patch(state, row.id, { isDefault: false });
    });
  }

  default() {
    return this.repository.find({ isDefault: true, active: true }) || this.repository.all({ active: true })[0] || null;
  }

  byCode(code) {
    return this.repository.find({ code });
  }

  /** Resuelve el canal a partir de la clave publicable de la petición. */
  byPublishableKey(key) {
    if (!key) return null;
    return this.repository.all({ active: true }).find(channel => safeEqual(channel.publishableKey, key)) || null;
  }

  async rotateKey(channelId, ctx = null) {
    const updated = await this.store.transaction(state => this.repository.patch(state, channelId, { publishableKey: `pk_${generateToken(24)}` }));
    await this.emit('key_rotated', updated.after, ctx);
    return { id: updated.after.id, publishableKey: updated.after.publishableKey };
  }

  /** Vista pública: la clave se enmascara para no filtrarla en listados. */
  publicView(channel) {
    if (!channel) return null;
    return {
      id: channel.id,
      code: channel.code,
      name: channel.name,
      type: channel.type,
      defaultCurrencyCode: channel.defaultCurrencyCode,
      defaultRegionId: channel.defaultRegionId,
      publishableKeyPreview: mask(channel.publishableKey || '', 8),
    };
  }

  async beforeDelete(record) {
    if (record.isDefault) throw new ConflictError('No se puede borrar el canal predeterminado.');
  }
}

export class SellerService extends BaseService {
  constructor(deps) {
    super(deps, sellerResource);
  }

  active() {
    return this.repository.all({ status: 'active' });
  }

  /**
   * Divide un pedido por vendedor (M-0237).
   * El envío se reparte proporcionalmente al subtotal de cada vendedor, que es el
   * criterio que menos discusiones genera en una conciliación.
   */
  splitOrder(order, resolveSeller) {
    const groups = new Map();
    for (const item of order.items || []) {
      const sellerId = resolveSeller(item) || null;
      if (!groups.has(sellerId)) groups.set(sellerId, { sellerId, items: [], subtotal: 0 });
      const group = groups.get(sellerId);
      group.items.push(item);
      group.subtotal += Number(item.total || 0);
    }

    const list = [...groups.values()];
    const shippingShares = distribute(Number(order.shippingTotal || 0), list.map(group => group.subtotal));

    return list.map((group, index) => {
      const seller = group.sellerId ? this.repository.byId(group.sellerId) : null;
      const shipping = shippingShares[index];
      const gross = group.subtotal + shipping;
      const commission = seller
        ? percentage(group.subtotal, seller.commissionPercent || 0) + Number(seller.commissionFlat || 0)
        : 0;
      return {
        sellerId: group.sellerId,
        sellerName: seller?.name || 'Tienda propia',
        items: group.items.map(item => item.id),
        subtotal: group.subtotal,
        shipping,
        total: gross,
        platformCommission: commission,
        sellerPayout: gross - commission,
      };
    });
  }
}

export default {
  name: 'channel',
  requires: ['store', 'events', 'audit', 'config', 'customFields'],
  resources: [channelResource, sellerResource],
  permissions: [
    { resource: 'channel', description: 'Canales de venta.' },
    { resource: 'seller', description: 'Vendedores del marketplace.' },
  ],

  register(deps) {
    return { channels: new ChannelService(deps), sellers: new SellerService(deps) };
  },

  async seed(service) {
    await service.channels.seed([
      {
        id: 'chan_web',
        code: 'web',
        name: 'Sitio web',
        type: 'web',
        defaultCurrencyCode: 'USD',
        defaultRegionId: 'reg_py',
        isDefault: true,
        active: true,
        publishableKey: `pk_${generateToken(24)}`,
      },
      {
        id: 'chan_admin',
        code: 'admin',
        name: 'Administración',
        type: 'api',
        defaultCurrencyCode: 'USD',
        isAdmin: true,
        active: true,
        publishableKey: `pk_${generateToken(24)}`,
      },
    ], 'id');
  },

  routes: {
    admin: container => {
      const module = () => container.resolve('channel');
      return [
        ...crudRoutes(channelResource, () => module().channels, { tags: ['canales'] }),
        ...crudRoutes(sellerResource, () => module().sellers, { tags: ['canales'] }),
        {
          method: 'POST',
          path: '/channels/:id/rotate-key',
          permission: 'channel:update',
          summary: 'Genera una clave publicable nueva para el canal.',
          tags: ['canales'],
          handler: ctx => module().channels.rotateKey(ctx.params.id, ctx),
        },
        {
          method: 'GET',
          path: '/sellers/:id/settlement',
          permission: 'seller:read',
          summary: 'Liquidación estimada del vendedor sobre los pedidos confirmados.',
          tags: ['canales'],
          bodyless: true,
          handler: ctx => {
            const seller = module().sellers.repository.retrieve(ctx.params.id);
            const orders = container.resolve('store').collection('orders')
              .filter(order => (order.sellerBreakdown || []).some(entry => entry.sellerId === seller.id));
            const rows = orders.flatMap(order => (order.sellerBreakdown || [])
              .filter(entry => entry.sellerId === seller.id)
              .map(entry => ({ orderId: order.id, code: order.code, ...entry })));
            return {
              sellerId: seller.id,
              orders: rows.length,
              gross: rows.reduce((sum, row) => sum + row.total, 0),
              commission: rows.reduce((sum, row) => sum + row.platformCommission, 0),
              payout: rows.reduce((sum, row) => sum + row.sellerPayout, 0),
              currency: seller.payoutCurrency || 'USD',
              rows,
            };
          },
        },
      ];
    },
    store: container => [
      {
        method: 'GET',
        path: '/channel',
        permission: null,
        summary: 'Canal resuelto para la petición actual.',
        tags: ['store'],
        bodyless: true,
        handler: ctx => {
          const channels = container.resolve('channel').channels;
          const channel = ctx.channelId ? channels.repository.byId(ctx.channelId) : channels.default();
          return channels.publicView(channel);
        },
      },
    ],
  },

  /** Autenticador de canal: traduce `X-Publishable-Key` en `ctx.channelId` (M-0902). */
  channelAuthenticator: container => ctx => {
    const key = ctx.req.headers['x-publishable-key'] || ctx.query.publishableKey;
    if (!key) return null;
    const channel = container.resolve('channel').channels.byPublishableKey(String(key));
    if (!channel) throw new UnauthorizedError('La clave de canal no es válida.');
    return { channelId: channel.id };
  },
};
