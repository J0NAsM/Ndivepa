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
  if (value === undefined || value === '') return fallback;
  const numeric = Number(value);
  // Un valor escrito pero inválido no debe degradarse silenciosamente al valor
  // por defecto: se conserva como NaN para que `validateConfig` detenga el arranque.
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function readBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  // Igual que con los números, un typo (`treu`) es configuración inválida.
  return null;
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
    host: String(env.HOST || '0.0.0.0').trim(),
    publicBaseUrl: String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    defaultLocale: env.DEFAULT_LOCALE || 'es',
    supportedLocales: readList(env.SUPPORTED_LOCALES, ['es', 'en', 'pt']),
    timezone: env.TZ_DISPLAY || 'America/Asuncion',

    // El modo por defecto sigue siendo afiliado: el comercio directo se enciende a mano.
    commerceMode: env.COMMERCE_MODE ? String(env.COMMERCE_MODE).trim().toUpperCase() : 'AFFILIATE',

    log: { level: env.LOG_LEVEL || (isProduction ? 'info' : 'debug'), pretty: !isProduction },

    session: {
      cookieName: env.SESSION_COOKIE || 'ndivepa_session',
      // La sesión de cliente de tienda es una credencial de cookie distinta de la
      // del panel. Tenerla nombrada aquí permite que el CSRF la reconozca en vez
      // de repetir la cadena literal en tres sitios del módulo de clientes.
      customerCookieName: env.CUSTOMER_SESSION_COOKIE || 'ndivepa_customer',
      ttlMs: readNumber(env.SESSION_TTL_MS, 12 * 3_600_000),
      secure: isProduction,
      absoluteTtlMs: readNumber(env.SESSION_ABSOLUTE_TTL_MS, 30 * 86_400_000),
    },

    security: {
      maxBodyBytes: readNumber(env.MAX_BODY_BYTES, 1_000_000),
      maxJsonDepth: readNumber(env.MAX_JSON_DEPTH, 24),
      maxUploadBytes: readNumber(env.MAX_UPLOAD_BYTES, 700_000),
      maxUrlLength: readNumber(env.MAX_URL_LENGTH, 8_192),
      maxQueryParams: readNumber(env.MAX_QUERY_PARAMS, 100),
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
      // Carpeta del documento y de los snapshots. Se puede mover para aislar una
      // instancia de prueba, un contenedor o un volumen distinto del repositorio.
      dataDir: env.DATA_DIR || null,
      // Sin valor propio, los snapshots viven en `backups/snapshots`; con `DATA_DIR`
      // pasan a `<DATA_DIR>/snapshots`, para que una instancia aislada no escriba
      // en las copias de la instalación principal.
      snapshotDir: env.SNAPSHOT_DIR || null,
      snapshotKeep: readNumber(env.SNAPSHOT_KEEP, 10),
      backupKeep: readNumber(env.BACKUP_KEEP, 20),
      writeDebounceMs: readNumber(env.WRITE_DEBOUNCE_MS, 0),
      // En producción el documento se guarda compacto: la sangría de dos espacios
      // multiplica por dos el fichero y el tiempo de escritura sin aportar nada
      // a un fichero que nadie lee a mano en un servidor.
      pretty: readBoolean(env.STORAGE_PRETTY, !isProduction),
    },

    jobs: { enabled: readBoolean(env.JOBS_ENABLED, true), tickMs: readNumber(env.JOBS_TICK_MS, 30_000) },

    http: {
      requestTimeoutMs: readNumber(env.REQUEST_TIMEOUT_MS, 30_000),
      headersTimeoutMs: readNumber(env.HEADERS_TIMEOUT_MS, 15_000),
      keepAliveTimeoutMs: readNumber(env.KEEP_ALIVE_TIMEOUT_MS, 5_000),
      shutdownGraceMs: readNumber(env.SHUTDOWN_GRACE_MS, 10_000),
    },

    discovery: {
      googleTrendsGeo: String(env.GOOGLE_TRENDS_GEO || 'PY').trim().toUpperCase(),
      timeoutMs: readNumber(env.DISCOVERY_TIMEOUT_MS, 10_000),
      cacheTtlMs: readNumber(env.DISCOVERY_CACHE_TTL_MS, 10 * 60_000),
    },

    seed: {
      enabled: readBoolean(env.SEED_ENABLED, true),
      // Los datos base (monedas, países, roles, categorías) se siembran siempre.
      // El catálogo afiliado de ejemplo, no: una instalación de producción no debe
      // arrancar con productos y comisiones inventados.
      demo: readBoolean(env.SEED_DEMO, !isProduction),
    },

    initialAdmin: {
      email: String(env.INITIAL_ADMIN_EMAIL || 'admin@ndivepa.local').trim().toLowerCase(),
      // La contraseña conocida solo existe para desarrollo local y pruebas. Un
      // despliegue nuevo debe recibir una contraseña propia por el entorno.
      password: env.INITIAL_ADMIN_PASSWORD || (isProduction ? '' : 'Ndivepa2026!'),
    },

    features: {
      graphql: readBoolean(env.FEATURE_GRAPHQL, true),
      webhooks: readBoolean(env.FEATURE_WEBHOOKS, true),
      search: readBoolean(env.FEATURE_SEARCH, true),
      twoFactor: readBoolean(env.FEATURE_2FA, true),
      trendDiscovery: readBoolean(env.FEATURE_TREND_DISCOVERY, true),
    },

    integrations: {
      payment: { provider: env.PAYMENT_PROVIDER || 'external', configured: Boolean(env.PAYMENT_API_KEY), webhookConfigured: Boolean(env.PAYMENT_WEBHOOK_SECRET) },
      smtp: { configured: Boolean(env.SMTP_URL), from: env.SMTP_FROM || null },
      storage: { configured: Boolean(env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY && env.S3_SECRET_KEY), cdnConfigured: Boolean(env.CDN_BASE_URL) },
      search: { provider: env.SEARCH_PROVIDER || null, configured: Boolean(env.SEARCH_API_KEY) },
      trends: { provider: 'google-trends-rss', configured: readBoolean(env.FEATURE_TREND_DISCOVERY, true) === true },
    },
  };

  validateConfig(config);
  return config;
}

function validateConfig(config) {
  const problems = [];
  const positiveInteger = (value, label, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
    if (!Number.isInteger(value) || value < min || value > max) problems.push(`${label} debe ser un entero entre ${min} y ${max}.`);
  };
  const positiveNumber = (value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    if (!Number.isFinite(value) || value < min || value > max) problems.push(`${label} debe ser un número entre ${min} y ${max}.`);
  };

  if (!['development', 'test', 'production'].includes(config.nodeEnv)) problems.push('NODE_ENV debe ser development, test o production.');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) problems.push('PORT debe ser un puerto válido.');
  if (!config.host || /[\s\r\n]/.test(config.host)) problems.push('HOST no puede estar vacío ni contener espacios.');
  if (!COMMERCE_MODES.includes(config.commerceMode)) problems.push(`COMMERCE_MODE debe ser uno de: ${COMMERCE_MODES.join(', ')}.`);
  if (config.publicBaseUrl) {
    try {
      const parsed = new URL(config.publicBaseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) problems.push('PUBLIC_BASE_URL debe usar http o https.');
      if (parsed.username || parsed.password || parsed.search || parsed.hash) problems.push('PUBLIC_BASE_URL no admite credenciales, consulta ni fragmento.');
    } catch {
      problems.push('PUBLIC_BASE_URL debe ser una URL absoluta válida.');
    }
  }
  if (config.isProduction && config.publicBaseUrl.startsWith('http://')) problems.push('En producción PUBLIC_BASE_URL debe usar HTTPS.');
  if (config.initialAdmin.password && config.initialAdmin.password.length < config.security.passwordMinLength) problems.push(`INITIAL_ADMIN_PASSWORD debe tener al menos ${config.security.passwordMinLength} caracteres.`);
  if (config.security.passwordMinLength < 12) problems.push('PASSWORD_MIN_LENGTH no puede bajar de 12.');
  if (!config.supportedLocales.length || config.supportedLocales.some(locale => !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale))) {
    problems.push('SUPPORTED_LOCALES debe contener códigos de idioma válidos y no estar vacío.');
  }
  if (new Set(config.supportedLocales).size !== config.supportedLocales.length) problems.push('SUPPORTED_LOCALES no puede contener duplicados.');
  if (!config.supportedLocales.includes(config.defaultLocale)) problems.push('DEFAULT_LOCALE debe estar en SUPPORTED_LOCALES.');
  try { new Intl.DateTimeFormat('es', { timeZone: config.timezone }).format(); } catch { problems.push('TZ_DISPLAY debe ser una zona horaria IANA válida.'); }

  positiveInteger(config.security.maxBodyBytes, 'MAX_BODY_BYTES', { min: 1_024, max: 50_000_000 });
  positiveInteger(config.security.maxUploadBytes, 'MAX_UPLOAD_BYTES', { min: 1_024, max: 20_000_000 });
  positiveInteger(config.security.maxJsonDepth, 'MAX_JSON_DEPTH', { min: 2, max: 64 });
  positiveInteger(config.security.maxUrlLength, 'MAX_URL_LENGTH', { min: 256, max: 65_536 });
  positiveInteger(config.security.maxQueryParams, 'MAX_QUERY_PARAMS', { min: 1, max: 1_000 });
  positiveInteger(config.security.passwordMinLength, 'PASSWORD_MIN_LENGTH', { min: 12, max: 200 });
  positiveInteger(config.security.loginMaxAttempts, 'LOGIN_MAX_ATTEMPTS', { min: 1, max: 100 });
  positiveNumber(config.security.loginLockMinutes, 'LOGIN_LOCK_MINUTES', { min: 1, max: 10_080 });
  positiveInteger(config.security.scrypt.cost, 'SCRYPT_COST', { min: 16_384, max: 65_536 });
  if (Number.isInteger(config.security.scrypt.cost) && (config.security.scrypt.cost & (config.security.scrypt.cost - 1)) !== 0) {
    problems.push('SCRYPT_COST debe ser una potencia de dos.');
  }
  if (![config.security.trustProxy, ...Object.values(config.features), config.jobs.enabled, config.seed.enabled, config.seed.demo, config.storage.pretty].every(value => typeof value === 'boolean')) {
    problems.push('Las variables booleanas deben usar true/false, 1/0, yes/no u on/off.');
  }
  positiveInteger(config.session.ttlMs, 'SESSION_TTL_MS', { min: 60_000, max: 31_536_000_000 });
  positiveInteger(config.session.absoluteTtlMs, 'SESSION_ABSOLUTE_TTL_MS', { min: 60_000, max: 31_536_000_000 });
  if (config.session.absoluteTtlMs < config.session.ttlMs) problems.push('SESSION_ABSOLUTE_TTL_MS no puede ser menor que SESSION_TTL_MS.');
  for (const [name, value] of Object.entries({ SESSION_COOKIE: config.session.cookieName, CUSTOMER_SESSION_COOKIE: config.session.customerCookieName, CSRF_COOKIE: config.security.csrfCookie })) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,80}$/.test(value)) problems.push(`${name} no es un nombre de cookie válido.`);
  }
  for (const [name, limit] of Object.entries(config.rateLimits)) {
    positiveInteger(limit.windowMs, `rateLimits.${name}.windowMs`, { min: 1_000, max: 86_400_000 });
    positiveInteger(limit.max, `rateLimits.${name}.max`, { min: 1, max: 1_000_000 });
  }
  positiveInteger(config.storage.snapshotKeep, 'SNAPSHOT_KEEP', { min: 1, max: 1_000 });
  positiveInteger(config.storage.backupKeep, 'BACKUP_KEEP', { min: 1, max: 10_000 });
  positiveNumber(config.storage.writeDebounceMs, 'WRITE_DEBOUNCE_MS', { min: 0, max: 60_000 });
  positiveInteger(config.jobs.tickMs, 'JOBS_TICK_MS', { min: 1_000, max: 86_400_000 });
  positiveInteger(config.http.requestTimeoutMs, 'REQUEST_TIMEOUT_MS', { min: 1_000, max: 600_000 });
  positiveInteger(config.http.headersTimeoutMs, 'HEADERS_TIMEOUT_MS', { min: 1_000, max: 600_000 });
  positiveInteger(config.http.keepAliveTimeoutMs, 'KEEP_ALIVE_TIMEOUT_MS', { min: 1_000, max: 120_000 });
  positiveInteger(config.http.shutdownGraceMs, 'SHUTDOWN_GRACE_MS', { min: 1_000, max: 120_000 });
  if (config.http.headersTimeoutMs > config.http.requestTimeoutMs) problems.push('HEADERS_TIMEOUT_MS no puede superar REQUEST_TIMEOUT_MS.');
  if (!/^[A-Z]{2}$/.test(config.discovery.googleTrendsGeo)) problems.push('GOOGLE_TRENDS_GEO debe ser un código ISO de dos letras.');
  positiveInteger(config.discovery.timeoutMs, 'DISCOVERY_TIMEOUT_MS', { min: 1_000, max: 60_000 });
  positiveInteger(config.discovery.cacheTtlMs, 'DISCOVERY_CACHE_TTL_MS', { min: 60_000, max: 86_400_000 });
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
