/**
 * Notificaciones (M-0114, M-0115).
 *
 * Regla del proyecto: **sin proveedor de correo autorizado no se envía nada**. El
 * proveedor local registra la notificación con su plantilla resuelta, de modo que el
 * flujo completo (pedido confirmado, devolución aprobada, aviso de stock) queda
 * probado y listo, y el día que exista un proveedor solo se registra otro.
 */
import { id as generateId } from './ids.js';
import { now } from './dates.js';

export const CHANNELS = ['log', 'email', 'sms', 'webhook', 'inapp'];

/** Plantillas del sistema. El texto es el mínimo verificable, sin promesas comerciales. */
export const TEMPLATES = {
  'order.confirmed': {
    channel: 'email',
    subject: 'Pedido {code} confirmado',
    body: 'Hemos registrado tu pedido {code} por un total de {total}. Puedes consultarlo con ese código.',
  },
  'order.cancelled': {
    channel: 'email',
    subject: 'Pedido {code} cancelado',
    body: 'El pedido {code} ha sido cancelado. Motivo registrado: {reason}.',
  },
  'order.shipped': {
    channel: 'email',
    subject: 'Pedido {code} enviado',
    body: 'El pedido {code} salió con {carrier}. Seguimiento: {tracking}.',
  },
  'return.requested': {
    channel: 'email',
    subject: 'Devolución solicitada para {code}',
    body: 'Recibimos tu solicitud de devolución del pedido {code}. Está pendiente de revisión.',
  },
  'return.approved': {
    channel: 'email',
    subject: 'Devolución aprobada para {code}',
    body: 'La devolución del pedido {code} fue aprobada. Importe a reembolsar: {amount}.',
  },
  'customer.verify': {
    channel: 'email',
    subject: 'Verifica tu correo',
    body: 'Usa este código para verificar tu correo: {token}. Caduca en 24 horas.',
  },
  'customer.reset': {
    channel: 'email',
    subject: 'Restablecer contraseña',
    body: 'Usa este código para definir una contraseña nueva: {token}. Caduca en 1 hora.',
  },
  'user.invited': {
    channel: 'email',
    subject: 'Invitación a la administración de {store}',
    body: 'Te invitaron a administrar {store}. Código de invitación: {token}.',
  },
  'inventory.low': {
    channel: 'inapp',
    subject: 'Stock bajo en {sku}',
    body: 'Quedan {available} unidades de {sku} en {location}, por debajo del umbral {threshold}.',
  },
  'cart.abandoned': {
    channel: 'email',
    subject: 'Tu selección sigue disponible',
    body: 'Guardamos tu selección de {items} artículo(s). Puedes retomarla cuando quieras.',
  },
  'link.invalid': {
    channel: 'inapp',
    subject: 'Enlace afiliado con problemas',
    body: 'El enlace de {product} está marcado como {status}: {reason}.',
  },
  'price.stale': {
    channel: 'inapp',
    subject: 'Precio sin verificar en {product}',
    body: 'El precio de {product} se verificó hace {days} días. Revísalo antes de destacarlo.',
  },
  'commission.unpaid': {
    channel: 'inapp',
    subject: 'Comisión aprobada sin pago',
    body: 'La comisión {id} está aprobada desde hace {days} días y sigue sin registrarse el pago.',
  },
};

export class LogNotificationProvider {
  constructor({ logger } = {}) {
    this.name = 'local';
    this.logger = logger;
  }

  /** No envía: registra. Es deliberado, no una limitación temporal sin resolver. */
  async send(notification) {
    this.logger?.info('Notificación registrada (sin proveedor de envío)', {
      template: notification.template,
      channel: notification.channel,
      to: notification.to,
    });
    return { delivered: false, reason: 'sin_proveedor_configurado' };
  }
}

export class NotificationService {
  constructor({ store, logger, collection = 'notifications', providers = {}, defaultProvider = 'local', limit = 1000 } = {}) {
    this.store = store;
    this.logger = logger;
    this.collection = collection;
    this.providers = new Map(Object.entries(providers));
    this.defaultProvider = defaultProvider;
    this.limit = limit;
    if (!this.providers.size) this.providers.set('local', new LogNotificationProvider({ logger }));
  }

  registerProvider(name, provider) {
    this.providers.set(name, provider);
    return this;
  }

  render(template, data = {}) {
    const definition = TEMPLATES[template];
    if (!definition) return { channel: 'log', subject: template, body: JSON.stringify(data) };
    const fill = text => text.replace(/\{(\w+)\}/g, (match, key) => (data[key] !== undefined ? String(data[key]) : match));
    return { channel: definition.channel, subject: fill(definition.subject), body: fill(definition.body) };
  }

  /**
   * Registra y entrega una notificación.
   * @param {{template:string, to?:string, data?:object, provider?:string, entityId?:string}} input
   */
  async send({ template, to = null, data = {}, provider = this.defaultProvider, entityId = null }) {
    const rendered = this.render(template, data);
    const notification = {
      id: generateId('notif'),
      template,
      to,
      entityId,
      provider,
      ...rendered,
      data,
      status: 'pending',
      deliveredAt: null,
      error: null,
      createdAt: now(),
    };

    const implementation = this.providers.get(provider) || this.providers.get('local');
    try {
      const result = await implementation.send(notification);
      notification.status = result?.delivered ? 'delivered' : 'registered';
      notification.deliveredAt = result?.delivered ? now() : null;
      notification.error = result?.delivered ? null : result?.reason || null;
    } catch (error) {
      notification.status = 'failed';
      notification.error = error.message;
    }

    await this.store.transaction(state => {
      if (!Array.isArray(state[this.collection])) state[this.collection] = [];
      state[this.collection].unshift(notification);
      if (state[this.collection].length > this.limit) state[this.collection].length = this.limit;
    });

    return notification;
  }

  list({ limit = 50, template = null, status = null } = {}) {
    return this.store
      .collection(this.collection)
      .filter(row => (!template || row.template === template) && (!status || row.status === status))
      .slice(0, limit);
  }

  catalog() {
    return { templates: Object.keys(TEMPLATES).sort(), providers: [...this.providers.keys()], channels: CHANNELS };
  }
}
