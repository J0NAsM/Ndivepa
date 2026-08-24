/**
 * Alertas operativas (M-0149, M-0452 … M-0454).
 *
 * Una alerta es una excepción que alguien debe revisar. Dos reglas que evitan que el
 * panel se llene de ruido:
 *  - una alerta del mismo tipo y entidad **no se duplica**: se incrementa su contador;
 *  - si el problema vuelve después de resolverse, la alerta **se reabre** (M-0454).
 */
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule } from '../../framework/validate.js';
import { now } from '../../framework/dates.js';

export const SEVERITIES = ['info', 'warning', 'critical'];

export const alertResource = defineResource({
  name: 'alert',
  collection: 'alerts',
  prefix: 'alert',
  route: 'alerts',
  searchable: ['message', 'type'],
  fields: {
    type: rule.text(80, { required: true }),
    severity: rule.enumOf(SEVERITIES, { default: 'warning' }),
    message: rule.text(600, { required: true }),
    entityId: rule.id(),
    entityType: rule.text(60),
    resolved: rule.flag({ default: false }),
    resolvedAt: rule.date(),
    resolvedBy: rule.id(),
    resolutionNote: rule.text(600),
    occurrences: { type: 'integer', coerce: true, min: 1, default: 1 },
    lastSeenAt: rule.date(),
    metadata: rule.metadata(),
  },
});

export class AlertService extends BaseService {
  constructor(deps) {
    super(deps, alertResource);
  }

  /** Punto único de entrada para cualquier módulo que detecte una excepción. */
  async raise({ type, severity = 'warning', message, entityId = null, entityType = null, metadata = {} }, ctx = null) {
    const existing = this.repository.all({ type, entityId }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];

    if (existing && !existing.resolved) {
      const result = await this.store.transaction(state => this.repository.patch(state, existing.id, {
        occurrences: (existing.occurrences || 1) + 1,
        lastSeenAt: now(),
        message,
        severity,
      }));
      return result.after;
    }

    if (existing?.resolved) {
      // Reapertura: el problema volvió después de darse por resuelto.
      const result = await this.store.transaction(state => this.repository.patch(state, existing.id, {
        resolved: false,
        resolvedAt: null,
        resolvedBy: null,
        resolutionNote: null,
        reopenedAt: now(),
        occurrences: (existing.occurrences || 1) + 1,
        lastSeenAt: now(),
        message,
        severity,
      }));
      await this.events.emit('alert.reopened', { id: existing.id, type });
      return result.after;
    }

    return this.create({ type, severity, message, entityId, entityType, metadata, lastSeenAt: now() }, ctx);
  }

  async resolve(alertId, note = null, ctx = null) {
    const result = await this.store.transaction(state => this.repository.patch(state, alertId, {
      resolved: true,
      resolvedAt: now(),
      resolvedBy: ctx?.actor?.id || null,
      resolutionNote: note,
    }));
    await this.emit('resolved', result.after, ctx);
    return result.after;
  }

  open({ severity = null } = {}) {
    return this.repository
      .all({ resolved: false, ...(severity ? { severity } : {}) })
      .sort((a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity));
  }

  summary() {
    const open = this.open();
    return {
      open: open.length,
      critical: open.filter(alert => alert.severity === 'critical').length,
      warning: open.filter(alert => alert.severity === 'warning').length,
      info: open.filter(alert => alert.severity === 'info').length,
      byType: open.reduce((acc, alert) => ({ ...acc, [alert.type]: (acc[alert.type] || 0) + 1 }), {}),
    };
  }
}

export default {
  name: 'alert',
  requires: ['store', 'events', 'audit', 'config', 'customFields'],
  resources: [alertResource],
  permissions: [{ resource: 'alert', description: 'Alertas operativas.' }],

  register(deps) {
    const service = new AlertService(deps);
    // El servicio se usa directamente por otros módulos, así que se devuelve plano
    // con los métodos de negocio en la raíz.
    service.alerts = service;
    return service;
  },

  routes: {
    admin: container => {
      const service = () => container.resolve('alert');
      return [
        ...crudRoutes(alertResource, () => service(), { tags: ['operación'] }),
        {
          method: 'POST',
          path: '/alerts/:id/resolve',
          permission: 'alert:update',
          summary: 'Marca una alerta como resuelta con una nota.',
          tags: ['operación'],
          body: { note: rule.text(600) },
          handler: ctx => service().resolve(ctx.params.id, ctx.body.note, ctx),
        },
        {
          method: 'GET',
          path: '/alerts/summary',
          permission: 'alert:read',
          summary: 'Resumen de alertas abiertas por severidad y tipo.',
          tags: ['operación'],
          bodyless: true,
          handler: () => service().summary(),
        },
      ];
    },
  },
};
