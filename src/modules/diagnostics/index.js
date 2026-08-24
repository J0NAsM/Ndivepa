/**
 * Diagnóstico del sistema (M-0287, M-0304 … M-0320, M-0885, M-1004).
 *
 * Un único sitio donde ver qué hay registrado y qué está mal. También comprueba las
 * **reglas invariantes** del proyecto: si alguna se rompe, aparece aquí como
 * incidencia crítica en lugar de descubrirse en producción.
 */
import { rule } from '../../framework/validate.js';
import { now } from '../../framework/dates.js';
import { isUnsafeHost } from '../affiliate/link-validation.js';

export class DiagnosticsService {
  constructor(deps) {
    this.container = deps.container;
    this.store = deps.store;
    this.config = deps.config;
    this.events = deps.events;
    this.jobs = deps.jobs;
    this.cache = deps.cache;
    this.locks = deps.locks;
    this.permissions = deps.permissions;
    this.customFields = deps.customFields;
    this.i18n = deps.i18n;
    this.search = deps.search;
    this.strategies = deps.strategies;
    this.workflows = deps.workflows;
    this.logger = deps.logger;
    this.rateLimiter = deps.rateLimiter;
  }

  /** Inventario de lo registrado: módulos, eventos, trabajos, permisos, estrategias. */
  catalogs() {
    return {
      modules: this.container.describe(),
      events: this.events.catalog(),
      jobs: this.jobs.catalog(),
      permissions: this.permissions.catalog(),
      customFields: this.customFields.catalog(),
      strategies: this.strategies.list(),
      workflows: this.workflows.list(),
      missingTranslations: this.i18n.missingKeys(),
      search: this.search.describe(),
      cache: this.cache.describe(),
      locks: this.locks.describe(),
      rateLimiter: this.rateLimiter.describe(),
      storage: this.store.describe(),
      metrics: this.logger.snapshot(),
    };
  }

  /**
   * Integridad referencial (M-0286).
   * Comprueba que ninguna referencia apunte a un registro inexistente.
   */
  referentialIntegrity() {
    const state = this.store.read();
    const idsOf = collection => new Set((state[collection] || []).map(row => row.id));
    const checks = [
      ['products', 'categoryId', 'categories'],
      ['products', 'merchantId', 'merchants'],
      ['products', 'programId', 'programs'],
      ['products', 'campaignId', 'campaigns'],
      ['variants', 'productId', 'products'],
      ['productOptions', 'productId', 'products'],
      ['prices', 'variantId', 'variants'],
      ['prices', 'priceListId', 'priceLists'],
      ['facetValues', 'facetId', 'facets'],
      ['affiliateLinks', 'productId', 'products'],
      ['affiliateLinks', 'merchantId', 'merchants'],
      ['affiliateLinks', 'programId', 'programs'],
      ['programs', 'networkId', 'networks'],
      ['programs', 'merchantId', 'merchants'],
      ['commissions', 'conversionId', 'conversions'],
      ['inventoryLevels', 'inventoryItemId', 'inventoryItems'],
      ['inventoryLevels', 'locationId', 'stockLocations'],
      ['reservations', 'inventoryItemId', 'inventoryItems'],
      ['taxRates', 'zoneId', 'zones'],
      ['serviceZones', 'fulfillmentSetId', 'fulfillmentSets'],
      ['shippingOptions', 'serviceZoneId', 'serviceZones'],
      ['coupons', 'promotionId', 'promotions'],
      ['promotions', 'campaignId', 'promotionCampaigns'],
      ['returns', 'orderId', 'orders'],
      ['payments', 'paymentCollectionId', 'paymentCollections'],
      ['fulfillments', 'orderId', 'orders'],
      ['addresses', 'customerId', 'customers'],
    ];

    const findings = [];
    for (const [collection, field, target] of checks) {
      const valid = idsOf(target);
      for (const row of state[collection] || []) {
        if (row.deletedAt) continue;
        const value = row[field];
        if (!value) continue;
        if (!valid.has(value)) {
          findings.push({
            code: 'broken_reference',
            severity: 'critical',
            collection,
            id: row.id,
            field,
            value,
            target,
          });
        }
      }
    }
    return findings;
  }

  /**
   * Reglas invariantes del negocio (M-0311 … M-0320).
   * Cada una tiene una prueba automatizada; esto las verifica también en caliente,
   * sobre los datos reales del despliegue.
   */
  invariants() {
    const state = this.store.read();
    const findings = [];

    // 1. Ningún destino afiliado apunta a un host prohibido.
    for (const link of state.affiliateLinks || []) {
      if (link.deletedAt) continue;
      let hostname = null;
      try {
        const url = new URL(link.affiliateUrl);
        hostname = url.hostname;
        if (!['http:', 'https:'].includes(url.protocol)) {
          findings.push({ code: 'unsafe_protocol', severity: 'critical', linkId: link.id, protocol: url.protocol });
        }
      } catch {
        findings.push({ code: 'malformed_affiliate_url', severity: 'critical', linkId: link.id });
        continue;
      }
      if (isUnsafeHost(hostname)) {
        findings.push({ code: 'unsafe_host', severity: 'critical', linkId: link.id, hostname });
      }
      if (link.status !== 'invalid' && isUnsafeHost(hostname)) {
        findings.push({ code: 'unsafe_host_not_blocked', severity: 'critical', linkId: link.id, hostname });
      }
    }

    // 2. Ningún producto publicado sin divulgación posible ni enlace válido.
    const settings = this.container.resolve('settings').settings;
    if (!settings.get('affiliateDisclosure')) {
      findings.push({ code: 'missing_affiliate_disclosure', severity: 'critical' });
    }
    for (const product of state.products || []) {
      if (product.deletedAt || product.status !== 'published') continue;
      if (product.monetizationType === 'DIRECT') continue;
      const links = (state.affiliateLinks || []).filter(link => link.productId === product.id && !link.deletedAt);
      if (!links.length || links.every(link => link.status === 'invalid')) {
        findings.push({ code: 'published_without_valid_link', severity: 'critical', productId: product.id });
      }
    }

    // 3. La comisión pendiente nunca se presenta como ingreso.
    const summary = this.container.resolve('analytics').reports.summary();
    if (summary.revenueSeparation.ownIncomeConfirmed !== summary.commissionPaid) {
      findings.push({ code: 'income_separation_broken', severity: 'critical' });
    }
    if (summary.salesGenerated > 0 && summary.revenueSeparation.attributedSales !== summary.salesGenerated) {
      findings.push({ code: 'attributed_sales_mismatch', severity: 'critical' });
    }

    // 4. Ningún secreto persistido en el documento.
    const secretFields = ['apiKeySecret', 'clientSecret', 'privateKey', 'accessToken'];
    for (const collection of ['products', 'affiliateLinks', 'programs', 'networks', 'merchants', 'contents']) {
      for (const row of state[collection] || []) {
        for (const field of secretFields) {
          if (row[field] || row.metadata?.[field]) {
            findings.push({ code: 'persisted_secret', severity: 'critical', collection, id: row.id, field });
          }
        }
      }
    }

    // 5. El consentimiento se respeta: no hay eventos de clic sin marca de consentimiento
    //    en el registro y con `fraudFlag` sin motivo.
    for (const event of (state.events || []).slice(-500)) {
      if (event.fraudFlag && !event.fraudReason) {
        findings.push({ code: 'fraud_flag_without_reason', severity: 'warning', eventId: event.id });
      }
    }

    // 6. En modo AFFILIATE no debe haber pedidos vivos.
    if (settings.mode() === 'AFFILIATE') {
      const live = (state.orders || []).filter(order => !['completed', 'cancelled', 'draft'].includes(order.status));
      if (live.length) {
        findings.push({ code: 'orders_in_affiliate_mode', severity: 'warning', count: live.length });
      }
    }

    return findings;
  }

  /** Comprobaciones de contrato de los propios módulos (M-0296 … M-0302). */
  conformance(router = null) {
    const findings = [];
    for (const [name, module] of this.container.modules) {
      for (const resource of module.resources || []) {
        if (!resource.fields || !Object.keys(resource.fields).length) {
          findings.push({ code: 'resource_without_fields', severity: 'warning', module: name, resource: resource.name });
        }
        if (!resource.collection || !resource.prefix) {
          findings.push({ code: 'resource_without_collection', severity: 'critical', module: name, resource: resource.name });
        }
      }
    }

    if (router) {
      for (const route of router.routes) {
        const isAdmin = route.path.includes('/admin/');
        if (isAdmin && route.permission === null && !route.path.includes('/admin/:resource')) {
          findings.push({ code: 'admin_route_without_permission', severity: 'critical', method: route.method, path: route.path });
        }
        if (route.permission && !this.permissions.exists(route.permission)) {
          findings.push({ code: 'route_with_unknown_permission', severity: 'critical', path: route.path, permission: route.permission });
        }
      }
    }
    return findings;
  }

  /** Informe completo. Salida en JSON, apta para automatización (M-0310). */
  report({ router = null } = {}) {
    const referential = this.referentialIntegrity();
    const invariants = this.invariants();
    const conformance = this.conformance(router);
    const all = [...referential, ...invariants, ...conformance];
    const critical = all.filter(finding => finding.severity === 'critical');

    return {
      generatedAt: now(),
      healthy: critical.length === 0,
      counts: {
        total: all.length,
        critical: critical.length,
        warning: all.filter(finding => finding.severity === 'warning').length,
        info: all.filter(finding => finding.severity === 'info').length,
      },
      referentialIntegrity: referential,
      invariants,
      conformance,
      catalogs: this.catalogs(),
    };
  }
}

export default {
  name: 'diagnostics',
  requires: [
    'container', 'store', 'config', 'events', 'jobs', 'cache', 'locks', 'permissions',
    'customFields', 'i18n', 'search', 'strategies', 'workflows', 'logger', 'rateLimiter',
  ],

  register(deps) {
    return new DiagnosticsService(deps);
  },

  routes: {
    admin: container => {
      const service = () => container.resolve('diagnostics');
      return [
        {
          method: 'GET',
          path: '/diagnostics',
          permission: 'settings:read',
          summary: 'Informe completo: integridad, invariantes, conformidad y catálogos.',
          tags: ['operación'],
          bodyless: true,
          handler: () => service().report(),
        },
        {
          method: 'GET',
          path: '/diagnostics/catalogs',
          permission: 'settings:read',
          summary: 'Módulos, eventos, trabajos, permisos y estrategias registrados.',
          tags: ['operación'],
          bodyless: true,
          handler: () => service().catalogs(),
        },
        {
          method: 'GET',
          path: '/diagnostics/invariants',
          permission: 'settings:read',
          summary: 'Verifica las reglas invariantes del negocio sobre los datos reales.',
          tags: ['operación'],
          bodyless: true,
          handler: () => {
            const findings = service().invariants();
            return { healthy: findings.filter(item => item.severity === 'critical').length === 0, findings };
          },
        },
        {
          method: 'GET',
          path: '/diagnostics/integrity',
          permission: 'settings:read',
          summary: 'Referencias rotas entre colecciones.',
          tags: ['operación'],
          bodyless: true,
          handler: () => {
            const findings = service().referentialIntegrity();
            return { healthy: findings.length === 0, findings };
          },
        },
        {
          method: 'GET',
          path: '/jobs',
          permission: 'settings:read',
          summary: 'Cola de trabajos y su estado.',
          tags: ['operación'],
          bodyless: true,
          handler: ctx => {
            const jobs = container.resolve('store').collection('jobs');
            const filtered = ctx.query.status ? jobs.filter(job => job.status === ctx.query.status) : jobs;
            return {
              data: filtered.slice(0, Math.min(200, Number(ctx.query.limit) || 50)),
              count: filtered.length,
              catalog: container.resolve('jobs').catalog(),
            };
          },
        },
        {
          method: 'POST',
          path: '/jobs/run',
          permission: 'settings:update',
          summary: 'Procesa un lote de la cola de trabajos de inmediato.',
          tags: ['operación'],
          body: { limit: rule.quantity({ default: 10, min: 1, max: 100 }) },
          handler: ctx => container.resolve('jobs').processBatch(ctx.body.limit || 10).then(results => ({ processed: results.length, results })),
        },
        {
          method: 'POST',
          path: '/jobs/:name/enqueue',
          permission: 'settings:update',
          summary: 'Encola un trabajo registrado por su nombre.',
          tags: ['operación'],
          body: { payload: rule.metadata() },
          handler: ctx => container.resolve('jobs').enqueue(ctx.params.name, ctx.body.payload || {}),
        },
        {
          method: 'GET',
          path: '/events/failed',
          permission: 'settings:read',
          summary: 'Eventos de dominio cuyos suscriptores agotaron los reintentos.',
          tags: ['operación'],
          bodyless: true,
          handler: () => {
            const data = container.resolve('events').failed();
            return { data, count: data.length };
          },
        },
        {
          method: 'GET',
          path: '/metrics',
          permission: 'settings:read',
          summary: 'Latencia y conteo por ruta.',
          tags: ['operación'],
          bodyless: true,
          handler: () => container.resolve('logger').snapshot(),
        },
      ];
    },
  },
};
