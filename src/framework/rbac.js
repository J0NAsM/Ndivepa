/**
 * Permisos (M-0096 … M-0099, M-0242, M-0306).
 *
 * El monolito solo distinguía `role === 'admin'`: todo o nada. Aquí un permiso es
 * `recurso:acción` (`product:update`), admite comodines (`product:*`, `*`) y se
 * puede acotar por canal, para que un operador de marketplace no vea otro canal.
 */
import { ForbiddenError } from './errors.js';

export const ACTIONS = ['read', 'create', 'update', 'delete', 'manage'];

export class PermissionRegistry {
  constructor() {
    this.resources = new Map();
  }

  /** Declara un recurso y las acciones que admite. Genera sus permisos (M-0280). */
  declare(resource, { actions = ACTIONS, description = '' } = {}) {
    this.resources.set(resource, { actions, description });
    return this;
  }

  all() {
    const permissions = [];
    for (const [resource, definition] of this.resources) {
      for (const action of definition.actions) permissions.push(`${resource}:${action}`);
    }
    return permissions.sort();
  }

  catalog() {
    return [...this.resources.entries()]
      .map(([resource, definition]) => ({ resource, ...definition }))
      .sort((a, b) => a.resource.localeCompare(b.resource));
  }

  exists(permission) {
    if (permission === '*') return true;
    const [resource, action] = String(permission).split(':');
    const definition = this.resources.get(resource);
    if (!definition) return false;
    return action === '*' || definition.actions.includes(action);
  }
}

/** Roles predefinidos (M-0243). Se siembran una vez y luego se editan desde el panel. */
export const DEFAULT_ROLES = [
  { code: 'superadmin', name: 'Superadministración', permissions: ['*'], protected: true },
  {
    code: 'operator',
    name: 'Operación',
    permissions: [
      'order:*', 'cart:read', 'customer:*', 'payment:*', 'fulfillment:*', 'return:*',
      'exchange:*', 'claim:*', 'refund:*', 'inventory:*', 'alert:*', 'notification:read',
    ],
  },
  {
    code: 'catalog_editor',
    name: 'Edición de catálogo',
    permissions: [
      'product:*', 'variant:*', 'collection:*', 'category:*', 'facet:*', 'tag:*', 'asset:*',
      'pricing:*', 'priceList:*', 'content:*', 'affiliateLink:read', 'affiliateLink:update',
    ],
  },
  {
    code: 'affiliate_manager',
    name: 'Gestión de afiliación',
    permissions: [
      'merchant:*', 'network:*', 'program:*', 'affiliateLink:*', 'conversion:*',
      'commission:*', 'payout:*', 'campaign:*', 'placement:*', 'alert:*',
    ],
  },
  { code: 'support', name: 'Soporte', permissions: ['order:read', 'customer:read', 'customer:update', 'return:*', 'claim:*'] },
  { code: 'analyst', name: 'Analítica', permissions: ['analytics:read', 'order:read', 'product:read', 'conversion:read', 'commission:read'] },
];

export class Rbac {
  constructor({ registry = new PermissionRegistry(), logger } = {}) {
    this.registry = registry;
    this.logger = logger;
  }

  /** Expande roles a un conjunto plano de permisos, resolviendo herencia (M-0097). */
  expand(roles = [], allRoles = []) {
    const byCode = new Map(allRoles.map(role => [role.code || role.id, role]));
    const permissions = new Set();
    const visit = (code, depth = 0) => {
      if (depth > 8) return;
      const role = byCode.get(code);
      if (!role) return;
      for (const permission of role.permissions || []) permissions.add(permission);
      for (const parent of role.inherits || []) visit(parent, depth + 1);
    };
    for (const role of roles) visit(typeof role === 'string' ? role : role.code || role.id);
    return permissions;
  }

  /** ¿El conjunto de permisos cubre el requerido? */
  allows(granted, required) {
    if (!required) return true;
    const set = granted instanceof Set ? granted : new Set(granted || []);
    if (set.has('*')) return true;
    if (set.has(required)) return true;
    const [resource, action] = String(required).split(':');
    return set.has(`${resource}:*`) || set.has(`*:${action}`) || set.has(`${resource}:manage`);
  }

  assert(actor, required) {
    if (!required) return true;
    const granted = actor?.permissions instanceof Set ? actor.permissions : new Set(actor?.permissions || []);
    if (this.allows(granted, required)) return true;
    throw new ForbiddenError(`Falta el permiso "${required}" para esta operación.`, required);
  }

  /** Alcance por canal para operadores de marketplace (M-0099). */
  assertChannel(actor, channelId) {
    if (!channelId) return true;
    const scope = actor?.channelScope;
    if (!scope || !scope.length) return true;
    if (scope.includes(channelId)) return true;
    throw new ForbiddenError('Tu cuenta no tiene acceso a este canal de venta.');
  }

  /** ¿Es superadministración? Se registra para auditar su uso (M-0098). */
  isSuperAdmin(actor) {
    const granted = actor?.permissions instanceof Set ? actor.permissions : new Set(actor?.permissions || []);
    return granted.has('*');
  }
}
