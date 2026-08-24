/**
 * Inventario (M-0491 … M-0542).
 *
 * Artículos desacoplados de la variante, como en Medusa: una variante puede consumir
 * varios artículos (un paquete) y un artículo puede servir a varias variantes. Los
 * niveles se llevan por ubicación con `stocked`, `reserved` e `incoming`, y **todo**
 * cambio deja un movimiento auditable.
 *
 * `available = stocked - reserved`. Nunca se resta directamente de `stocked` al
 * confirmar un pedido: primero se reserva, y la venta convierte la reserva.
 */
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule } from '../../framework/validate.js';
import { ConflictError, NotFoundError, ValidationError } from '../../framework/errors.js';
import { id as generateId } from '../../framework/ids.js';
import { now, plusMinutes, toDate } from '../../framework/dates.js';

export const MOVEMENT_TYPES = ['receipt', 'allocation', 'sale', 'cancellation', 'release', 'adjustment', 'return', 'transfer', 'stocktake'];
export const AVAILABILITY = ['in_stock', 'low_stock', 'out_of_stock', 'preorder', 'backorder', 'untracked'];

export const stockLocationResource = defineResource({
  name: 'stockLocation',
  collection: 'stockLocations',
  prefix: 'sloc',
  route: 'stock-locations',
  unique: ['code'],
  searchable: ['name', 'code'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(120, { required: true }),
    type: rule.enumOf(['warehouse', 'store', 'dropship', 'virtual'], { default: 'warehouse' }),
    address: {
      type: 'object',
      shape: {
        address1: rule.text(200),
        city: rule.text(100),
        provinceId: rule.id(),
        postalCode: rule.text(20),
        countryCode: rule.country(),
      },
    },
    channelIds: rule.list({ type: 'string' }, { default: [] }),
    priority: { type: 'integer', coerce: true, min: 0, max: 1000, default: 100 },
    allowsPickup: rule.flag({ default: false }),
    active: rule.flag({ default: true }),
    metadata: rule.metadata(),
  },
});

export const inventoryItemResource = defineResource({
  name: 'inventoryItem',
  collection: 'inventoryItems',
  prefix: 'iitem',
  route: 'inventory-items',
  unique: ['sku'],
  searchable: ['sku', 'title'],
  fields: {
    sku: rule.text(80, { required: true }),
    title: rule.text(160),
    description: rule.text(500),
    lowStockThreshold: rule.quantity(),
    allowBackorder: rule.flag({ default: false }),
    // Política cuando no hay stock: bloquear, permitir pedido o solo avisar (M-0509).
    outOfStockPolicy: rule.enumOf(['block', 'backorder', 'warn'], { default: 'block' }),
    requiresShipping: rule.flag({ default: true }),
    metadata: rule.metadata(),
  },
});

export const inventoryLevelResource = defineResource({
  name: 'inventoryLevel',
  collection: 'inventoryLevels',
  prefix: 'ilev',
  route: 'inventory-levels',
  searchable: [],
  fields: {
    inventoryItemId: rule.id({ required: true }),
    locationId: rule.id({ required: true }),
    stocked: rule.quantity({ default: 0 }),
    reserved: rule.quantity({ default: 0 }),
    incoming: rule.quantity({ default: 0 }),
    incomingExpectedAt: rule.date(),
    metadata: rule.metadata(),
  },
});

export const reservationResource = defineResource({
  name: 'reservation',
  collection: 'reservations',
  prefix: 'resv',
  route: 'reservations',
  searchable: ['reference'],
  fields: {
    inventoryItemId: rule.id({ required: true }),
    locationId: rule.id({ required: true }),
    quantity: rule.quantity({ required: true, min: 1 }),
    // `reference` identifica el carrito o pedido; permite idempotencia (M-0519).
    reference: rule.text(120, { required: true }),
    referenceType: rule.enumOf(['cart', 'order', 'manual'], { default: 'order' }),
    lineItemId: rule.id(),
    expiresAt: rule.date(),
    status: rule.enumOf(['active', 'released', 'consumed'], { default: 'active' }),
    metadata: rule.metadata(),
  },
});

export const stockMovementResource = defineResource({
  name: 'stockMovement',
  collection: 'stockMovements',
  prefix: 'smov',
  route: 'stock-movements',
  searchable: ['reference', 'reason'],
  softDelete: false,
  fields: {
    inventoryItemId: rule.id({ required: true }),
    locationId: rule.id({ required: true }),
    type: rule.enumOf(MOVEMENT_TYPES, { required: true }),
    quantity: { type: 'integer', coerce: true, required: true },
    reference: rule.text(120),
    reason: rule.text(300),
    actorId: rule.id(),
    metadata: rule.metadata(),
  },
});

export class StockLocationService extends BaseService {
  constructor(deps) {
    super(deps, stockLocationResource);
  }

  forChannel(channelId) {
    const all = this.repository.all({ active: true });
    const scoped = all.filter(location => (location.channelIds || []).includes(channelId));
    return (scoped.length ? scoped : all.filter(location => !location.channelIds?.length))
      .sort((a, b) => a.priority - b.priority);
  }

  default() {
    return this.repository.all({ active: true }).sort((a, b) => a.priority - b.priority)[0] || null;
  }

  pickupPoints() {
    return this.repository.all({ active: true, allowsPickup: true });
  }
}

export class InventoryItemService extends BaseService {
  constructor(deps) {
    super(deps, inventoryItemResource);
  }

  bySku(sku) {
    return this.repository.find({ sku });
  }
}

export class InventoryService {
  constructor({ store, events, audit, locks, cache, items, levels, reservations, movements, settings, catalog, alerts, notifications }) {
    this.store = store;
    this.events = events;
    this.audit = audit;
    this.locks = locks;
    this.cache = cache;
    this.items = items;
    this.levels = levels;
    this.reservations = reservations;
    this.movements = movements;
    this.settings = settings;
    this.catalog = catalog;
    this.alerts = alerts;
    this.notifications = notifications;
  }

  /** Nivel de un artículo en una ubicación; se crea a cero si no existe. */
  level(inventoryItemId, locationId) {
    return this.levels.repository.find({ inventoryItemId, locationId });
  }

  levelsFor(inventoryItemId) {
    return this.levels.repository.all({ inventoryItemId });
  }

  available(inventoryItemId, { locationId = null } = {}) {
    const rows = locationId ? [this.level(inventoryItemId, locationId)].filter(Boolean) : this.levelsFor(inventoryItemId);
    return rows.reduce((sum, row) => sum + Math.max(0, (row.stocked || 0) - (row.reserved || 0)), 0);
  }

  stocked(inventoryItemId, { locationId = null } = {}) {
    const rows = locationId ? [this.level(inventoryItemId, locationId)].filter(Boolean) : this.levelsFor(inventoryItemId);
    return rows.reduce((sum, row) => sum + (row.stocked || 0), 0);
  }

  /** Artículos que consume una variante, con la cantidad requerida por unidad. */
  requirementsFor(variantId) {
    const variant = this.catalog.variants.repository.byId(variantId);
    if (!variant) throw new NotFoundError('variante', variantId);
    if (!variant.manageInventory) return [];
    if (variant.components?.length) {
      // Un paquete consume los artículos de sus componentes (M-0515).
      return variant.components.flatMap(component => this.requirementsFor(component.variantId)
        .map(requirement => ({ ...requirement, quantity: requirement.quantity * component.quantity })));
    }
    const item = variant.sku ? this.items.bySku(variant.sku) : null;
    return item ? [{ inventoryItemId: item.id, quantity: 1 }] : [];
  }

  /** Disponibilidad de una variante, incluidos los paquetes (M-0516). */
  availabilityFor(variantId, { locationId = null } = {}) {
    const variant = this.catalog.variants.repository.byId(variantId);
    if (!variant) throw new NotFoundError('variante', variantId);
    if (!variant.manageInventory) return { state: 'untracked', available: null, backorder: false };

    const requirements = this.requirementsFor(variantId);
    if (!requirements.length) return { state: 'untracked', available: null, backorder: false };

    const available = Math.min(...requirements.map(requirement => Math.floor(
      this.available(requirement.inventoryItemId, { locationId }) / Math.max(1, requirement.quantity),
    )));
    const items = requirements.map(requirement => this.items.repository.byId(requirement.inventoryItemId)).filter(Boolean);
    const threshold = Math.max(
      ...items.map(item => item.lowStockThreshold ?? this.settings.get('inventory.lowStockThreshold', 5)),
      0,
    );
    const backorder = variant.allowBackorder || items.some(item => item.allowBackorder || item.outOfStockPolicy === 'backorder');
    const incoming = requirements.reduce(
      (sum, requirement) => sum + this.levelsFor(requirement.inventoryItemId).reduce((acc, level) => acc + (level.incoming || 0), 0),
      0,
    );

    let state = 'in_stock';
    if (available <= 0) state = backorder ? 'backorder' : incoming > 0 ? 'preorder' : 'out_of_stock';
    else if (available <= threshold) state = 'low_stock';

    return {
      state,
      available,
      threshold,
      backorder,
      incoming,
      restockAt: requirements
        .flatMap(requirement => this.levelsFor(requirement.inventoryItemId))
        .map(level => level.incomingExpectedAt)
        .filter(Boolean)
        .sort()[0] || null,
    };
  }

  /** Estado público: nunca expone la cantidad exacta (M-0531). */
  publicAvailability(variantId, options = {}) {
    const { state, backorder, restockAt, available, threshold } = this.availabilityFor(variantId, options);
    return {
      state,
      backorder,
      restockAt,
      // Solo se anuncia «últimas unidades», nunca el número exacto (M-0536).
      lastUnits: state === 'low_stock' ? true : false,
      hasStock: state === 'untracked' ? true : available > 0 || backorder,
      threshold: state === 'low_stock' ? threshold : undefined,
    };
  }

  async ensureLevel(state, inventoryItemId, locationId) {
    const existing = (state.inventoryLevels || []).find(
      row => row.inventoryItemId === inventoryItemId && row.locationId === locationId,
    );
    if (existing) return existing;
    return this.levels.repository.insert(state, { inventoryItemId, locationId, stocked: 0, reserved: 0, incoming: 0 });
  }

  recordMovement(state, movement) {
    if (!Array.isArray(state.stockMovements)) state.stockMovements = [];
    const record = { id: generateId('smov'), createdAt: now(), ...movement };
    state.stockMovements.unshift(record);
    if (state.stockMovements.length > 20_000) state.stockMovements.length = 20_000;
    return record;
  }

  /**
   * Reserva stock para un carrito o pedido.
   * Toma un bloqueo por artículo para que dos confirmaciones simultáneas no puedan
   * vender la misma última unidad (M-0518).
   */
  async reserve({ variantId, quantity, reference, referenceType = 'order', locationId = null, lineItemId = null, ttlMinutes = null }, ctx = null) {
    const requirements = this.requirementsFor(variantId);
    if (!requirements.length) return { reservations: [], untracked: true };

    const keys = requirements.map(requirement => `inventory:${requirement.inventoryItemId}`);
    return this.locks.withLocks(keys, async () => {
      // Idempotencia: la misma referencia y línea no reserva dos veces (M-0519).
      const existing = this.reservations.repository.all({ reference, status: 'active' })
        .filter(row => !lineItemId || row.lineItemId === lineItemId);
      if (existing.length) return { reservations: existing, idempotent: true };

      const variant = this.catalog.variants.repository.byId(variantId);
      const created = [];

      await this.store.transaction(async state => {
        for (const requirement of requirements) {
          const needed = requirement.quantity * quantity;
          const item = this.items.repository.byId(requirement.inventoryItemId);
          const candidates = locationId
            ? [locationId]
            : this.levelsFor(requirement.inventoryItemId)
              .sort((a, b) => (b.stocked - b.reserved) - (a.stocked - a.reserved))
              .map(level => level.locationId);

          let remaining = needed;
          for (const candidate of candidates) {
            if (remaining <= 0) break;
            const level = await this.ensureLevel(state, requirement.inventoryItemId, candidate);
            const free = Math.max(0, (level.stocked || 0) - (level.reserved || 0));
            const take = Math.min(free, remaining);
            if (take <= 0) continue;
            level.reserved = (level.reserved || 0) + take;
            remaining -= take;
            const reservation = this.reservations.repository.insert(state, {
              inventoryItemId: requirement.inventoryItemId,
              locationId: candidate,
              quantity: take,
              reference,
              referenceType,
              lineItemId,
              status: 'active',
              expiresAt: ttlMinutes ? plusMinutes(now(), ttlMinutes) : null,
            });
            created.push(reservation);
            this.recordMovement(state, {
              inventoryItemId: requirement.inventoryItemId,
              locationId: candidate,
              type: 'allocation',
              quantity: -take,
              reference,
              reason: `Reserva para ${referenceType} ${reference}`,
              actorId: ctx?.actor?.id || null,
            });
          }

          if (remaining > 0) {
            const allowsBackorder = variant?.allowBackorder || item?.allowBackorder || item?.outOfStockPolicy === 'backorder';
            if (!allowsBackorder) {
              // La transacción se descarta completa: no queda media reserva (M-0524).
              throw new ConflictError(
                `Stock insuficiente para ${item?.sku || requirement.inventoryItemId}: faltan ${remaining} unidad(es).`,
                { inventoryItemId: requirement.inventoryItemId, missing: remaining },
              );
            }
            const fallbackLocation = locationId || candidates[0] || null;
            if (!fallbackLocation) throw new ConflictError('No hay ubicación de stock configurada.');
            const level = await this.ensureLevel(state, requirement.inventoryItemId, fallbackLocation);
            level.reserved = (level.reserved || 0) + remaining;
            created.push(this.reservations.repository.insert(state, {
              inventoryItemId: requirement.inventoryItemId,
              locationId: fallbackLocation,
              quantity: remaining,
              reference,
              referenceType,
              lineItemId,
              status: 'active',
              expiresAt: ttlMinutes ? plusMinutes(now(), ttlMinutes) : null,
              metadata: { backorder: true },
            }));
            this.recordMovement(state, {
              inventoryItemId: requirement.inventoryItemId,
              locationId: fallbackLocation,
              type: 'allocation',
              quantity: -remaining,
              reference,
              reason: 'Reserva en backorder',
              actorId: ctx?.actor?.id || null,
            });
          }
        }
      });

      this.cache?.invalidateTag('inventory');
      await this.events.emit('inventory.reserved', { variantId, quantity, reference, reservations: created.length });
      await this.checkLowStock(requirements.map(requirement => requirement.inventoryItemId));
      return { reservations: created, idempotent: false };
    }, { owner: `reserve:${reference}` });
  }

  /** Libera reservas (cancelación, caducidad de carrito) (M-0496). */
  async release({ reference, lineItemId = null }, ctx = null) {
    const targets = this.reservations.repository
      .all({ reference, status: 'active' })
      .filter(row => !lineItemId || row.lineItemId === lineItemId);
    if (!targets.length) return { released: 0 };

    await this.store.transaction(async state => {
      for (const reservation of targets) {
        const level = await this.ensureLevel(state, reservation.inventoryItemId, reservation.locationId);
        level.reserved = Math.max(0, (level.reserved || 0) - reservation.quantity);
        this.reservations.repository.patch(state, reservation.id, { status: 'released', releasedAt: now() });
        this.recordMovement(state, {
          inventoryItemId: reservation.inventoryItemId,
          locationId: reservation.locationId,
          type: 'release',
          quantity: reservation.quantity,
          reference,
          reason: 'Liberación de reserva',
          actorId: ctx?.actor?.id || null,
        });
      }
    });

    this.cache?.invalidateTag('inventory');
    await this.events.emit('inventory.released', { reference, released: targets.length });
    return { released: targets.length };
  }

  /** Convierte la reserva en venta al enviar (M-0500). */
  async consume({ reference, lineItemId = null }, ctx = null) {
    const targets = this.reservations.repository
      .all({ reference, status: 'active' })
      .filter(row => !lineItemId || row.lineItemId === lineItemId);
    if (!targets.length) return { consumed: 0 };

    await this.store.transaction(async state => {
      for (const reservation of targets) {
        const level = await this.ensureLevel(state, reservation.inventoryItemId, reservation.locationId);
        level.reserved = Math.max(0, (level.reserved || 0) - reservation.quantity);
        level.stocked = (level.stocked || 0) - reservation.quantity;
        this.reservations.repository.patch(state, reservation.id, { status: 'consumed', consumedAt: now() });
        this.recordMovement(state, {
          inventoryItemId: reservation.inventoryItemId,
          locationId: reservation.locationId,
          type: 'sale',
          quantity: -reservation.quantity,
          reference,
          reason: 'Venta enviada',
          actorId: ctx?.actor?.id || null,
        });
      }
    });

    this.cache?.invalidateTag('inventory');
    await this.events.emit('inventory.consumed', { reference, consumed: targets.length });
    return { consumed: targets.length };
  }

  /** Ajuste manual con motivo obligatorio (M-0503). */
  async adjust({ inventoryItemId, locationId, delta, reason, type = 'adjustment' }, ctx = null) {
    if (!reason) throw ValidationError.single('reason', 'Todo ajuste de stock necesita un motivo.');
    const result = await this.store.transaction(async state => {
      const level = await this.ensureLevel(state, inventoryItemId, locationId);
      const next = (level.stocked || 0) + Number(delta);
      if (next < 0) throw new ConflictError('El ajuste dejaría el stock físico en negativo.', { current: level.stocked, delta });
      level.stocked = next;
      this.recordMovement(state, {
        inventoryItemId, locationId, type, quantity: Number(delta), reason, actorId: ctx?.actor?.id || null,
      });
      return level;
    });
    this.cache?.invalidateTag('inventory');
    await this.events.emit('inventory.adjusted', { inventoryItemId, locationId, delta, reason });
    await this.audit?.record({ action: 'inventory_adjusted', entity: 'inventoryLevel', entityId: result.id, after: result, note: reason, ctx });
    await this.checkLowStock([inventoryItemId]);
    return result;
  }

  /** Recepción de mercancía; descuenta de `incoming` si estaba anunciada. */
  async receive({ inventoryItemId, locationId, quantity, reference = null }, ctx = null) {
    const result = await this.store.transaction(async state => {
      const level = await this.ensureLevel(state, inventoryItemId, locationId);
      level.stocked = (level.stocked || 0) + Number(quantity);
      level.incoming = Math.max(0, (level.incoming || 0) - Number(quantity));
      this.recordMovement(state, {
        inventoryItemId, locationId, type: 'receipt', quantity: Number(quantity), reference,
        reason: 'Recepción de mercancía', actorId: ctx?.actor?.id || null,
      });
      return level;
    });
    this.cache?.invalidateTag('inventory');
    return result;
  }

  /** Transferencia entre ubicaciones (M-0513). */
  async transfer({ inventoryItemId, fromLocationId, toLocationId, quantity, reason = 'Transferencia' }, ctx = null) {
    if (fromLocationId === toLocationId) throw ValidationError.single('toLocationId', 'El origen y el destino deben ser distintos.');
    return this.locks.withLock(`inventory:${inventoryItemId}`, async () => this.store.transaction(async state => {
      const source = await this.ensureLevel(state, inventoryItemId, fromLocationId);
      const free = Math.max(0, (source.stocked || 0) - (source.reserved || 0));
      if (free < quantity) throw new ConflictError(`Solo hay ${free} unidad(es) libres en el origen.`, { available: free });
      const target = await this.ensureLevel(state, inventoryItemId, toLocationId);
      source.stocked -= quantity;
      target.stocked = (target.stocked || 0) + quantity;
      this.recordMovement(state, { inventoryItemId, locationId: fromLocationId, type: 'transfer', quantity: -quantity, reason, actorId: ctx?.actor?.id || null });
      this.recordMovement(state, { inventoryItemId, locationId: toLocationId, type: 'transfer', quantity, reason, actorId: ctx?.actor?.id || null });
      return { from: source, to: target };
    }));
  }

  /** Recuento físico: registra la diferencia, no la oculta (M-0505). */
  async stocktake({ locationId, counts, reason = 'Recuento físico' }, ctx = null) {
    const differences = [];
    await this.store.transaction(async state => {
      for (const entry of counts) {
        const level = await this.ensureLevel(state, entry.inventoryItemId, locationId);
        const difference = Number(entry.counted) - (level.stocked || 0);
        if (!difference) continue;
        level.stocked = Number(entry.counted);
        differences.push({ inventoryItemId: entry.inventoryItemId, difference, counted: entry.counted });
        this.recordMovement(state, {
          inventoryItemId: entry.inventoryItemId, locationId, type: 'stocktake', quantity: difference,
          reason, actorId: ctx?.actor?.id || null,
        });
      }
    });
    this.cache?.invalidateTag('inventory');
    await this.audit?.record({ action: 'inventory_stocktake', entity: 'stockLocation', entityId: locationId, after: { differences }, note: reason, ctx });
    return { locationId, differences, adjusted: differences.length };
  }

  /** Caduca reservas de carrito vencidas (M-0497). */
  async expireReservations() {
    const expired = this.reservations.repository
      .all({ status: 'active' })
      .filter(row => row.expiresAt && (toDate(row.expiresAt)?.getTime() ?? Infinity) < Date.now());
    if (!expired.length) return { released: 0 };
    const references = [...new Set(expired.map(row => row.reference))];
    let released = 0;
    for (const reference of references) {
      const result = await this.release({ reference });
      released += result.released;
    }
    return { released, references: references.length };
  }

  /** Alerta de stock bajo o agotado (M-0511, M-0512). */
  async checkLowStock(inventoryItemIds = null) {
    const items = inventoryItemIds
      ? inventoryItemIds.map(id => this.items.repository.byId(id)).filter(Boolean)
      : this.items.repository.all();
    const raised = [];
    for (const item of items) {
      const threshold = item.lowStockThreshold ?? this.settings.get('inventory.lowStockThreshold', 5);
      for (const level of this.levelsFor(item.id)) {
        const available = Math.max(0, (level.stocked || 0) - (level.reserved || 0));
        if (available > threshold) continue;
        const location = this.locationName(level.locationId);
        await this.alerts?.raise({
          type: available <= 0 ? 'stock_out' : 'stock_low',
          severity: available <= 0 ? 'critical' : 'warning',
          message: available <= 0
            ? `${item.sku} está agotado en ${location}.`
            : `${item.sku} tiene ${available} unidad(es) en ${location}, por debajo del umbral ${threshold}.`,
          entityId: item.id,
        });
        await this.notifications?.send({
          template: 'inventory.low',
          entityId: item.id,
          data: { sku: item.sku, available, location, threshold },
        });
        raised.push({ inventoryItemId: item.id, locationId: level.locationId, available });
      }
    }
    return { raised: raised.length, details: raised };
  }

  locationName(locationId) {
    return this.store.collection('stockLocations').find(row => row.id === locationId)?.name || locationId;
  }

  /** Informe de valor de inventario por ubicación (M-0521). */
  valuation() {
    const locations = this.store.collection('stockLocations');
    const items = this.items.repository.all();
    const prices = this.store.collection('prices');
    const variants = this.store.collection('variants');

    const unitCost = sku => {
      const variant = variants.find(row => row.sku === sku);
      if (!variant) return 0;
      const price = prices.find(row => row.variantId === variant.id && !row.priceListId);
      return price?.amount || 0;
    };

    return locations.map(location => {
      const rows = items.map(item => {
        const level = this.level(item.id, location.id);
        const quantity = level?.stocked || 0;
        return { sku: item.sku, quantity, unitAmount: unitCost(item.sku), value: quantity * unitCost(item.sku) };
      }).filter(row => row.quantity > 0);
      return {
        locationId: location.id,
        name: location.name,
        items: rows.length,
        units: rows.reduce((sum, row) => sum + row.quantity, 0),
        value: rows.reduce((sum, row) => sum + row.value, 0),
        rows,
      };
    });
  }

  /** Rotación por artículo a partir de los movimientos de venta (M-0520). */
  turnover({ days = 90 } = {}) {
    const since = Date.now() - days * 86_400_000;
    const sales = this.store.collection('stockMovements').filter(
      row => row.type === 'sale' && (toDate(row.createdAt)?.getTime() ?? 0) >= since,
    );
    const grouped = new Map();
    for (const movement of sales) {
      const current = grouped.get(movement.inventoryItemId) || 0;
      grouped.set(movement.inventoryItemId, current + Math.abs(movement.quantity));
    }
    return [...grouped.entries()]
      .map(([inventoryItemId, sold]) => {
        const item = this.items.repository.byId(inventoryItemId);
        const stock = this.stocked(inventoryItemId);
        return {
          inventoryItemId,
          sku: item?.sku || null,
          soldUnits: sold,
          stocked: stock,
          daysOfStock: sold ? Math.round((stock / sold) * days) : null,
        };
      })
      .sort((a, b) => b.soldUnits - a.soldUnits);
  }

  /** Diagnóstico de incoherencias entre reservas y niveles (M-0544). */
  diagnose() {
    const findings = [];
    for (const level of this.levels.repository.all()) {
      const activeReserved = this.reservations.repository
        .all({ inventoryItemId: level.inventoryItemId, locationId: level.locationId, status: 'active' })
        .reduce((sum, row) => sum + row.quantity, 0);
      if (activeReserved !== (level.reserved || 0)) {
        findings.push({
          code: 'reserved_mismatch',
          severity: 'critical',
          levelId: level.id,
          inventoryItemId: level.inventoryItemId,
          locationId: level.locationId,
          storedReserved: level.reserved || 0,
          activeReservations: activeReserved,
        });
      }
      if ((level.stocked || 0) < 0) {
        findings.push({ code: 'negative_stock', severity: 'critical', levelId: level.id, stocked: level.stocked });
      }
    }
    const skus = new Set(this.items.repository.all().map(item => item.sku));
    for (const variant of this.store.collection('variants')) {
      if (variant.deletedAt || !variant.manageInventory || variant.components?.length) continue;
      if (variant.sku && !skus.has(variant.sku)) {
        findings.push({ code: 'variant_without_inventory_item', severity: 'warning', variantId: variant.id, sku: variant.sku });
      }
    }
    return { checkedAt: now(), findings, healthy: findings.length === 0 };
  }

  /** Repara las diferencias que el diagnóstico encuentra (M-0545, M-0546). */
  async repair(ctx = null) {
    const { findings } = this.diagnose();
    const repairable = findings.filter(finding => finding.code === 'reserved_mismatch');
    if (!repairable.length) return { repaired: 0, findings };
    await this.store.transaction(state => {
      for (const finding of repairable) {
        const level = (state.inventoryLevels || []).find(row => row.id === finding.levelId);
        if (level) level.reserved = finding.activeReservations;
      }
    });
    await this.audit?.record({
      action: 'inventory_repaired',
      entity: 'inventory',
      entityId: null,
      after: { repaired: repairable.length },
      note: 'Reservas recalculadas desde las reservas activas.',
      ctx,
    });
    return { repaired: repairable.length, findings };
  }

  /** Crea el artículo de inventario que falta para una variante con SKU. */
  async syncFromVariants(ctx = null) {
    const created = [];
    for (const variant of this.store.collection('variants')) {
      if (variant.deletedAt || !variant.manageInventory || !variant.sku || variant.components?.length) continue;
      if (this.items.bySku(variant.sku)) continue;
      created.push(await this.items.create({ sku: variant.sku, title: variant.title }, ctx));
    }
    return { created: created.length };
  }
}

export default {
  name: 'inventory',
  requires: ['store', 'events', 'audit', 'config', 'customFields', 'locks', 'cache', 'settings', 'catalog', 'alert', 'notifications'],
  resources: [stockLocationResource, inventoryItemResource, inventoryLevelResource, reservationResource, stockMovementResource],
  permissions: [
    { resource: 'inventory', description: 'Artículos y niveles de inventario.' },
    { resource: 'stockLocation', description: 'Ubicaciones de stock.' },
    { resource: 'reservation', description: 'Reservas de inventario.' },
    { resource: 'stockMovement', actions: ['read'], description: 'Movimientos de stock.' },
  ],

  register(deps) {
    const locations = new StockLocationService(deps);
    const items = new InventoryItemService(deps);
    const levels = new BaseService(deps, inventoryLevelResource);
    const reservations = new BaseService(deps, reservationResource);
    const movements = new BaseService(deps, stockMovementResource);
    return {
      locations,
      items,
      levels,
      reservations,
      movements,
      service: new InventoryService({
        store: deps.store,
        events: deps.events,
        audit: deps.audit,
        locks: deps.locks,
        cache: deps.cache,
        settings: deps.settings,
        catalog: deps.catalog,
        alerts: deps.alert,
        notifications: deps.notifications,
        items,
        levels,
        reservations,
        movements,
      }),
    };
  },

  async seed(service) {
    await service.locations.seed([
      { id: 'sloc_main', code: 'principal', name: 'Depósito principal', type: 'warehouse', priority: 10, allowsPickup: true },
      { id: 'sloc_virtual', code: 'virtual', name: 'Entrega digital', type: 'virtual', priority: 90 },
    ], 'id');
  },

  jobs: container => [
    {
      name: 'inventory.expire-reservations',
      everyMs: 10 * 60_000,
      handler: () => container.resolve('inventory').service.expireReservations(),
    },
    {
      name: 'inventory.low-stock',
      everyMs: 6 * 3_600_000,
      handler: () => container.resolve('inventory').service.checkLowStock(),
    },
    {
      name: 'inventory.diagnose',
      everyMs: 24 * 3_600_000,
      handler: async () => {
        const inventory = container.resolve('inventory').service;
        const report = inventory.diagnose();
        if (!report.healthy) {
          await container.resolve('alert').raise({
            type: 'inventory_incoherence',
            severity: 'critical',
            message: `El diagnóstico de inventario encontró ${report.findings.length} incoherencia(s).`,
            entityId: null,
          });
        }
        return { findings: report.findings.length };
      },
    },
  ],

  routes: {
    admin: container => {
      const module = () => container.resolve('inventory');
      return [
        ...crudRoutes(stockLocationResource, () => module().locations, { tags: ['inventario'] }),
        ...crudRoutes(inventoryItemResource, () => module().items, { permissionResource: 'inventory', tags: ['inventario'] }),
        ...crudRoutes(inventoryLevelResource, () => module().levels, { permissionResource: 'inventory', tags: ['inventario'] }),
        ...crudRoutes(reservationResource, () => module().reservations, { tags: ['inventario'] }),
        {
          method: 'GET',
          path: '/stock-movements',
          permission: 'stockMovement:read',
          summary: 'Movimientos de stock con filtros.',
          tags: ['inventario'],
          bodyless: true,
          handler: ctx => module().movements.list(ctx.query),
        },
        {
          method: 'GET',
          path: '/inventory/availability/:variantId',
          permission: 'inventory:read',
          summary: 'Disponibilidad detallada de una variante.',
          tags: ['inventario'],
          bodyless: true,
          handler: ctx => module().service.availabilityFor(ctx.params.variantId, { locationId: ctx.query.locationId || null }),
        },
        {
          method: 'POST',
          path: '/inventory/adjust',
          permission: 'inventory:update',
          summary: 'Ajusta el stock con un motivo obligatorio.',
          tags: ['inventario'],
          body: {
            inventoryItemId: rule.id({ required: true }),
            locationId: rule.id({ required: true }),
            delta: { type: 'integer', coerce: true, required: true },
            reason: rule.text(300, { required: true }),
          },
          handler: ctx => module().service.adjust(ctx.body, ctx),
        },
        {
          method: 'POST',
          path: '/inventory/receive',
          permission: 'inventory:update',
          summary: 'Registra una recepción de mercancía.',
          tags: ['inventario'],
          body: {
            inventoryItemId: rule.id({ required: true }),
            locationId: rule.id({ required: true }),
            quantity: rule.quantity({ required: true, min: 1 }),
            reference: rule.text(120),
          },
          handler: ctx => module().service.receive(ctx.body, ctx),
        },
        {
          method: 'POST',
          path: '/inventory/transfer',
          permission: 'inventory:update',
          summary: 'Transfiere stock entre ubicaciones.',
          tags: ['inventario'],
          body: {
            inventoryItemId: rule.id({ required: true }),
            fromLocationId: rule.id({ required: true }),
            toLocationId: rule.id({ required: true }),
            quantity: rule.quantity({ required: true, min: 1 }),
            reason: rule.text(300),
          },
          handler: ctx => module().service.transfer(ctx.body, ctx),
        },
        {
          method: 'POST',
          path: '/inventory/stocktake',
          permission: 'inventory:update',
          summary: 'Recuento físico con registro de diferencias.',
          tags: ['inventario'],
          body: {
            locationId: rule.id({ required: true }),
            reason: rule.text(300),
            counts: rule.list({ type: 'object', shape: { inventoryItemId: rule.id({ required: true }), counted: rule.quantity({ required: true }) } }, { required: true }),
          },
          handler: ctx => module().service.stocktake(ctx.body, ctx),
        },
        {
          method: 'POST',
          path: '/inventory/release',
          permission: 'inventory:update',
          summary: 'Libera las reservas de una referencia.',
          tags: ['inventario'],
          body: { reference: rule.text(120, { required: true }), lineItemId: rule.id() },
          handler: ctx => module().service.release(ctx.body, ctx),
        },
        {
          method: 'POST',
          path: '/inventory/sync-variants',
          permission: 'inventory:create',
          summary: 'Crea los artículos de inventario que faltan para las variantes con SKU.',
          tags: ['inventario'],
          handler: ctx => module().service.syncFromVariants(ctx),
        },
        {
          method: 'GET',
          path: '/inventory/valuation',
          permission: 'inventory:read',
          summary: 'Valor de inventario por ubicación.',
          tags: ['inventario'],
          bodyless: true,
          handler: () => ({ data: module().service.valuation() }),
        },
        {
          method: 'GET',
          path: '/inventory/turnover',
          permission: 'inventory:read',
          summary: 'Rotación por artículo.',
          tags: ['inventario'],
          bodyless: true,
          handler: ctx => ({ data: module().service.turnover({ days: Number(ctx.query.days) || 90 }) }),
        },
        {
          method: 'GET',
          path: '/inventory/diagnose',
          permission: 'inventory:read',
          summary: 'Diagnóstico de coherencia del inventario.',
          tags: ['inventario'],
          bodyless: true,
          handler: () => module().service.diagnose(),
        },
        {
          method: 'POST',
          path: '/inventory/repair',
          permission: 'inventory:update',
          summary: 'Recalcula las reservas incoherentes.',
          tags: ['inventario'],
          handler: ctx => module().service.repair(ctx),
        },
      ];
    },

    store: container => [
      {
        method: 'GET',
        path: '/catalog/variants/:variantId/availability',
        permission: null,
        summary: 'Disponibilidad pública de una variante, sin cantidades exactas.',
        tags: ['store'],
        bodyless: true,
        handler: ctx => container.resolve('inventory').service.publicAvailability(ctx.params.variantId),
      },
      {
        method: 'GET',
        path: '/pickup-points',
        permission: null,
        summary: 'Puntos de recogida disponibles.',
        tags: ['store'],
        bodyless: true,
        handler: () => {
          const data = container.resolve('inventory').locations.pickupPoints().map(location => ({
            id: location.id,
            name: location.name,
            address: location.address || null,
          }));
          return { data, count: data.length };
        },
      },
    ],
  },
};
