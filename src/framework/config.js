/**
 * Configuración y estrategias (M-0050 … M-0053, M-0051).
 *
 * Los valores llegan del entorno con valores por defecto tipados. Las
 * *estrategias* son puntos de extensión al estilo Vendure: cálculo de precio,
 * código de pedido, asignación de stock… se sustituyen sin tocar el dominio.
 */
import { NdivepaError } from './errors.js';

const SECRET_KEYS = /(secret|password|token|key|salt|hash|credential)/i;

function readNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function readBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function readList(value, fallback) {
  if (!value) return fallback;
  return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

export const COMMERCE_MODES = ['AFFILIATE', 'HYBRID', 'DIRECT'];

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const config = {
    nodeEnv,
    isProduction,
    port: readNumber(env.PORT, 4300),
    host: env.HOST || '0.0.0.0',
    publicBaseUrl: String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    defaultLocale: env.DEFAULT_LOCALE || 'es',
    supportedLocales: readList(env.SUPPORTED_LOCALES, ['es', 'en', 'pt']),
    timezone: env.TZ_DISPLAY || 'America/Asuncion',

    // El modo por defecto sigue siendo afiliado: el comercio directo se enciende a mano.
    commerceMode: COMMERCE_MODES.includes(env.COMMERCE_MODE) ? env.COMMERCE_MODE : 'AFFILIATE',

    log: { level: env.LOG_LEVEL || (isProduction ? 'info' : 'debug'), pretty: !isProduction },

    session: {
      cookieName: env.SESSION_COOKIE || 'ndivepa_session',
      ttlMs: readNumber(env.SESSION_TTL_MS, 12 * 3_600_000),
      secure: isProduction,
      absoluteTtlMs: readNumber(env.SESSION_ABSOLUTE_TTL_MS, 30 * 86_400_000),
    },

    security: {
      maxBodyBytes: readNumber(env.MAX_BODY_BYTES, 1_000_000),
      maxJsonDepth: readNumber(env.MAX_JSON_DEPTH, 24),
      maxUploadBytes: readNumber(env.MAX_UPLOAD_BYTES, 700_000),
      csrfCookie: 'ndivepa_csrf',
      csrfHeader: 'x-ndivepa-csrf',
      corsOrigins: readList(env.CORS_ORIGINS, []),
      passwordMinLength: readNumber(env.PASSWORD_MIN_LENGTH, 12),
      loginMaxAttempts: readNumber(env.LOGIN_MAX_ATTEMPTS, 10),
      loginLockMinutes: readNumber(env.LOGIN_LOCK_MINUTES, 15),
      scrypt: { keyLength: 64, cost: readNumber(env.SCRYPT_COST, 16384) },
      trustProxy: readBoolean(env.TRUST_PROXY, false),
    },

    rateLimits: {
      login: { windowMs: 15 * 60_000, max: readNumber(env.RATE_LOGIN_MAX, 10) },
      view: { windowMs: 60_000, max: readNumber(env.RATE_VIEW_MAX, 120) },
      click: { windowMs: 60_000, max: readNumber(env.RATE_CLICK_MAX, 60) },
      api: { windowMs: 60_000, max: readNumber(env.RATE_API_MAX, 600) },
      write: { windowMs: 60_000, max: readNumber(env.RATE_WRITE_MAX, 120) },
    },

    maintenance: {
      linkStaleDays: readNumber(env.LINK_STALE_DAYS, 14),
      priceStaleDays: readNumber(env.PRICE_STALE_DAYS, 30),
      cartTtlHours: readNumber(env.CART_TTL_HOURS, 72),
      reservationTtlMinutes: readNumber(env.RESERVATION_TTL_MINUTES, 60),
      attributionWindowDays: readNumber(env.ATTRIBUTION_WINDOW_DAYS, 30),
      lowStockThreshold: readNumber(env.LOW_STOCK_THRESHOLD, 5),
      returnWindowDays: readNumber(env.RETURN_WINDOW_DAYS, 30),
    },

    storage: {
      snapshotKeep: readNumber(env.SNAPSHOT_KEEP, 10),
      backupKeep: readNumber(env.BACKUP_KEEP, 20),
      writeDebounceMs: readNumber(env.WRITE_DEBOUNCE_MS, 0),
    },

    jobs: { enabled: readBoolean(env.JOBS_ENABLED, true), tickMs: readNumber(env.JOBS_TICK_MS, 30_000) },

    seed: { enabled: readBoolean(env.SEED_ENABLED, true) },

    initialAdmin: {
      email: String(env.INITIAL_ADMIN_EMAIL || 'admin@ndivepa.local').trim().toLowerCase(),
      // La contraseña conocida solo existe para desarrollo local y pruebas. Un
      // despliegue nuevo debe recibir una contraseña propia por el entorno.
      password: env.INITIAL_ADMIN_PASSWORD || (isProduction ? '' : 'Ndivepa2026!'),
    },

    features: {
      graphql: readBoolean(env.FEATURE_GRAPHQL, false),
      webhooks: readBoolean(env.FEATURE_WEBHOOKS, true),
      search: readBoolean(env.FEATURE_SEARCH, true),
      twoFactor: readBoolean(env.FEATURE_2FA, true),
    },
  };

  validateConfig(config);
  return config;
}

function validateConfig(config) {
  const problems = [];
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) problems.push('PORT debe ser un puerto válido.');
  if (config.publicBaseUrl && !/^https?:\/\//.test(config.publicBaseUrl)) problems.push('PUBLIC_BASE_URL debe empezar por http:// o https://.');
  if (config.isProduction && config.publicBaseUrl.startsWith('http://')) problems.push('En producción PUBLIC_BASE_URL debe usar HTTPS.');
  if (config.initialAdmin.password && config.initialAdmin.password.length < config.security.passwordMinLength) problems.push(`INITIAL_ADMIN_PASSWORD debe tener al menos ${config.security.passwordMinLength} caracteres.`);
  if (config.security.passwordMinLength < 12) problems.push('PASSWORD_MIN_LENGTH no puede bajar de 12.');
  if (!config.supportedLocales.includes(config.defaultLocale)) problems.push('DEFAULT_LOCALE debe estar en SUPPORTED_LOCALES.');
  if (problems.length) {
    // Configuración inválida detiene el arranque (M-0052): fallar aquí es más
    // barato que descubrirlo con tráfico real.
    throw new NdivepaError(`Configuración inválida: ${problems.join(' ')}`, { code: 'invalid_config', status: 500, details: { problems } });
  }
}

/** Copia imprimible sin secretos (M-0053). */
export function redactConfig(config) {
  const walk = value => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [key, SECRET_KEYS.test(key) ? '[oculto]' : walk(inner)]),
      );
    }
    return value;
  };
  return walk(config);
}

/**
 * Registro de estrategias sustituibles (M-0051, M-0307).
 * Cada clave tiene una implementación por defecto; un plugin puede reemplazarla.
 */
export class StrategyRegistry {
  constructor() {
    this.strategies = new Map();
  }

  register(name, implementation, { override = false } = {}) {
    if (this.strategies.has(name) && !override) {
      throw new NdivepaError(`La estrategia "${name}" ya está registrada.`, { code: 'strategy_conflict', status: 500 });
    }
    this.strategies.set(name, implementation);
    return this;
  }

  replace(name, implementation) {
    return this.register(name, implementation, { override: true });
  }

  get(name) {
    if (!this.strategies.has(name)) {
      throw new NdivepaError(`No hay estrategia registrada para "${name}".`, { code: 'strategy_missing', status: 500 });
    }
    return this.strategies.get(name);
  }

  has(name) {
    return this.strategies.has(name);
  }

  list() {
    return [...this.strategies.keys()].sort();
  }
}
