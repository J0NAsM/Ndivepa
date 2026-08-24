/**
 * Ajustes, tienda y monedas (M-0201 … M-0213).
 *
 * `commerceMode` es la pieza central: decide qué superficie de API se expone.
 * El modo por defecto es `AFFILIATE`, que mantiene la promesa del negocio —Ndivepa
 * no cobra al cliente— aunque el modelo de datos de comercio exista completo.
 */
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule, validate } from '../../framework/validate.js';
import { COMMERCE_MODES } from '../../framework/config.js';
import { ConflictError, NotAllowedError, ValidationError } from '../../framework/errors.js';
import { CURRENCY_DECIMALS, decimalsFor } from '../../framework/money.js';
import { now } from '../../framework/dates.js';

/** Capacidades que solo existen fuera del modo afiliado (M-0204). */
export const COMMERCE_CAPABILITIES = {
  cart: ['HYBRID', 'DIRECT'],
  checkout: ['HYBRID', 'DIRECT'],
  payment: ['HYBRID', 'DIRECT'],
  fulfillment: ['HYBRID', 'DIRECT'],
  order: ['HYBRID', 'DIRECT'],
  giftCard: ['HYBRID', 'DIRECT'],
  affiliate: ['AFFILIATE', 'HYBRID'],
};

export const currencyResource = defineResource({
  name: 'currency',
  collection: 'currencies',
  prefix: 'cur',
  route: 'currencies',
  unique: ['code'],
  searchable: ['code', 'name'],
  fields: {
    code: rule.currency({ required: true }),
    name: rule.text(80, { required: true }),
    symbol: rule.text(8, { required: true }),
    decimals: { type: 'integer', coerce: true, min: 0, max: 4 },
    symbolPosition: rule.enumOf(['before', 'after'], { default: 'before' }),
    rateToDefault: { type: 'number', coerce: true, min: 0 },
    rounding: { type: 'integer', coerce: true, min: 0, max: 1000, default: 0 },
    active: rule.flag({ default: true }),
    metadata: rule.metadata(),
  },
});

export const settingResource = defineResource({
  name: 'setting',
  collection: 'settingEntries',
  prefix: 'set',
  route: 'settings-store',
  unique: ['key'],
  searchable: ['key'],
  fields: {
    key: rule.text(120, { required: true }),
    scope: rule.enumOf(['global', 'channel', 'user'], { default: 'global' }),
    scopeId: rule.id(),
    value: { type: 'any' },
    description: rule.text(300),
  },
});

/** Ajustes globales validados. Es un singleton, no una colección. */
const STORE_SETTINGS_SCHEMA = {
  storeName: rule.text(120),
  legalName: rule.text(160),
  contactEmail: rule.email(),
  contactPhone: rule.text(40),
  defaultCurrency: rule.currency(),
  currencies: rule.list({ type: 'string' }),
  countries: rule.list({ type: 'string' }),
  defaultLocale: rule.text(10),
  locales: rule.list({ type: 'string' }),
  timezone: rule.text(60),
  commerceMode: rule.enumOf(COMMERCE_MODES),
  affiliateDisclosure: rule.text(600),
  privacyPolicyUrl: rule.text(300),
  analyticsConsentRequired: rule.flag(),
  seo: {
    type: 'object',
    shape: {
      titleSuffix: rule.text(80),
      defaultDescription: rule.text(300),
      defaultSocialImage: rule.text(300),
      robotsIndex: rule.flag(),
    },
  },
  order: {
    type: 'object',
    shape: {
      codePrefix: rule.text(8),
      returnWindowDays: { type: 'integer', coerce: true, min: 0, max: 365 },
      autoCompleteAfterDays: { type: 'integer', coerce: true, min: 0, max: 365 },
    },
  },
  inventory: {
    type: 'object',
    shape: {
      lowStockThreshold: { type: 'integer', coerce: true, min: 0 },
      allowBackorder: rule.flag(),
      hideOutOfStock: rule.flag(),
    },
  },
  affiliate: {
    type: 'object',
    shape: {
      linkStaleDays: { type: 'integer', coerce: true, min: 1, max: 365 },
      priceStaleDays: { type: 'integer', coerce: true, min: 1, max: 365 },
      attributionWindowDays: { type: 'integer', coerce: true, min: 1, max: 365 },
      requireValidLinkToPublish: rule.flag(),
    },
  },
  metadata: rule.metadata(),
};

export const DEFAULT_SETTINGS = {
  storeName: 'Ndivepa',
  legalName: '',
  contactEmail: '',
  contactPhone: '',
  defaultCurrency: 'USD',
  currencies: ['USD'],
  countries: ['Paraguay', 'Argentina', 'Brasil'],
  defaultLocale: 'es',
  locales: ['es'],
  timezone: 'America/Asuncion',
  commerceMode: 'AFFILIATE',
  affiliateDisclosure:
    'Algunos enlaces son enlaces de afiliado. Podemos recibir una comisión si realizas una compra, '
    + 'sin costo adicional para ti.',
  privacyPolicyUrl: '/privacidad.html',
  analyticsConsentRequired: true,
  seo: { titleSuffix: ' | Ndivepa', defaultDescription: '', defaultSocialImage: '', robotsIndex: true },
  order: { codePrefix: 'ND', returnWindowDays: 30, autoCompleteAfterDays: 30 },
  inventory: { lowStockThreshold: 5, allowBackorder: false, hideOutOfStock: false },
  affiliate: { linkStaleDays: 14, priceStaleDays: 30, attributionWindowDays: 30, requireValidLinkToPublish: true },
  metadata: {},
};

export class SettingsService {
  constructor({ store, events, audit, config }) {
    this.store = store;
    this.events = events;
    this.audit = audit;
    this.config = config;
  }

  /** Ajustes efectivos: los guardados sobre los valores por defecto. */
  all() {
    const stored = this.store.read().settings || {};
    return { ...DEFAULT_SETTINGS, ...stored, seo: { ...DEFAULT_SETTINGS.seo, ...(stored.seo || {}) } };
  }

  get(path, fallback = null) {
    const value = path.split('.').reduce((cursor, key) => (cursor === null || cursor === undefined ? undefined : cursor[key]), this.all());
    return value === undefined ? fallback : value;
  }

  /** Forma pública para la tienda: nunca expone ajustes internos. */
  publicView() {
    const settings = this.all();
    return {
      storeName: settings.storeName,
      defaultCurrency: settings.defaultCurrency,
      currencies: settings.currencies,
      countries: settings.countries,
      defaultLocale: settings.defaultLocale,
      locales: settings.locales,
      commerceMode: settings.commerceMode,
      affiliateDisclosure: settings.affiliateDisclosure,
      privacyPolicyUrl: settings.privacyPolicyUrl,
      analyticsConsentRequired: settings.analyticsConsentRequired,
      capabilities: this.capabilities(),
      // Compatibilidad con la SPA heredada, que leía `currency` (M-0174).
      currency: settings.defaultCurrency,
    };
  }

  capabilities() {
    const mode = this.mode();
    return Object.fromEntries(
      Object.entries(COMMERCE_CAPABILITIES).map(([capability, modes]) => [capability, modes.includes(mode)]),
    );
  }

  mode() {
    return this.get('commerceMode', this.config.commerceMode);
  }

  /** Puerta única para las capacidades de comercio (M-0204, M-0724). */
  assertCapability(capability) {
    const modes = COMMERCE_CAPABILITIES[capability];
    if (!modes) return true;
    const mode = this.mode();
    if (!modes.includes(mode)) throw new NotAllowedError(capability, mode);
    return true;
  }

  isEnabled(capability) {
    const modes = COMMERCE_CAPABILITIES[capability];
    return !modes || modes.includes(this.mode());
  }

  async update(input, ctx = null) {
    const changes = validate(input, STORE_SETTINGS_SCHEMA, { partial: true });
    const before = this.all();

    if (changes.commerceMode && changes.commerceMode !== before.commerceMode) {
      this.assertModeTransition(before.commerceMode, changes.commerceMode);
    }
    if (changes.currencies) {
      const target = changes.defaultCurrency || before.defaultCurrency;
      if (!changes.currencies.includes(target)) {
        throw ValidationError.single('currencies', `La moneda predeterminada ${target} debe estar en la lista.`);
      }
    }
    if (changes.defaultCurrency) {
      const list = changes.currencies || before.currencies;
      if (!list.includes(changes.defaultCurrency)) {
        throw ValidationError.single('defaultCurrency', 'La moneda predeterminada debe estar entre las soportadas.');
      }
    }
    if (changes.locales && changes.defaultLocale && !changes.locales.includes(changes.defaultLocale)) {
      throw ValidationError.single('defaultLocale', 'El idioma predeterminado debe estar entre los soportados.');
    }

    const after = await this.store.transaction(state => {
      state.settings = { ...state.settings, ...changes, updatedAt: now() };
      return { ...DEFAULT_SETTINGS, ...state.settings };
    });

    await this.events.emit('settings.updated', { before, after, changed: Object.keys(changes) });
    // Historial de cambios de ajustes con autor (M-0213).
    await this.audit?.record({ action: 'settings_updated', entity: 'settings', entityId: 'settings', before, after, ctx });
    return after;
  }

  /**
   * No se permite volver de `DIRECT`/`HYBRID` a `AFFILIATE` si hay pedidos vivos:
   * apagar el checkout dejando pedidos a medio pagar deja al cliente sin salida.
   */
  assertModeTransition(from, to) {
    if (!COMMERCE_MODES.includes(to)) throw ValidationError.single('commerceMode', `Modo no válido: ${to}.`);
    if (to !== 'AFFILIATE') return true;
    const live = (this.store.read().orders || []).filter(
      order => !['completed', 'cancelled', 'draft'].includes(order.status),
    );
    if (live.length) {
      throw new ConflictError(
        `No se puede volver al modo AFFILIATE: hay ${live.length} pedido(s) sin cerrar. Complétalos o cancélalos primero.`,
        { openOrders: live.length, from, to },
      );
    }
    return true;
  }
}

export class CurrencyService extends BaseService {
  constructor(deps) {
    super(deps, currencyResource);
    this.settings = deps.settings;
  }

  async beforeCreate(data) {
    // Los decimales de una moneda no son una preferencia: los fija la ISO-4217.
    return { ...data, decimals: data.decimals ?? decimalsFor(data.code) };
  }

  supported() {
    const codes = this.settings.get('currencies', ['USD']);
    return this.repository.all({ code: { $in: codes }, active: true });
  }

  byCode(code) {
    return this.repository.find({ code: String(code || '').toUpperCase() });
  }

  decimalsFor(code) {
    return this.byCode(code)?.decimals ?? decimalsFor(code);
  }

  /** Tipo de cambio manual. No consulta proveedores externos (M-0209). */
  rate(fromCode, toCode) {
    if (fromCode === toCode) return 1;
    const from = this.byCode(fromCode);
    const to = this.byCode(toCode);
    if (!from?.rateToDefault || !to?.rateToDefault) return null;
    return to.rateToDefault / from.rateToDefault;
  }
}

export class SettingStoreService extends BaseService {
  constructor(deps) {
    super(deps, settingResource);
  }

  value(key, { scope = 'global', scopeId = null } = {}) {
    return this.repository.find({ key, scope, scopeId })?.value ?? null;
  }

  async put(key, value, { scope = 'global', scopeId = null, ctx = null } = {}) {
    const existing = this.repository.find({ key, scope, scopeId });
    if (existing) return this.update(existing.id, { value }, ctx);
    return this.create({ key, value, scope, scopeId }, ctx);
  }
}

const SEED_CURRENCIES = [
  { code: 'USD', name: 'Dólar estadounidense', symbol: '$', symbolPosition: 'before', rateToDefault: 1, active: true },
  { code: 'PYG', name: 'Guaraní paraguayo', symbol: 'Gs', symbolPosition: 'before', rateToDefault: null, active: true },
  { code: 'BRL', name: 'Real brasileño', symbol: 'R$', symbolPosition: 'before', rateToDefault: null, active: true },
  { code: 'ARS', name: 'Peso argentino', symbol: '$', symbolPosition: 'before', rateToDefault: null, active: true },
  { code: 'EUR', name: 'Euro', symbol: '€', symbolPosition: 'after', rateToDefault: null, active: true },
];

export default {
  name: 'settings',
  requires: ['store', 'events', 'audit', 'config', 'customFields'],
  resources: [currencyResource, settingResource],
  permissions: [
    { resource: 'settings', actions: ['read', 'update'], description: 'Ajustes globales de la tienda.' },
    { resource: 'currency', description: 'Catálogo de monedas.' },
    { resource: 'setting', description: 'Almacén de configuración clave-valor.' },
  ],

  register(deps) {
    // Se devuelve el propio servicio de ajustes con los sub-servicios colgados y una
    // autorreferencia `settings`. Así `deps.settings.get(...)` funciona en cualquier
    // módulo y `module().settings.all()` sigue leyéndose bien en las rutas.
    const settings = new SettingsService(deps);
    settings.settings = settings;
    settings.currencies = new CurrencyService({ ...deps, settings });
    settings.entries = new SettingStoreService(deps);
    return settings;
  },

  async seed(service) {
    // `decimals` se rellena en `beforeCreate`, no se repite aquí.
    await service.currencies.seed(SEED_CURRENCIES.map(item => ({ ...item, decimals: CURRENCY_DECIMALS[item.code] ?? 2 })), 'code');
  },

  routes: {
    admin: container => {
      const module = () => container.resolve('settings');
      return [
        {
          method: 'GET',
          path: '/settings',
          permission: 'settings:read',
          summary: 'Ajustes globales completos.',
          tags: ['settings'],
          bodyless: true,
          handler: () => module().settings.all(),
        },
        {
          method: 'PATCH',
          path: '/settings',
          permission: 'settings:update',
          summary: 'Actualiza los ajustes globales.',
          tags: ['settings'],
          body: STORE_SETTINGS_SCHEMA,
          handler: ctx => module().settings.update(ctx.body, ctx),
        },
        {
          method: 'GET',
          path: '/settings/capabilities',
          permission: 'settings:read',
          summary: 'Capacidades habilitadas por el modo de comercio.',
          tags: ['settings'],
          bodyless: true,
          handler: () => ({ mode: module().settings.mode(), capabilities: module().settings.capabilities() }),
        },
        ...crudRoutes(currencyResource, () => module().currencies, { tags: ['settings'] }),
        ...crudRoutes(settingResource, () => module().entries, { permissionResource: 'setting', tags: ['settings'] }),
      ];
    },
    store: container => {
      const module = () => container.resolve('settings');
      return [
        {
          method: 'GET',
          path: '/store-config',
          permission: null,
          summary: 'Configuración pública de la tienda.',
          tags: ['store'],
          bodyless: true,
          handler: () => module().settings.publicView(),
        },
        {
          method: 'GET',
          path: '/currencies',
          permission: null,
          summary: 'Monedas soportadas.',
          tags: ['store'],
          bodyless: true,
          handler: () => ({ data: module().currencies.supported(), count: module().currencies.supported().length }),
        },
      ];
    },
  },
};
