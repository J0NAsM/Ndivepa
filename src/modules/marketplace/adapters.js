/**
 * Arquitectura de integraciones del marketplace.
 *
 *   Marketplace Core
 *   ├── Payment Adapter        -> `payment` (proveedores manuales + contrato de pasarela)
 *   ├── Shipping Adapter       -> este fichero (`ManualShippingAdapter`)
 *   ├── Dropshipping Adapter   -> este fichero (`ManualSupplierAdapter`, `CsvSupplierAdapter`)
 *   ├── Affiliate Adapter      -> este fichero (`GenericPostbackAdapter`)
 *   ├── Notification Adapter   -> `framework/notifications.js` (proveedores registrables)
 *   └── Future AI Adapter      -> este fichero (`NullAiAdapter`)
 *
 * Regla: **ninguna integración de terceros se simula**. Los adaptadores que
 * dependen de un proveedor externo responden `integration_not_configured` hasta
 * que exista un contrato real, credenciales y una implementación probada contra
 * su API documentada. Cambiar de proveedor es registrar otro adaptador con el
 * mismo contrato; el núcleo no cambia.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { NdivepaError } from '../../framework/errors.js';
import { parseCsv } from '../../framework/strings.js';

export class IntegrationNotConfiguredError extends NdivepaError {
  constructor(kind, name) {
    super(`La integración ${kind} "${name}" no está configurada. Hace falta un contrato y credenciales del proveedor.`, {
      code: 'integration_not_configured',
      status: 409,
      details: { kind, name },
    });
  }
}

/** Registro de adaptadores por tipo. */
export class AdapterRegistry {
  constructor() {
    this.adapters = new Map();
  }

  register(kind, name, adapter) {
    if (!this.adapters.has(kind)) this.adapters.set(kind, new Map());
    this.adapters.get(kind).set(name, adapter);
    return this;
  }

  get(kind, name) {
    const adapter = this.adapters.get(kind)?.get(name);
    if (!adapter) throw new IntegrationNotConfiguredError(kind, name);
    return adapter;
  }

  describe() {
    return [...this.adapters.entries()].map(([kind, entries]) => ({
      kind,
      adapters: [...entries.entries()].map(([name, adapter]) => ({ name, configured: adapter.configured !== false, description: adapter.description || null })),
    }));
  }
}

// --- Envíos ---------------------------------------------------------------------

/**
 * Envío gestionado por la propia tienda o por la plataforma. El seguimiento lo
 * carga quien despacha; no se consulta a ningún transportista.
 */
export class ManualShippingAdapter {
  constructor() {
    this.configured = true;
    this.description = 'Retiro, entrega local y envío con seguimiento cargado manualmente.';
  }

  quote({ mode }) {
    return { mode, source: 'shipping_options', note: 'Las tarifas salen de las opciones de envío configuradas.' };
  }

  tracking({ carrier = null, trackingNumber = null, trackingUrl = null }) {
    return { carrier, trackingNumber, trackingUrl, source: 'manual' };
  }
}

/** Plantilla de transportista con API. No se registra sin contrato ni credenciales. */
export class CarrierApiAdapter {
  constructor({ name }) {
    this.name = name;
    this.configured = false;
  }

  quote() { throw new IntegrationNotConfiguredError('shipping', this.name); }
  createShipment() { throw new IntegrationNotConfiguredError('shipping', this.name); }
  tracking() { throw new IntegrationNotConfiguredError('shipping', this.name); }
}

// --- Dropshipping ---------------------------------------------------------------

/**
 * Contrato de proveedor de dropshipping:
 *  - `importCatalog(input)`  -> filas `{supplierSku, name, cost, stock, leadTimeDays}`
 *  - `placeOrder(order)`     -> `{externalReference, status}`
 *  - `tracking(order)`       -> `{carrier, trackingNumber, trackingUrl, status}`
 */
export class ManualSupplierAdapter {
  constructor() {
    this.configured = true;
    this.description = 'El pedido se envía al proveedor por un canal acordado y el estado se carga a mano.';
  }

  async importCatalog() {
    return [];
  }

  async placeOrder(order) {
    return { externalReference: null, status: 'sent', note: `Enviar el pedido ${order.code} al proveedor por el canal acordado.` };
  }

  async tracking(order) {
    return order.tracking || null;
  }
}

/** Catálogo del proveedor por CSV: `supplier_sku,name,cost,stock,lead_time_days`. */
export class CsvSupplierAdapter extends ManualSupplierAdapter {
  constructor() {
    super();
    this.description = 'Catálogo, costos y stock importados desde un CSV del proveedor.';
  }

  async importCatalog({ csv }) {
    const rows = parseCsv(csv, { maxRows: 5001 });
    if (rows.length < 2) return [];
    const header = rows[0].map(cell => cell.trim().toLowerCase());
    const index = name => header.indexOf(name);
    return rows.slice(1).filter(row => row.some(Boolean)).map((row, offset) => ({
      line: offset + 2,
      supplierSku: row[index('supplier_sku')]?.trim() || null,
      name: row[index('name')]?.trim() || null,
      cost: row[index('cost')] === undefined ? null : Number(row[index('cost')]),
      stock: row[index('stock')] === undefined || row[index('stock')] === '' ? null : Number(row[index('stock')]),
      leadTimeDays: row[index('lead_time_days')] ? Number(row[index('lead_time_days')]) : null,
    }));
  }
}

/** Plantilla de proveedor con API propia. */
export class SupplierApiAdapter {
  constructor({ name }) {
    this.name = name;
    this.configured = false;
  }

  async importCatalog() { throw new IntegrationNotConfiguredError('dropshipping', this.name); }
  async placeOrder() { throw new IntegrationNotConfiguredError('dropshipping', this.name); }
  async tracking() { throw new IntegrationNotConfiguredError('dropshipping', this.name); }
}

// --- Afiliación -----------------------------------------------------------------

/**
 * Postback genérico firmado: `HMAC-SHA256(secret, "<timestamp>.<cuerpo exacto>")`
 * en `X-Ndivepa-Signature`, con `X-Ndivepa-Timestamp` en segundos. Cada red real
 * tiene su formato; este adaptador define el contrato interno al que se traduce.
 */
export class GenericPostbackAdapter {
  constructor({ secret, toleranceSeconds = 300 }) {
    this.secret = secret || null;
    this.toleranceSeconds = toleranceSeconds;
    this.configured = Boolean(secret);
  }

  verify({ rawBody, timestamp, signature }) {
    if (!this.secret) throw new IntegrationNotConfiguredError('affiliate', 'postback');
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > this.toleranceSeconds) return false;
    const expected = Buffer.from(createHmac('sha256', this.secret).update(`${timestamp}.${rawBody}`).digest('hex'), 'utf8');
    const received = Buffer.from(String(signature || ''), 'utf8');
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  /** Traduce el cuerpo al formato de `conversions`. No inventa campos ausentes. */
  translate(body) {
    return {
      networkConversionId: body.conversionId ? String(body.conversionId) : null,
      clickId: body.clickId ? String(body.clickId) : null,
      saleAmount: Number.isFinite(Number(body.saleAmount)) ? Math.round(Number(body.saleAmount)) : null,
      saleCurrency: body.currency ? String(body.currency).toUpperCase() : null,
      commission: Number.isFinite(Number(body.commission)) ? Math.round(Number(body.commission)) : null,
      reportedStatus: ['pending', 'approved', 'rejected'].includes(body.status) ? body.status : 'pending',
      date: body.occurredAt || null,
    };
  }
}

// --- IA -----------------------------------------------------------------------------

/**
 * Punto de integración para IA: búsqueda semántica, recomendaciones,
 * descripciones, clasificación, duplicados, asistencia al vendedor y tendencias.
 * El adaptador nulo devuelve `null` en todo y la plataforma funciona igual.
 */
export class NullAiAdapter {
  constructor() {
    this.configured = false;
    this.description = 'Sin proveedor de IA: la plataforma usa reglas determinísticas.';
  }

  async rerankSearch() { return null; }
  async recommend() { return null; }
  async draftDescription() { return null; }
  async classifyProduct() { return null; }
  async findDuplicates() { return null; }
  async sellerAssistant() { return null; }
  async trends() { return null; }
}

export function defaultAdapters({ env = process.env } = {}) {
  const registry = new AdapterRegistry();
  registry.register('shipping', 'manual', new ManualShippingAdapter());
  registry.register('dropshipping', 'manual', new ManualSupplierAdapter());
  registry.register('dropshipping', 'csv', new CsvSupplierAdapter());
  registry.register('affiliate', 'postback', new GenericPostbackAdapter({ secret: env.AFFILIATE_POSTBACK_SECRET || null }));
  registry.register('ai', 'null', new NullAiAdapter());
  return registry;
}
