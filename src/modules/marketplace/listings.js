/**
 * Publicaciones de producto del marketplace.
 *
 * Una publicación **no** es un modelo nuevo: es un producto del catálogo con su
 * variante, su precio en la tabla de precios y su nivel de inventario en la
 * ubicación de la tienda. Este servicio orquesta los servicios existentes para
 * que una tienda cree una ficha completa con un solo formulario, y aplica la
 * autorización por recurso: una tienda solo toca sus propios productos.
 *
 * El precio que se cobra sale siempre de `prices` (backend). El `price` del
 * producto es la copia de presentación para listados y SEO.
 */
import { ConflictError, NotFoundError, ValidationError } from '../../framework/errors.js';
import { rule, validate, check } from '../../framework/validate.js';
import { parseCsv, slug } from '../../framework/strings.js';
import { now } from '../../framework/dates.js';
import { DELIVERY_MODES } from '../catalog/index.js';

const VARIANT_INPUT = {
  id: rule.id(),
  title: rule.text(160, { required: true }),
  sku: rule.text(80),
  price: rule.minor({ required: true, min: 1 }),
  compareAtPrice: rule.minor({ min: 0 }),
  stock: { type: 'integer', coerce: true, min: 0, max: 1_000_000 },
  optionValues: { type: 'object', shape: {}, allowUnknown: true },
  weight: { type: 'number', coerce: true, min: 0 },
};

/** Formulario de publicación. Lo que no está aquí no lo puede escribir una tienda. */
export const LISTING_INPUT = {
  name: rule.text(200, { required: true }),
  subtitle: rule.text(300),
  description: rule.longText(),
  categoryId: rule.id({ required: true }),
  brand: rule.text(120),
  tags: rule.list({ type: 'string', maxLength: 40 }, { maxItems: 12 }),
  price: rule.minor({ min: 1 }),
  compareAtPrice: rule.minor({ min: 0 }),
  sku: rule.text(80),
  // `null` o ausente: sin control de stock (servicios, bajo pedido).
  stock: { type: 'integer', coerce: true, min: 0, max: 1_000_000 },
  weight: { type: 'number', coerce: true, min: 0, max: 1_000_000 },
  length: { type: 'number', coerce: true, min: 0, max: 100_000 },
  width: { type: 'number', coerce: true, min: 0, max: 100_000 },
  height: { type: 'number', coerce: true, min: 0, max: 100_000 },
  type: rule.enumOf(['physical', 'digital', 'service']),
  deliveryModes: rule.list({ type: 'string', enum: DELIVERY_MODES }),
  shippingInfo: { type: 'object', shape: { handlingDays: { type: 'integer', coerce: true, min: 0, max: 90 }, notes: rule.text(400) } },
  imageUrls: rule.list({ type: 'string', maxLength: 500 }, { maxItems: 8 }),
  assetIds: rule.list({ type: 'string' }, { maxItems: 8 }),
  variants: { type: 'array', maxItems: 50, items: { type: 'object', shape: VARIANT_INPUT } },
  status: rule.enumOf(['draft', 'published']),
};

const LOCAL_IMAGE = /^\/uploads\/[A-Za-z0-9/_-]+\.(?:png|jpe?g|webp)$/i;

export class ListingService {
  constructor({ store, events, settings, catalog, pricing, inventory, cache, accounts, logger }) {
    this.store = store;
    this.events = events;
    this.settings = settings;
    this.catalog = catalog;
    this.pricing = pricing;
    this.inventory = inventory;
    this.cache = cache;
    this.accounts = accounts;
    this.logger = logger;
  }

  get currency() {
    return this.settings.get('marketplace.currencyCode', 'PYG');
  }

  /** Producto del vendedor o 404: nunca se confirma la existencia de uno ajeno. */
  ownedProduct(sellerId, productId) {
    const product = this.catalog.products.repository.byId(productId);
    if (!product || product.sellerId !== sellerId) throw new NotFoundError('producto', productId);
    return product;
  }

  sellerProducts(sellerId, { status = null } = {}) {
    return this.catalog.products.repository
      .all({ sellerId })
      .filter(product => !status || product.status === status)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  /** Vista para el panel del vendedor: con variantes, precios y stock por variante. */
  managementView(product) {
    const variants = this.catalog.variants.forProduct(product.id).map(variant => {
      const price = this.pricing.prices.forVariant(variant.id).find(row => row.currencyCode === this.currency && !row.priceListId) || null;
      const availability = this.inventory.service.availabilityFor(variant.id);
      return {
        id: variant.id,
        title: variant.title,
        sku: variant.sku,
        price: price?.amount ?? null,
        compareAtPrice: price?.compareAtAmount ?? null,
        stock: availability.available,
        stockState: availability.state,
        manageInventory: variant.manageInventory,
        optionValues: variant.optionValues || {},
      };
    });
    const assets = (product.assetIds || []).map(id => this.catalog.assets.repository.byId(id)).filter(Boolean);
    return {
      id: product.id,
      handle: product.handle,
      name: product.name,
      subtitle: product.subtitle,
      description: product.description,
      status: product.status,
      commercialModel: product.commercialModel,
      categoryId: product.categoryId,
      brand: product.brand,
      tags: (product.tagIds || []).map(id => this.catalog.tags.repository.byId(id)?.value).filter(Boolean),
      price: product.price,
      deliveryModes: product.deliveryModes || [],
      shippingInfo: product.shippingInfo || {},
      images: [...assets.map(asset => ({ id: asset.id, url: asset.url, alt: asset.alt })), ...(product.metadata?.imageUrls || []).map(url => ({ id: null, url, alt: product.name }))],
      variants,
      viewCount: product.viewCount || 0,
      favoriteCount: product.metadata?.favoriteCount || 0,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
      publishedAt: product.publishedAt,
    };
  }

  /** Etiquetas por valor: se reutiliza la existente o se crea. */
  async tagIds(values = [], ctx = null) {
    const ids = [];
    for (const raw of values) {
      const value = String(raw || '').trim().toLowerCase().slice(0, 40);
      if (!value) continue;
      const existing = this.catalog.tags.repository.find({ value });
      ids.push(existing ? existing.id : (await this.catalog.tags.create({ value }, ctx)).id);
    }
    return [...new Set(ids)];
  }

  assertCategory(categoryId) {
    const category = this.catalog.categories.repository.byId(categoryId);
    if (!category || category.internal) throw ValidationError.single('categoryId', 'La categoría no existe.');
    return category;
  }

  /**
   * Imágenes: solo activos subidos a la plataforma o rutas locales de `/uploads`.
   * No se aceptan URLs externas (evita hotlinking y rastreo de terceros). Un activo
   * deduplicado por contenido puede compartirse: son los mismos bytes públicos.
   */
  assertImages(input) {
    for (const url of input.imageUrls || []) {
      if (!LOCAL_IMAGE.test(url)) throw ValidationError.single('imageUrls', 'Solo se admiten imágenes subidas a la plataforma.');
    }
    for (const assetId of input.assetIds || []) {
      if (!this.catalog.assets.repository.byId(assetId)) throw ValidationError.single('assetIds', `La imagen ${assetId} no existe.`);
    }
  }

  /** Genera un SKU legible y único si la tienda no indicó uno. */
  generateSku(prefix, name, index = 0) {
    const base = `${slug(prefix, { maxLength: 10 })}-${slug(name, { maxLength: 18 })}`.toUpperCase();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = `${base}${index ? `-${index}` : ''}${attempt ? `-${attempt + 1}` : ''}`.slice(0, 80);
      if (!this.catalog.variants.repository.find({ sku: candidate })) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`.toUpperCase().slice(0, 80);
  }

  normalizeVariants(input, { prefix }) {
    const variants = input.variants?.length
      ? input.variants
      : [{ title: 'Estándar', sku: input.sku, price: input.price, compareAtPrice: input.compareAtPrice, stock: input.stock, weight: input.weight }];
    if (!variants.every(variant => Number.isInteger(variant.price) && variant.price > 0)) {
      throw ValidationError.single('price', 'Indica un precio mayor que cero en guaraníes.');
    }
    const skus = new Set();
    return variants.map((variant, index) => {
      const sku = (variant.sku || this.generateSku(prefix, input.name, variants.length > 1 ? index + 1 : 0)).toUpperCase();
      if (skus.has(sku)) throw ValidationError.single('variants', `SKU repetido en el formulario: ${sku}.`);
      skus.add(sku);
      if (variant.compareAtPrice && variant.compareAtPrice <= variant.price) {
        throw ValidationError.single('compareAtPrice', 'El precio anterior debe ser mayor que el precio actual.');
      }
      return { ...variant, sku };
    });
  }

  /**
   * Crea una publicación completa. `owner` decide el modelo comercial:
   *  - `{ sellerId }` -> LOCAL;
   *  - `{ supplierId, cost }` -> DROPSHIPPING (solo administración);
   *  - `{}` -> PROPIO (solo administración).
   */
  async create(owner, rawInput, ctx = null) {
    const input = validate(rawInput, LISTING_INPUT);
    const category = this.assertCategory(input.categoryId);
    this.assertImages(input, owner.sellerId || null);
    const seller = owner.sellerId ? this.accounts.sellers.repository.retrieve(owner.sellerId) : null;
    if (seller) this.assertPlanLimit(seller);
    const model = owner.sellerId ? 'LOCAL' : owner.supplierId ? 'DROPSHIPPING' : 'PROPIO';
    const variants = this.normalizeVariants(input, { prefix: seller?.code || owner.supplierId || 'ndv' });
    for (const variant of variants) {
      if (this.catalog.variants.repository.find({ sku: variant.sku })) {
        throw new ConflictError(`Ya existe un producto con el SKU ${variant.sku}.`, { sku: variant.sku });
      }
    }

    const primary = variants[0];
    const deliveryModes = input.deliveryModes?.length
      ? input.deliveryModes
      : model === 'DROPSHIPPING' ? ['supplier_shipping'] : seller?.deliveryModes || ['pickup'];
    const product = await this.catalog.products.create({
      name: input.name,
      subtitle: input.subtitle || null,
      description: input.description || '',
      status: 'draft',
      type: input.type || 'physical',
      monetizationType: 'DIRECT',
      monetizationPriority: 'direct',
      commercialModel: model,
      sellerId: owner.sellerId || null,
      supplierId: owner.supplierId || null,
      localityId: seller?.localityId || this.settings.get('marketplace.defaultLocalityId', null),
      brand: input.brand || null,
      categoryId: category.id,
      categoryIds: [category.id, ...(category.parentId ? [category.parentId] : [])],
      tagIds: await this.tagIds(input.tags || [], ctx),
      assetIds: input.assetIds || [],
      primaryAssetId: input.assetIds?.[0] || null,
      image: input.imageUrls?.[0] || null,
      deliveryModes,
      shippingInfo: input.shippingInfo || {},
      price: {
        amount: primary.price,
        previousAmount: primary.compareAtPrice || null,
        currency: this.currency,
        source: 'manual',
        updatedAt: now(),
      },
      metadata: { imageUrls: input.imageUrls || [], createdVia: 'marketplace' },
    }, ctx);

    try {
      for (const [index, variant] of variants.entries()) {
        await this.createVariant(product, variant, { index, owner, input }, ctx);
      }
    } catch (error) {
      // Sin variantes el producto no sirve: se retira el borrador en lugar de dejarlo a medias.
      await this.catalog.products.delete(product.id, ctx).catch(() => {});
      throw error;
    }

    if (input.status === 'published') await this.publish(product.id, ctx);
    return this.managementView(this.catalog.products.repository.retrieve(product.id));
  }

  async createVariant(product, variant, { index, owner, input }, ctx) {
    const tracked = variant.stock !== undefined && variant.stock !== null;
    const created = await this.catalog.variants.create({
      productId: product.id,
      title: variant.title,
      sku: variant.sku,
      optionValues: variant.optionValues || {},
      manageInventory: tracked,
      weight: variant.weight ?? input.weight ?? undefined,
      length: input.length,
      width: input.width,
      height: input.height,
      rank: index,
      isDefault: index === 0,
      active: true,
    }, ctx);
    await this.pricing.prices.create({
      variantId: created.id,
      currencyCode: this.currency,
      amount: variant.price,
      compareAtAmount: variant.compareAtPrice || undefined,
      includesTax: true,
      active: true,
    }, ctx);
    if (tracked) await this.setStock(created, variant.stock, { owner, reason: 'Stock inicial de la publicación' }, ctx);
    return created;
  }

  /** Ubicación de stock según el responsable: tienda, proveedor o depósito propio. */
  locationFor(owner) {
    if (owner.sellerId) {
      const location = this.accounts.stockLocationFor(owner.sellerId);
      if (location) return location;
    }
    if (owner.supplierId) {
      const location = this.inventory.locations.repository.all().find(row => row.metadata?.supplierId === owner.supplierId);
      if (location) return location;
    }
    return this.inventory.locations.default?.() || this.inventory.locations.repository.all({ active: true })[0];
  }

  /** Fija el stock físico de una variante en la ubicación del responsable. */
  async setStock(variant, target, { owner, reason = 'Ajuste desde el panel de la tienda' }, ctx = null) {
    if (!variant.sku) throw ValidationError.single('sku', 'La variante necesita SKU para controlar stock.');
    let item = this.inventory.items.bySku(variant.sku);
    if (!item) item = await this.inventory.items.create({ sku: variant.sku, title: variant.title }, ctx);
    if (!variant.manageInventory) {
      await this.catalog.variants.update(variant.id, { manageInventory: true }, ctx);
    }
    const location = this.locationFor(owner);
    if (!location) throw new ConflictError('No hay una ubicación de stock disponible.');
    const current = this.inventory.service.stocked(item.id, { locationId: location.id });
    const delta = Number(target) - current;
    if (delta !== 0) {
      await this.inventory.service.adjust({ inventoryItemId: item.id, locationId: location.id, delta, reason }, ctx);
    }
    return { variantId: variant.id, stocked: Number(target), locationId: location.id };
  }

  /** Límite de productos del plan de la tienda, si el plan lo define. */
  assertPlanLimit(seller) {
    if (!seller.planId) return;
    const plan = this.store.collection('sellerPlans').find(row => row.id === seller.planId && !row.deletedAt);
    if (!plan?.maxProducts) return;
    const count = this.catalog.products.repository.count({ sellerId: seller.id });
    if (count >= plan.maxProducts) {
      throw new ConflictError(`Tu plan ${plan.name} permite hasta ${plan.maxProducts} productos.`, { maxProducts: plan.maxProducts });
    }
  }

  /** Actualización parcial: datos, precio y stock de la variante principal. */
  async update(owner, productId, rawInput, ctx = null) {
    const product = owner.sellerId ? this.ownedProduct(owner.sellerId, productId) : this.catalog.products.repository.retrieve(productId);
    const input = validate(rawInput, LISTING_INPUT, { partial: true });
    if (input.categoryId) this.assertCategory(input.categoryId);
    this.assertImages(input, owner.sellerId || null);
    const changes = {};
    for (const field of ['name', 'subtitle', 'description', 'brand', 'deliveryModes', 'shippingInfo', 'type']) {
      if (Object.hasOwn(input, field)) changes[field] = input[field];
    }
    if (input.categoryId) {
      const category = this.assertCategory(input.categoryId);
      changes.categoryId = category.id;
      changes.categoryIds = [category.id, ...(category.parentId ? [category.parentId] : [])];
    }
    if (input.tags) changes.tagIds = await this.tagIds(input.tags, ctx);
    if (input.assetIds) {
      changes.assetIds = input.assetIds;
      changes.primaryAssetId = input.assetIds[0] || null;
    }
    if (input.imageUrls) {
      changes.image = input.imageUrls[0] || null;
      changes.metadata = { ...(product.metadata || {}), imageUrls: input.imageUrls };
    }

    const variants = this.catalog.variants.forProduct(product.id);
    const primary = variants.find(variant => variant.isDefault) || variants[0];
    if (primary && (Object.hasOwn(input, 'price') || Object.hasOwn(input, 'compareAtPrice'))) {
      const priceRow = this.pricing.prices.forVariant(primary.id).find(row => row.currencyCode === this.currency && !row.priceListId);
      const amount = input.price ?? priceRow?.amount ?? product.price?.amount;
      const compareAt = Object.hasOwn(input, 'compareAtPrice') ? input.compareAtPrice : priceRow?.compareAtAmount ?? null;
      if (compareAt && compareAt <= amount) throw ValidationError.single('compareAtPrice', 'El precio anterior debe ser mayor que el precio actual.');
      if (priceRow) await this.pricing.prices.update(priceRow.id, { amount, compareAtAmount: compareAt || null }, ctx);
      else await this.pricing.prices.create({ variantId: primary.id, currencyCode: this.currency, amount, compareAtAmount: compareAt || undefined, includesTax: true }, ctx);
      changes.price = { amount, previousAmount: compareAt || null, currency: this.currency, source: 'manual', updatedAt: now() };
    }
    if (Object.keys(changes).length) await this.catalog.products.update(product.id, changes, ctx);
    if (primary && Object.hasOwn(input, 'stock') && input.stock !== null && input.stock !== undefined) {
      await this.setStock(primary, input.stock, { owner }, ctx);
    }
    for (const variantInput of input.variants || []) {
      await this.updateVariant(owner, product, variants, variantInput, ctx);
    }
    await this.events.emit('marketplace.listing.updated', { productId: product.id, sellerId: product.sellerId });
    return this.managementView(this.catalog.products.repository.retrieve(product.id));
  }

  async updateVariant(owner, product, variants, input, ctx) {
    const existing = input.id ? variants.find(variant => variant.id === input.id) : null;
    if (input.id && !existing) throw new NotFoundError('variante', input.id);
    if (!existing) {
      const [normalized] = this.normalizeVariants({ name: product.name, variants: [input] }, { prefix: owner.sellerId ? this.accounts.sellers.repository.byId(owner.sellerId)?.code : 'ndv' });
      if (this.catalog.variants.repository.find({ sku: normalized.sku })) throw new ConflictError(`Ya existe el SKU ${normalized.sku}.`);
      return this.createVariant(product, normalized, { index: variants.length, owner, input: {} }, ctx);
    }
    if (input.title && input.title !== existing.title) await this.catalog.variants.update(existing.id, { title: input.title }, ctx);
    const priceRow = this.pricing.prices.forVariant(existing.id).find(row => row.currencyCode === this.currency && !row.priceListId);
    if (priceRow && (input.price !== priceRow.amount || (input.compareAtPrice ?? null) !== (priceRow.compareAtAmount ?? null))) {
      await this.pricing.prices.update(priceRow.id, { amount: input.price, compareAtAmount: input.compareAtPrice || null }, ctx);
    }
    if (input.stock !== undefined && input.stock !== null) await this.setStock(existing, input.stock, { owner }, ctx);
    return existing;
  }

  /**
   * Publicar pasa por las reglas del catálogo (`assertPublishable`). Si la
   * instalación exige moderación, la ficha queda `proposed` hasta que la revise
   * administración.
   */
  async publish(productId, ctx = null, { moderated = null } = {}) {
    const product = this.catalog.products.repository.retrieve(productId);
    const requiresModeration = moderated ?? (product.commercialModel === 'LOCAL' && this.settings.get('marketplace.productModerationRequired', false));
    const target = requiresModeration ? 'proposed' : 'published';
    if (product.status === target) return product;
    if (target === 'published') this.catalog.products.assertPublishable(product);
    const updated = await this.catalog.products.update(productId, { status: target }, ctx);
    if (target === 'published') await this.events.emit('marketplace.listing.published', { productId, sellerId: product.sellerId });
    return updated;
  }

  async unpublish(productId, ctx = null) {
    const product = this.catalog.products.repository.retrieve(productId);
    if (product.status !== 'published' && product.status !== 'proposed') return product;
    return this.catalog.products.update(productId, { status: 'draft' }, ctx);
  }

  /**
   * Importación CSV con informe por fila. `dryRun` (por defecto) valida sin
   * escribir: duplicados de SKU, nombres repetidos en la tienda, categorías
   * desconocidas y datos incompletos se informan antes de crear nada.
   */
  async importCsv(owner, { csv, dryRun = true, publish = false }, ctx = null) {
    let rows;
    try {
      rows = parseCsv(csv, { maxRows: 2001 });
    } catch (error) {
      throw ValidationError.single('csv', `CSV no válido: ${error.message}`);
    }
    if (rows.length < 2) throw ValidationError.single('csv', 'El CSV necesita cabecera y al menos una fila.');
    const header = rows[0].map(cell => cell.trim().toLowerCase());
    const required = ['name', 'category', 'price'];
    const missing = required.filter(column => !header.includes(column));
    if (missing.length) throw ValidationError.single('csv', `Faltan columnas: ${missing.join(', ')}.`);
    if (rows.length > 501) throw ValidationError.single('csv', 'Máximo 500 filas por importación.');

    const categories = this.catalog.categories.repository.all();
    const findCategory = value => {
      const needle = String(value || '').trim().toLowerCase();
      return categories.find(row => row.id === value || row.handle === needle || row.name.toLowerCase() === needle) || null;
    };
    const existingNames = new Set((owner.sellerId ? this.sellerProducts(owner.sellerId) : this.catalog.products.repository.all())
      .map(product => slug(product.name)));
    const seenSkus = new Set();
    const seenNames = new Set();
    const report = { dryRun, total: rows.length - 1, valid: 0, created: 0, skipped: 0, rows: [] };

    for (const [offset, cells] of rows.slice(1).entries()) {
      const line = offset + 2;
      const record = Object.fromEntries(header.map((column, index) => [column, (cells[index] ?? '').trim()]));
      if (!Object.values(record).some(Boolean)) continue;
      const issues = [];
      const category = findCategory(record.category);
      if (!category) issues.push(`Categoría desconocida: "${record.category}".`);
      const input = {
        name: record.name,
        description: record.description || '',
        categoryId: category?.id,
        price: record.price,
        compareAtPrice: record.compare_at_price || undefined,
        sku: record.sku ? record.sku.toUpperCase() : undefined,
        stock: record.stock === '' || record.stock === undefined ? undefined : record.stock,
        brand: record.brand || undefined,
        tags: record.tags ? record.tags.split(/[;|]/).map(tag => tag.trim()).filter(Boolean) : undefined,
        weight: record.weight_g || undefined,
        deliveryModes: record.delivery_modes ? record.delivery_modes.split(/[;|]/).map(mode => mode.trim()).filter(Boolean) : undefined,
      };
      const checked = check(input, LISTING_INPUT);
      if (!checked.valid) issues.push(...checked.issues.map(issue => `${issue.field}: ${issue.message}`));
      const nameKey = slug(record.name || '');
      if (nameKey && (existingNames.has(nameKey) || seenNames.has(nameKey))) issues.push('Ya existe un producto con ese nombre en la tienda.');
      if (input.sku) {
        if (seenSkus.has(input.sku)) issues.push(`SKU repetido en el archivo: ${input.sku}.`);
        if (this.catalog.variants.repository.find({ sku: input.sku })) issues.push(`El SKU ${input.sku} ya existe.`);
      }
      seenNames.add(nameKey);
      if (input.sku) seenSkus.add(input.sku);
      if (issues.length) {
        report.skipped += 1;
        report.rows.push({ line, status: 'error', name: record.name || null, issues });
        continue;
      }
      report.valid += 1;
      if (dryRun) {
        report.rows.push({ line, status: 'valid', name: record.name });
        continue;
      }
      try {
        const created = await this.create(owner, { ...checked.value, status: publish ? 'published' : 'draft' }, ctx);
        report.created += 1;
        report.rows.push({ line, status: 'created', name: record.name, productId: created.id });
      } catch (error) {
        report.skipped += 1;
        report.rows.push({ line, status: 'error', name: record.name, issues: [error.message] });
      }
    }
    return report;
  }
}
