/**
 * Catálogo (M-0321 … M-0380, M-0411 … M-0435).
 *
 * Reúne producto, variante, opciones, colecciones, categorías, facetas, etiquetas y
 * activos. Es un solo módulo porque son un mismo agregado: una variante sin producto
 * no existe, y publicar un producto valida sus variantes. Medusa agrupa igual su
 * módulo `product`.
 *
 * El producto afiliado heredado no es un tipo aparte: es un producto con
 * `monetizationType: 'AFFILIATE'` (M-0431), lo que permite que un mismo producto
 * tenga enlace afiliado y venta directa a la vez (M-0432).
 */
import { BaseService, crudRoutes, defineResource, LIST_QUERY, parseOrder, buildFilter } from '../base.js';
import { rule, validate } from '../../framework/validate.js';
import { ConflictError, NotFoundError, ValidationError } from '../../framework/errors.js';
import { slug, uniqueSlug, normalizeForSearch } from '../../framework/strings.js';
import { discountPercent } from '../../framework/money.js';
import { ageInDays, now } from '../../framework/dates.js';

export const PRODUCT_STATUSES = ['draft', 'proposed', 'published', 'rejected'];
export const PRODUCT_TYPES = ['physical', 'digital', 'service', 'course', 'bundle', 'subscription', 'other'];
export const MONETIZATION = ['AFFILIATE', 'DIRECT', 'BOTH'];

/** Transiciones válidas del estado de un producto (M-0335). */
export const STATUS_TRANSITIONS = {
  draft: ['proposed', 'published', 'rejected'],
  proposed: ['published', 'rejected', 'draft'],
  published: ['draft', 'rejected'],
  rejected: ['draft', 'proposed'],
};

export const assetResource = defineResource({
  name: 'asset',
  collection: 'assets',
  prefix: 'asset',
  route: 'assets',
  searchable: ['name', 'alt'],
  fields: {
    name: rule.text(160, { required: true }),
    url: rule.text(500, { required: true }),
    filename: rule.text(200),
    mime: rule.text(60),
    bytes: { type: 'integer', coerce: true, min: 0 },
    width: { type: 'integer', coerce: true, min: 0 },
    height: { type: 'integer', coerce: true, min: 0 },
    hash: rule.text(80),
    // Texto alternativo obligatorio: sin él la ficha no es accesible (M-0326).
    alt: rule.text(300, { required: true }),
    focalPoint: { type: 'object', shape: { x: { type: 'number', coerce: true, min: 0, max: 1 }, y: { type: 'number', coerce: true, min: 0, max: 1 } } },
    tags: rule.list({ type: 'string' }, { default: [] }),
    provider: rule.text(40, { default: 'local' }),
    metadata: rule.metadata(),
  },
});

export const tagResource = defineResource({
  name: 'tag',
  collection: 'tags',
  prefix: 'tag',
  route: 'tags',
  unique: ['value'],
  searchable: ['value'],
  fields: {
    value: rule.text(60, { required: true }),
    description: rule.text(200),
    metadata: rule.metadata(),
  },
});

export const categoryResource = defineResource({
  name: 'category',
  collection: 'categories',
  prefix: 'pcat',
  route: 'categories',
  unique: ['handle'],
  searchable: ['name', 'handle'],
  translatable: ['name', 'description'],
  fields: {
    name: rule.text(120, { required: true }),
    handle: rule.handle(),
    description: rule.text(2000),
    parentId: rule.id(),
    // Ruta materializada para consultar el subárbol sin recursión (M-0354).
    path: rule.text(500),
    depth: { type: 'integer', coerce: true, min: 0, max: 10 },
    rank: { type: 'integer', coerce: true, min: 0, max: 100000, default: 0 },
    visible: rule.flag({ default: true }),
    internal: rule.flag({ default: false }),
    assetId: rule.id(),
    seo: { type: 'object', shape: { title: rule.text(160), description: rule.text(300), canonical: rule.text(300) } },
    metadata: rule.metadata(),
  },
});

export const collectionResource = defineResource({
  name: 'collection',
  collection: 'collections',
  prefix: 'pcol',
  route: 'collections',
  unique: ['handle'],
  searchable: ['name', 'handle'],
  translatable: ['name', 'description'],
  fields: {
    name: rule.text(120, { required: true }),
    handle: rule.handle(),
    description: rule.text(2000),
    // `manual` usa `productIds`; `rules` evalúa condiciones al vuelo (M-0352).
    mode: rule.enumOf(['manual', 'rules'], { default: 'manual' }),
    productIds: rule.list({ type: 'string' }, { default: [] }),
    rules: {
      type: 'object',
      shape: {
        categoryIds: rule.list({ type: 'string' }),
        tagIds: rule.list({ type: 'string' }),
        facetValueIds: rule.list({ type: 'string' }),
        types: rule.list({ type: 'string' }),
        brands: rule.list({ type: 'string' }),
        minPrice: rule.minor(),
        maxPrice: rule.minor(),
        monetizationType: rule.enumOf(MONETIZATION),
      },
    },
    rank: { type: 'integer', coerce: true, min: 0, default: 0 },
    visible: rule.flag({ default: true }),
    assetId: rule.id(),
    seo: { type: 'object', shape: { title: rule.text(160), description: rule.text(300), canonical: rule.text(300) } },
    metadata: rule.metadata(),
  },
});

export const facetResource = defineResource({
  name: 'facet',
  collection: 'facets',
  prefix: 'fac',
  route: 'facets',
  unique: ['code'],
  searchable: ['name', 'code'],
  translatable: ['name'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(100, { required: true }),
    // `single` permite un valor por producto; `multiple`, varios (M-0358).
    selection: rule.enumOf(['single', 'multiple'], { default: 'multiple' }),
    private: rule.flag({ default: false }),
    filterable: rule.flag({ default: true }),
    rank: { type: 'integer', coerce: true, min: 0, default: 0 },
    metadata: rule.metadata(),
  },
});

export const facetValueResource = defineResource({
  name: 'facetValue',
  collection: 'facetValues',
  prefix: 'facval',
  route: 'facet-values',
  searchable: ['name', 'code'],
  translatable: ['name'],
  fields: {
    facetId: rule.id({ required: true }),
    code: rule.handle({ required: true }),
    name: rule.text(100, { required: true }),
    rank: { type: 'integer', coerce: true, min: 0, default: 0 },
    metadata: rule.metadata(),
  },
});

export const optionResource = defineResource({
  name: 'productOption',
  collection: 'productOptions',
  prefix: 'opt',
  route: 'product-options',
  searchable: ['name'],
  translatable: ['name'],
  fields: {
    productId: rule.id({ required: true }),
    name: rule.text(80, { required: true }),
    code: rule.handle(),
    rank: { type: 'integer', coerce: true, min: 0, default: 0 },
    values: rule.list({ type: 'string' }, { default: [] }),
    metadata: rule.metadata(),
  },
});

export const variantResource = defineResource({
  name: 'variant',
  collection: 'variants',
  prefix: 'var',
  route: 'variants',
  unique: ['sku'],
  searchable: ['title', 'sku', 'barcode'],
  translatable: ['title'],
  fields: {
    productId: rule.id({ required: true }),
    title: rule.text(160, { required: true }),
    sku: rule.text(80),
    ean: rule.text(20),
    upc: rule.text(20),
    gtin: rule.text(20),
    barcode: rule.text(60),
    hsCode: rule.text(20),
    originCountry: rule.country(),
    material: rule.text(120),
    weight: { type: 'number', coerce: true, min: 0 },
    length: { type: 'number', coerce: true, min: 0 },
    width: { type: 'number', coerce: true, min: 0 },
    height: { type: 'number', coerce: true, min: 0 },
    dimensionUnit: rule.enumOf(['cm', 'mm', 'in'], { default: 'cm' }),
    weightUnit: rule.enumOf(['g', 'kg', 'lb', 'oz'], { default: 'g' }),
    optionValues: { type: 'object', shape: {}, allowUnknown: true },
    assetIds: rule.list({ type: 'string' }, { default: [] }),
    manageInventory: rule.flag({ default: true }),
    allowBackorder: rule.flag({ default: false }),
    taxCategoryId: rule.id(),
    // Componentes de un paquete: `[{variantId, quantity}]` (M-0362, M-0515).
    components: rule.list({ type: 'object', shape: { variantId: rule.id({ required: true }), quantity: rule.quantity({ required: true }) } }, { default: [] }),
    digital: {
      type: 'object',
      shape: {
        deliverableUrl: rule.text(500),
        downloadLimit: { type: 'integer', coerce: true, min: 0 },
        expiresInDays: { type: 'integer', coerce: true, min: 0 },
      },
    },
    subscription: {
      type: 'object',
      shape: {
        intervalUnit: rule.enumOf(['day', 'week', 'month', 'year']),
        intervalCount: { type: 'integer', coerce: true, min: 1, max: 60 },
        trialDays: { type: 'integer', coerce: true, min: 0, max: 365 },
      },
    },
    rank: { type: 'integer', coerce: true, min: 0, default: 0 },
    isDefault: rule.flag({ default: false }),
    active: rule.flag({ default: true }),
    metadata: rule.metadata(),
  },
});

export const productResource = defineResource({
  name: 'product',
  collection: 'products',
  prefix: 'prod',
  route: 'products',
  unique: ['handle'],
  searchable: ['name', 'subtitle', 'description', 'brand'],
  translatable: ['name', 'subtitle', 'description', 'handle'],
  fields: {
    name: rule.text(200, { required: true }),
    handle: rule.handle(),
    subtitle: rule.text(300),
    description: rule.longText(),
    shortDescription: rule.text(500),
    status: rule.enumOf(PRODUCT_STATUSES, { default: 'draft' }),
    type: rule.enumOf(PRODUCT_TYPES, { default: 'physical' }),
    monetizationType: rule.enumOf(MONETIZATION, { default: 'AFFILIATE' }),
    monetizationPriority: rule.enumOf(['affiliate', 'direct'], { default: 'affiliate' }),
    brand: rule.text(120),
    manufacturer: rule.text(120),
    categoryId: rule.id(),
    categoryIds: rule.list({ type: 'string' }, { default: [] }),
    collectionIds: rule.list({ type: 'string' }, { default: [] }),
    tagIds: rule.list({ type: 'string' }, { default: [] }),
    facetValueIds: rule.list({ type: 'string' }, { default: [] }),
    channelIds: rule.list({ type: 'string' }, { default: [] }),
    assetIds: rule.list({ type: 'string' }, { default: [] }),
    primaryAssetId: rule.id(),
    // Emoji o URL heredado de la v0.1; se conserva para no perder las fichas actuales.
    image: rule.text(500),
    shippingProfileId: rule.id(),
    taxCategoryId: rule.id(),
    relatedProductIds: rule.list({ type: 'string' }, { default: [] }),
    alternativeProductIds: rule.list({ type: 'string' }, { default: [] }),
    accessoryProductIds: rule.list({ type: 'string' }, { default: [] }),
    featured: rule.flag({ default: false }),
    featuredRank: { type: 'integer', coerce: true, min: 0, default: 0 },
    seo: {
      type: 'object',
      shape: {
        title: rule.text(160),
        description: rule.text(300),
        canonical: rule.text(300),
        socialImage: rule.text(300),
        noindex: rule.flag(),
      },
    },
    // Campos afiliados heredados de la v0.1 (M-0167, M-0168).
    merchantId: rule.id(),
    programId: rule.id(),
    campaignId: rule.id(),
    price: {
      type: 'object',
      shape: {
        amount: rule.minor(),
        previousAmount: rule.minor(),
        currency: rule.currency(),
        source: rule.enumOf(['manual', 'import_csv', 'feed', 'unknown']),
        updatedAt: rule.date(),
      },
    },
    publishedAt: rule.date(),
    metadata: rule.metadata(),
  },
});

export class AssetService extends BaseService {
  constructor(deps) {
    super(deps, assetResource);
    this.files = deps.files;
  }

  /** Deduplicación por hash del contenido (M-0330). */
  byHash(hash) {
    return hash ? this.repository.find({ hash }) : null;
  }

  async upload({ data, name, alt, tags = [] }, ctx = null) {
    const stored = await this.files.store(data);
    const existing = this.byHash(stored.hash);
    if (existing) {
      await this.files.remove(stored.filename).catch(() => {});
      return existing;
    }
    return this.create({
      name: name || stored.filename,
      alt: alt || name || 'Imagen del catálogo',
      url: stored.url,
      filename: stored.filename,
      mime: stored.mime,
      bytes: stored.bytes,
      width: stored.dimensions.width,
      height: stored.dimensions.height,
      hash: stored.hash,
      provider: stored.provider,
      tags,
    }, ctx);
  }

  /** No se borra un activo en uso (M-0329). */
  async beforeDelete(record) {
    const products = this.store.collection('products').filter(
      product => product.primaryAssetId === record.id || (product.assetIds || []).includes(record.id),
    );
    const variants = this.store.collection('variants').filter(variant => (variant.assetIds || []).includes(record.id));
    const total = products.length + variants.length;
    if (total) throw new ConflictError(`El activo está en uso en ${total} registro(s) del catálogo.`, { products: products.length, variants: variants.length });
  }
}

export class TagService extends BaseService {
  constructor(deps) {
    super(deps, tagResource);
  }
}

export class CategoryService extends BaseService {
  constructor(deps) {
    super(deps, categoryResource);
  }

  handles() {
    return new Set(this.repository.all().map(row => row.handle).filter(Boolean));
  }

  async beforeCreate(data) {
    const handle = data.handle || uniqueSlug(data.name, this.handles());
    return { ...data, handle, ...this.computePath(data.parentId, handle) };
  }

  async beforeUpdate(existing, changes) {
    if (changes.parentId !== undefined || changes.handle !== undefined) {
      if (changes.parentId && changes.parentId === existing.id) {
        throw ValidationError.single('parentId', 'Una categoría no puede ser su propio padre.');
      }
      if (changes.parentId && this.isDescendant(changes.parentId, existing.id)) {
        throw ValidationError.single('parentId', 'No se puede mover una categoría dentro de su propio subárbol.');
      }
      const handle = changes.handle || existing.handle;
      const parentId = changes.parentId === undefined ? existing.parentId : changes.parentId;
      Object.assign(changes, this.computePath(parentId, handle));
    }
    return changes;
  }

  computePath(parentId, handle) {
    if (!parentId) return { path: `/${handle}`, depth: 0 };
    const parent = this.repository.byId(parentId);
    if (!parent) throw new NotFoundError('categoría padre', parentId);
    return { path: `${parent.path || `/${parent.handle}`}/${handle}`, depth: (parent.depth || 0) + 1 };
  }

  isDescendant(candidateId, ancestorId) {
    let cursor = this.repository.byId(candidateId);
    let guard = 0;
    while (cursor?.parentId && guard < 20) {
      if (cursor.parentId === ancestorId) return true;
      cursor = this.repository.byId(cursor.parentId);
      guard += 1;
    }
    return false;
  }

  /** Árbol completo ordenado por `rank` entre hermanas (M-0355). */
  tree({ includeHidden = false } = {}) {
    const rows = this.repository.all(includeHidden ? {} : { visible: true, internal: false });
    const byParent = new Map();
    for (const row of rows) {
      const key = row.parentId || 'root';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(row);
    }
    const build = key => (byParent.get(key) || [])
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
      .map(row => ({ ...row, children: build(row.id) }));
    return build('root');
  }

  /** Identificadores de la categoría y todo su subárbol. */
  subtreeIds(categoryId) {
    const root = this.repository.byId(categoryId);
    if (!root) return [];
    const prefix = root.path || `/${root.handle}`;
    return this.repository
      .all()
      .filter(row => row.id === categoryId || String(row.path || '').startsWith(`${prefix}/`))
      .map(row => row.id);
  }

  async beforeDelete(record) {
    const children = this.repository.all({ parentId: record.id });
    if (children.length) throw new ConflictError(`La categoría tiene ${children.length} subcategoría(s).`, { children: children.length });
  }
}

export class CollectionService extends BaseService {
  constructor(deps) {
    super(deps, collectionResource);
  }

  async beforeCreate(data) {
    return { ...data, handle: data.handle || uniqueSlug(data.name, new Set(this.repository.all().map(row => row.handle))) };
  }

  /** Productos de una colección: manuales o los que cumplen las reglas (M-0352). */
  productsIn(collectionId, products) {
    const collection = this.repository.retrieve(collectionId);
    if (collection.mode === 'manual') {
      return products.filter(product => (collection.productIds || []).includes(product.id));
    }
    const rules = collection.rules || {};
    return products.filter(product => {
      if (rules.categoryIds?.length && !rules.categoryIds.some(id => (product.categoryIds || [product.categoryId]).includes(id))) return false;
      if (rules.tagIds?.length && !rules.tagIds.some(id => (product.tagIds || []).includes(id))) return false;
      if (rules.facetValueIds?.length && !rules.facetValueIds.some(id => (product.facetValueIds || []).includes(id))) return false;
      if (rules.types?.length && !rules.types.includes(product.type)) return false;
      if (rules.brands?.length && !rules.brands.includes(product.brand)) return false;
      if (rules.monetizationType && product.monetizationType !== rules.monetizationType) return false;
      const amount = product.price?.amount;
      if (rules.minPrice && !(amount >= rules.minPrice)) return false;
      if (rules.maxPrice && !(amount <= rules.maxPrice)) return false;
      return true;
    });
  }
}

export class FacetService extends BaseService {
  constructor(deps) {
    super(deps, facetResource);
  }
}

export class FacetValueService extends BaseService {
  constructor(deps) {
    super(deps, facetValueResource);
  }

  forFacet(facetId) {
    return this.repository.all({ facetId }).sort((a, b) => a.rank - b.rank);
  }

  /** Agrupa valores por faceta, para pintar los filtros. */
  grouped(facets) {
    const values = this.repository.all();
    return facets.map(facet => ({
      ...facet,
      values: values.filter(value => value.facetId === facet.id).sort((a, b) => a.rank - b.rank),
    }));
  }
}

export class OptionService extends BaseService {
  constructor(deps) {
    super(deps, optionResource);
  }

  forProduct(productId) {
    return this.repository.all({ productId }).sort((a, b) => a.rank - b.rank);
  }
}

export class VariantService extends BaseService {
  constructor(deps) {
    super(deps, variantResource);
    this.options = deps.options;
  }

  forProduct(productId) {
    return this.repository.all({ productId }).sort((a, b) => a.rank - b.rank);
  }

  async beforeCreate(data) {
    this.assertOptionCombination(data);
    return data;
  }

  async beforeUpdate(existing, changes) {
    if (changes.optionValues) this.assertOptionCombination({ ...existing, ...changes });
    return changes;
  }

  /** Una combinación de opciones no puede repetirse dentro del mismo producto (M-0346). */
  assertOptionCombination(variant) {
    if (!variant.optionValues || !Object.keys(variant.optionValues).length) return;
    const signature = JSON.stringify(Object.entries(variant.optionValues).sort());
    const clash = this.forProduct(variant.productId).find(
      other => other.id !== variant.id && JSON.stringify(Object.entries(other.optionValues || {}).sort()) === signature,
    );
    if (clash) {
      throw new ConflictError('Ya existe una variante con esa combinación de opciones.', { variantId: clash.id });
    }
  }

  /**
   * Genera la matriz de variantes desde las opciones del producto (M-0345).
   * No borra las existentes: solo crea las combinaciones que faltan.
   */
  async generateMatrix(productId, { skuPrefix = null } = {}, ctx = null) {
    const options = this.options.forProduct(productId);
    if (!options.length) throw new ConflictError('El producto no tiene grupos de opciones definidos.');

    const combinations = options.reduce(
      (acc, option) => acc.flatMap(partial => (option.values || []).map(value => ({ ...partial, [option.name]: value }))),
      [{}],
    );
    const existing = new Set(this.forProduct(productId).map(variant => JSON.stringify(Object.entries(variant.optionValues || {}).sort())));

    const created = [];
    for (const [index, combination] of combinations.entries()) {
      const signature = JSON.stringify(Object.entries(combination).sort());
      if (existing.has(signature)) continue;
      const title = Object.values(combination).join(' / ');
      created.push(await this.create({
        productId,
        title,
        sku: skuPrefix ? `${skuPrefix}-${slug(title, { maxLength: 24 }).toUpperCase()}` : null,
        optionValues: combination,
        rank: index,
      }, ctx));
    }
    return { created: created.length, variants: this.forProduct(productId) };
  }

  /** Disponibilidad de un paquete: la menor de sus componentes (M-0516). */
  bundleAvailability(variant, availabilityOf) {
    if (!variant.components?.length) return null;
    return Math.min(...variant.components.map(component => {
      const available = availabilityOf(component.variantId);
      return Math.floor((available ?? 0) / Math.max(1, component.quantity));
    }));
  }
}

export class ProductService extends BaseService {
  constructor(deps) {
    super(deps, productResource);
    this.variants = deps.variants;
    this.options = deps.options;
    this.categories = deps.categories;
    this.collections = deps.collections;
    this.tags = deps.tags;
    this.facets = deps.facets;
    this.facetValues = deps.facetValues;
    this.assets = deps.assets;
    this.settings = deps.settings;
    this.search = deps.search;
  }

  handles() {
    return new Set(this.repository.all({}, { withDeleted: true }).map(row => row.handle).filter(Boolean));
  }

  async beforeCreate(data) {
    const handle = data.handle || uniqueSlug(data.name, this.handles());
    return {
      ...data,
      handle,
      handleHistory: [],
      publishedAt: data.status === 'published' ? now() : null,
      viewCount: 0,
      clickCount: 0,
    };
  }

  async beforeUpdate(existing, changes) {
    if (changes.status && changes.status !== existing.status) {
      this.assertTransition(existing, changes.status);
      if (changes.status === 'published') {
        this.assertPublishable({ ...existing, ...changes });
        changes.publishedAt = existing.publishedAt || now();
      }
    }
    // Al cambiar el handle se guarda el anterior para poder redirigir (M-0336).
    if (changes.handle && changes.handle !== existing.handle) {
      changes.handleHistory = [...new Set([...(existing.handleHistory || []), existing.handle])].slice(-10);
    }
    return changes;
  }

  assertTransition(product, target) {
    const allowed = STATUS_TRANSITIONS[product.status] || [];
    if (!allowed.includes(target)) {
      throw new ConflictError(`No se puede pasar el producto de "${product.status}" a "${target}".`, {
        from: product.status,
        to: target,
        allowed,
      });
    }
  }

  /**
   * Reglas de publicación (M-0374, M-0375, M-0444).
   * Un producto afiliado no se publica con un enlace inválido: sería enviar tráfico
   * a una URL que ya se sabe que falla.
   */
  assertPublishable(product) {
    const issues = [];
    const variants = this.variants.forProduct(product.id);
    const isAffiliate = product.monetizationType !== 'DIRECT';
    const isDirect = product.monetizationType !== 'AFFILIATE';

    if (isDirect) {
      if (!variants.length) issues.push({ field: 'variants', message: 'Un producto de venta directa necesita al menos una variante.' });
      const withoutSku = variants.filter(variant => !variant.sku);
      if (withoutSku.length) issues.push({ field: 'variants', message: `${withoutSku.length} variante(s) sin SKU.` });
    }

    if (isAffiliate && this.settings.get('affiliate.requireValidLinkToPublish', true)) {
      const links = this.store.collection('affiliateLinks').filter(link => link.productId === product.id && !link.deletedAt);
      if (!links.length) {
        issues.push({ field: 'affiliateLink', message: 'Un producto afiliado necesita al menos un enlace.' });
      } else if (!links.some(link => link.status === 'valid' || link.status === 'warning')) {
        issues.push({ field: 'affiliateLink', message: 'Todos los enlaces del producto están marcados como inválidos.' });
      }
    }

    if (!isDirect && !isAffiliate) issues.push({ field: 'monetizationType', message: 'Tipo de monetización no reconocido.' });
    if (issues.length) throw new ValidationError(issues);
    return true;
  }

  byHandle(handle) {
    return this.repository.find({ handle }) || this.repository.all().find(row => (row.handleHistory || []).includes(handle)) || null;
  }

  published(filter = {}) {
    return this.repository.all({ status: 'published', ...filter });
  }

  /** Proyección completa con sus relaciones (M-0876). */
  expand(product, relations = ['variants', 'category', 'assets']) {
    const wanted = new Set(relations);
    const output = { ...product };
    if (wanted.has('variants')) output.variants = this.variants.forProduct(product.id);
    if (wanted.has('options')) output.options = this.options.forProduct(product.id);
    if (wanted.has('category')) output.category = product.categoryId ? this.categories.repository.byId(product.categoryId) : null;
    if (wanted.has('categories')) {
      output.categories = (product.categoryIds || []).map(id => this.categories.repository.byId(id)).filter(Boolean);
    }
    if (wanted.has('collections')) {
      output.collections = (product.collectionIds || []).map(id => this.collections.repository.byId(id)).filter(Boolean);
    }
    if (wanted.has('tags')) output.tags = (product.tagIds || []).map(id => this.tags.repository.byId(id)).filter(Boolean);
    if (wanted.has('facets')) {
      const values = (product.facetValueIds || []).map(id => this.facetValues.repository.byId(id)).filter(Boolean);
      output.facetValues = values.map(value => ({ ...value, facet: this.facets.repository.byId(value.facetId) }));
    }
    if (wanted.has('assets')) {
      output.assets = (product.assetIds || []).map(id => this.assets.repository.byId(id)).filter(Boolean);
      output.primaryAsset = product.primaryAssetId ? this.assets.repository.byId(product.primaryAssetId) : output.assets[0] || null;
    }
    return output;
  }

  /** Puntuación de completitud editorial (M-0411). */
  completeness(product) {
    const checks = [
      { key: 'name', weight: 10, ok: Boolean(product.name && product.name.length > 8) },
      { key: 'subtitle', weight: 5, ok: Boolean(product.subtitle) },
      { key: 'description', weight: 15, ok: Boolean(product.description && product.description.length > 80) },
      { key: 'category', weight: 10, ok: Boolean(product.categoryId || product.categoryIds?.length) },
      { key: 'brand', weight: 5, ok: Boolean(product.brand) },
      { key: 'asset', weight: 15, ok: Boolean(product.primaryAssetId || product.assetIds?.length) },
      { key: 'price', weight: 15, ok: Number.isFinite(Number(product.price?.amount)) },
      { key: 'facets', weight: 10, ok: Boolean(product.facetValueIds?.length) },
      { key: 'seo', weight: 5, ok: Boolean(product.seo?.title || product.seo?.description) },
      { key: 'variants', weight: 10, ok: this.variants.forProduct(product.id).length > 0 },
    ];
    const total = checks.reduce((sum, check) => sum + check.weight, 0);
    const earned = checks.filter(check => check.ok).reduce((sum, check) => sum + check.weight, 0);
    return {
      score: Math.round((earned / total) * 100),
      missing: checks.filter(check => !check.ok).map(check => check.key),
    };
  }

  /** Informe de calidad del catálogo (M-0412 … M-0425). */
  qualityReport() {
    const products = this.repository.all();
    const variants = this.store.collection('variants').filter(row => !row.deletedAt);
    const assets = new Map(this.assets.repository.all().map(asset => [asset.id, asset]));
    const staleDays = this.settings.get('affiliate.priceStaleDays', 30);
    const findings = [];

    const byDescription = new Map();
    const byName = new Map();
    for (const product of products) {
      const descriptionKey = normalizeForSearch(product.description || '').slice(0, 120);
      if (descriptionKey.length > 40) {
        byDescription.set(descriptionKey, [...(byDescription.get(descriptionKey) || []), product.id]);
      }
      const nameKey = normalizeForSearch(product.name || '');
      byName.set(nameKey, [...(byName.get(nameKey) || []), product.id]);
    }
    for (const [, ids] of byDescription) {
      if (ids.length > 1) findings.push({ code: 'duplicate_description', severity: 'warning', productIds: ids });
    }
    for (const [, ids] of byName) {
      if (ids.length > 1) findings.push({ code: 'duplicate_name', severity: 'warning', productIds: ids });
    }

    const skus = new Map();
    for (const variant of variants) {
      if (!variant.sku) continue;
      skus.set(variant.sku, [...(skus.get(variant.sku) || []), variant.id]);
    }
    for (const [sku, ids] of skus) {
      if (ids.length > 1) findings.push({ code: 'duplicate_sku', severity: 'critical', sku, variantIds: ids });
    }

    for (const product of products) {
      const amount = Number(product.price?.amount);
      const previous = Number(product.price?.previousAmount);
      if (product.status === 'published' && !Number.isFinite(amount)) {
        findings.push({ code: 'missing_price', severity: 'warning', productIds: [product.id] });
      }
      if (Number.isFinite(amount) && amount <= 0) {
        findings.push({ code: 'suspicious_price', severity: 'critical', productIds: [product.id], amount });
      }
      if (Number.isFinite(previous) && Number.isFinite(amount) && previous <= amount) {
        findings.push({ code: 'impossible_discount', severity: 'warning', productIds: [product.id] });
      }
      const primary = product.primaryAssetId ? assets.get(product.primaryAssetId) : null;
      if (product.status === 'published' && !primary && !(product.assetIds || []).length && !product.image) {
        findings.push({ code: 'missing_image', severity: 'warning', productIds: [product.id] });
      }
      if (primary && primary.width && primary.width < 600) {
        findings.push({ code: 'low_resolution_image', severity: 'info', productIds: [product.id], width: primary.width });
      }
      if (product.status === 'published' && !product.categoryId && !(product.categoryIds || []).length) {
        findings.push({ code: 'missing_category', severity: 'warning', productIds: [product.id] });
      }
      if (product.status === 'published' && !(product.channelIds || []).length) {
        findings.push({ code: 'no_channel', severity: 'info', productIds: [product.id] });
      }
      const priceAge = ageInDays(product.price?.updatedAt);
      if (product.status === 'published' && priceAge !== null && priceAge > staleDays) {
        findings.push({ code: 'stale_price', severity: 'warning', productIds: [product.id], days: priceAge });
      }
    }

    for (const asset of assets.values()) {
      if (!asset.alt) findings.push({ code: 'missing_alt_text', severity: 'warning', assetIds: [asset.id] });
    }
    for (const facet of this.facets.repository.all()) {
      if (!this.facetValues.forFacet(facet.id).length) {
        findings.push({ code: 'facet_without_values', severity: 'info', facetIds: [facet.id] });
      }
    }
    for (const category of this.categories.repository.all()) {
      const used = products.some(product => product.categoryId === category.id || (product.categoryIds || []).includes(category.id));
      const hasChildren = this.categories.repository.all({ parentId: category.id }).length > 0;
      if (!used && !hasChildren) findings.push({ code: 'orphan_category', severity: 'info', categoryIds: [category.id] });
    }

    const scores = products.map(product => ({ id: product.id, name: product.name, ...this.completeness(product) }));
    const average = scores.length ? Math.round(scores.reduce((sum, row) => sum + row.score, 0) / scores.length) : 0;

    return {
      generatedAt: now(),
      products: products.length,
      variants: variants.length,
      averageCompleteness: average,
      worst: scores.sort((a, b) => a.score - b.score).slice(0, 10),
      findings: findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity)),
      byCode: findings.reduce((acc, finding) => ({ ...acc, [finding.code]: (acc[finding.code] || 0) + 1 }), {}),
    };
  }

  /** Sugerencia de categoría por palabras del nombre (M-0428). */
  suggestCategory(product) {
    const words = new Set(normalizeForSearch(`${product.name} ${product.subtitle || ''}`).split(' '));
    const scored = this.categories.repository.all({ visible: true }).map(category => {
      const categoryWords = normalizeForSearch(category.name).split(' ');
      const hits = categoryWords.filter(word => words.has(word)).length;
      return { categoryId: category.id, name: category.name, hits };
    });
    return scored.filter(row => row.hits > 0).sort((a, b) => b.hits - a.hits).slice(0, 3);
  }

  /** Duplicado con variantes y activos (M-0369). */
  async duplicate(productId, ctx = null) {
    const source = this.repository.retrieve(productId);
    const { id: _id, createdAt: _created, updatedAt: _updated, handle, handleHistory: _history, publishedAt: _published, ...rest } = source;
    const copy = await this.create({
      ...rest,
      name: `${source.name} (copia)`,
      handle: uniqueSlug(`${handle}-copia`, this.handles()),
      status: 'draft',
    }, ctx);
    for (const option of this.options.forProduct(productId)) {
      await this.options.create({ productId: copy.id, name: option.name, code: option.code, rank: option.rank, values: option.values }, ctx);
    }
    for (const variant of this.variants.forProduct(productId)) {
      const { id: _vid, productId: _pid, createdAt: _vc, updatedAt: _vu, sku, ...variantRest } = variant;
      await this.variants.create({ ...variantRest, productId: copy.id, sku: sku ? `${sku}-COPIA` : null }, ctx);
    }
    return copy;
  }

  /** Publicación y asignación de canal en lote (M-0370, M-0371). */
  async bulkStatus(productIds, status, ctx = null) {
    return this.bulk(id => this.update(id, { status }, ctx), productIds, ctx);
  }

  async bulkChannels(productIds, channelIds, ctx = null) {
    return this.bulk(id => this.update(id, { channelIds }, ctx), productIds, ctx);
  }

  async incrementCounter(productId, field) {
    return this.store.transaction(state => {
      const row = (state.products || []).find(entry => entry.id === productId);
      if (!row) return null;
      row[field] = (row[field] || 0) + 1;
      return row[field];
    });
  }

  /** Documento para el índice de búsqueda. */
  toSearchDocument(product) {
    const variants = this.variants.forProduct(product.id);
    const facetValues = (product.facetValueIds || []).map(id => this.facetValues.repository.byId(id)).filter(Boolean);
    const facets = {};
    for (const value of facetValues) {
      const facet = this.facets.repository.byId(value.facetId);
      if (!facet || facet.private) continue;
      facets[facet.code] = [...(facets[facet.code] || []), value.code];
    }
    const category = product.categoryId ? this.categories.repository.byId(product.categoryId) : null;
    if (category) facets.categoria = [category.handle];
    return {
      id: product.id,
      fields: {
        name: product.name,
        subtitle: product.subtitle,
        description: product.shortDescription || product.description,
        brand: product.brand,
        sku: variants.map(variant => variant.sku).filter(Boolean).join(' '),
      },
      facets,
      filters: {
        status: product.status,
        type: product.type,
        monetizationType: product.monetizationType,
        categoryId: product.categoryId,
        collectionIds: product.collectionIds || [],
        channelIds: product.channelIds || [],
        price: product.price?.amount ?? null,
        createdAt: product.createdAt,
        popularity: (product.clickCount || 0) * 3 + (product.viewCount || 0),
        featured: Boolean(product.featured),
      },
      payload: {
        handle: product.handle,
        name: product.name,
        subtitle: product.subtitle,
        image: product.image,
        price: product.price || null,
        status: product.status,
        featured: Boolean(product.featured),
      },
    };
  }

  /** Reindexa todo el catálogo publicado (M-0390). */
  reindex() {
    this.search.clear();
    let count = 0;
    for (const product of this.published()) {
      this.search.put(this.toSearchDocument(product));
      count += 1;
    }
    return { indexed: count };
  }
}

function severityRank(severity) {
  return { critical: 3, warning: 2, info: 1 }[severity] || 0;
}

const SEED_CATEGORIES = [
  { id: 'pcat_tech', name: 'Tecnología', handle: 'tecnologia', path: '/tecnologia', depth: 0, rank: 10 },
  { id: 'pcat_home', name: 'Hogar', handle: 'hogar', path: '/hogar', depth: 0, rank: 20 },
  { id: 'pcat_software', name: 'Software', handle: 'software', path: '/software', depth: 0, rank: 30 },
  { id: 'pcat_education', name: 'Educación', handle: 'educacion', path: '/educacion', depth: 0, rank: 40 },
  { id: 'pcat_tech_laptops', name: 'Notebooks', handle: 'notebooks', parentId: 'pcat_tech', path: '/tecnologia/notebooks', depth: 1, rank: 10 },
  { id: 'pcat_tech_audio', name: 'Audio', handle: 'audio', parentId: 'pcat_tech', path: '/tecnologia/audio', depth: 1, rank: 20 },
  { id: 'pcat_edu_courses', name: 'Cursos online', handle: 'cursos-online', parentId: 'pcat_education', path: '/educacion/cursos-online', depth: 1, rank: 10 },
];

const SEED_FACETS = [
  { id: 'fac_brand', code: 'marca', name: 'Marca', selection: 'single', rank: 10 },
  { id: 'fac_use', code: 'uso', name: 'Uso principal', selection: 'multiple', rank: 20 },
  { id: 'fac_level', code: 'nivel', name: 'Nivel', selection: 'single', rank: 30 },
];

const SEED_FACET_VALUES = [
  { id: 'facval_lenovo', facetId: 'fac_brand', code: 'lenovo', name: 'Lenovo', rank: 10 },
  { id: 'facval_hp', facetId: 'fac_brand', code: 'hp', name: 'HP', rank: 20 },
  { id: 'facval_gaming', facetId: 'fac_use', code: 'gaming', name: 'Gaming', rank: 10 },
  { id: 'facval_work', facetId: 'fac_use', code: 'trabajo', name: 'Trabajo', rank: 20 },
  { id: 'facval_study', facetId: 'fac_use', code: 'estudio', name: 'Estudio', rank: 30 },
  { id: 'facval_beginner', facetId: 'fac_level', code: 'inicial', name: 'Inicial', rank: 10 },
  { id: 'facval_advanced', facetId: 'fac_level', code: 'avanzado', name: 'Avanzado', rank: 20 },
];

export default {
  name: 'catalog',
  requires: ['store', 'events', 'audit', 'config', 'customFields', 'translations', 'settings', 'files', 'search'],
  resources: [assetResource, tagResource, categoryResource, collectionResource, facetResource, facetValueResource, optionResource, variantResource, productResource],
  permissions: [
    { resource: 'product', description: 'Productos del catálogo.' },
    { resource: 'variant', description: 'Variantes de producto.' },
    { resource: 'productOption', description: 'Grupos de opciones.' },
    { resource: 'category', description: 'Categorías.' },
    { resource: 'collection', description: 'Colecciones.' },
    { resource: 'facet', description: 'Facetas de filtrado.' },
    { resource: 'facetValue', description: 'Valores de faceta.' },
    { resource: 'tag', description: 'Etiquetas de producto.' },
    { resource: 'asset', description: 'Activos e imágenes.' },
  ],
  customFields: [
    { entity: 'product', key: 'warrantyMonths', type: 'integer', label: 'Garantía (meses)', public: true, min: 0, max: 240 },
    { entity: 'product', key: 'editorialNote', type: 'text', label: 'Nota editorial interna', public: false },
    { entity: 'variant', key: 'packSize', type: 'integer', label: 'Unidades por paquete', public: true, min: 1 },
  ],

  register(deps) {
    const assets = new AssetService(deps);
    const tags = new TagService(deps);
    const categories = new CategoryService(deps);
    const collections = new CollectionService(deps);
    const facets = new FacetService(deps);
    const facetValues = new FacetValueService(deps);
    const options = new OptionService(deps);
    const variants = new VariantService({ ...deps, options });
    const products = new ProductService({ ...deps, assets, tags, categories, collections, facets, facetValues, options, variants });
    return { assets, tags, categories, collections, facets, facetValues, options, variants, products };
  },

  async seed(service) {
    // Las categorías heredadas de la v0.1 viven en la misma colección. Solo se
    // siembra el árbol de ejemplo si el catálogo está realmente vacío, para no
    // duplicar «Tecnología» junto a la categoría que ya existía.
    if (service.categories.repository.count() === 0) {
      await service.categories.seed(SEED_CATEGORIES, 'id');
    }
    await service.facets.seed(SEED_FACETS, 'id');
    await service.facetValues.seed(SEED_FACET_VALUES, 'id');
    await service.tags.seed([
      { id: 'tag_recomendado', value: 'recomendado' },
      { id: 'tag_oferta', value: 'oferta' },
      { id: 'tag_novedad', value: 'novedad' },
    ], 'id');
    await service.collections.seed([
      { id: 'pcol_destacados', name: 'Destacados', handle: 'destacados', mode: 'manual', rank: 10 },
      { id: 'pcol_tech', name: 'Todo tecnología', handle: 'todo-tecnologia', mode: 'rules', rules: { categoryIds: ['pcat_tech'] }, rank: 20 },
    ], 'id');
  },

  subscribers: container => [
    // Reindexado incremental: el índice se mantiene al día sin tocar el request (M-0109).
    {
      event: 'product.*',
      handler: () => {
        const catalog = container.resolve('catalog');
        if (container.resolve('config').features.search) catalog.products.reindex();
      },
    },
  ],

  jobs: container => [
    {
      name: 'catalog.reindex',
      everyMs: 30 * 60_000,
      handler: () => container.resolve('catalog').products.reindex(),
    },
    {
      name: 'catalog.quality',
      everyMs: 24 * 3_600_000,
      handler: async () => {
        const catalog = container.resolve('catalog');
        const report = catalog.products.qualityReport();
        const alerts = container.resolve('alert');
        // Alerta cuando la completitud media baja del umbral (M-0426).
        if (report.averageCompleteness < 60) {
          await alerts.raise({
            type: 'catalog_quality',
            severity: 'warning',
            message: `La completitud media del catálogo es ${report.averageCompleteness} %.`,
            entityId: null,
          });
        }
        for (const finding of report.findings.filter(item => item.severity === 'critical')) {
          await alerts.raise({
            type: `catalog_${finding.code}`,
            severity: 'critical',
            message: `Problema de catálogo detectado: ${finding.code}.`,
            entityId: finding.productIds?.[0] || finding.variantIds?.[0] || null,
          });
        }
        return report.byCode;
      },
    },
  ],

  routes: {
    admin: container => {
      const module = () => container.resolve('catalog');
      return [
        ...crudRoutes(assetResource, () => module().assets, { tags: ['catálogo'] }),
        ...crudRoutes(tagResource, () => module().tags, { tags: ['catálogo'] }),
        ...crudRoutes(categoryResource, () => module().categories, { tags: ['catálogo'] }),
        ...crudRoutes(collectionResource, () => module().collections, { tags: ['catálogo'] }),
        ...crudRoutes(facetResource, () => module().facets, { tags: ['catálogo'] }),
        ...crudRoutes(facetValueResource, () => module().facetValues, { tags: ['catálogo'] }),
        ...crudRoutes(optionResource, () => module().options, { permissionResource: 'productOption', tags: ['catálogo'] }),
        ...crudRoutes(variantResource, () => module().variants, { tags: ['catálogo'] }),
        ...crudRoutes(productResource, () => module().products, { tags: ['catálogo'] }),
        {
          method: 'POST',
          path: '/assets/upload',
          permission: 'asset:create',
          summary: 'Sube una imagen validando su firma binaria.',
          tags: ['catálogo'],
          status: 201,
          maxBodyBytes: 1_200_000,
          body: {
            data: { type: 'string', required: true, maxLength: 1_200_000 },
            name: rule.text(160),
            alt: rule.text(300),
            tags: rule.list({ type: 'string' }),
          },
          handler: ctx => module().assets.upload(ctx.body, ctx),
        },
        {
          method: 'GET',
          path: '/categories/tree',
          permission: 'category:read',
          summary: 'Árbol completo de categorías.',
          tags: ['catálogo'],
          bodyless: true,
          handler: () => ({ tree: module().categories.tree({ includeHidden: true }) }),
        },
        {
          method: 'GET',
          path: '/facets/grouped',
          permission: 'facet:read',
          summary: 'Facetas con sus valores.',
          tags: ['catálogo'],
          bodyless: true,
          handler: () => {
            const facets = module().facets.repository.all();
            return { data: module().facetValues.grouped(facets), count: facets.length };
          },
        },
        {
          method: 'GET',
          path: '/products/:id/full',
          permission: 'product:read',
          summary: 'Producto con variantes, opciones, activos, facetas y completitud.',
          tags: ['catálogo'],
          bodyless: true,
          handler: ctx => {
            const product = module().products.repository.retrieve(ctx.params.id);
            return {
              ...module().products.expand(product, ['variants', 'options', 'category', 'categories', 'collections', 'tags', 'facets', 'assets']),
              completeness: module().products.completeness(product),
              suggestedCategories: module().products.suggestCategory(product),
            };
          },
        },
        {
          method: 'POST',
          path: '/products/:id/duplicate',
          permission: 'product:create',
          summary: 'Duplica un producto con sus variantes y opciones.',
          tags: ['catálogo'],
          status: 201,
          handler: ctx => module().products.duplicate(ctx.params.id, ctx),
        },
        {
          method: 'POST',
          path: '/products/:id/variants/generate',
          permission: 'variant:create',
          summary: 'Genera la matriz de variantes desde las opciones del producto.',
          tags: ['catálogo'],
          body: { skuPrefix: rule.text(20) },
          handler: ctx => module().variants.generateMatrix(ctx.params.id, ctx.body, ctx),
        },
        {
          method: 'POST',
          path: '/products/bulk-status',
          permission: 'product:update',
          summary: 'Publica o despublica varios productos.',
          tags: ['catálogo'],
          body: {
            productIds: rule.list({ type: 'string' }, { required: true, maxItems: 500 }),
            status: rule.enumOf(PRODUCT_STATUSES, { required: true }),
          },
          handler: ctx => module().products.bulkStatus(ctx.body.productIds, ctx.body.status, ctx),
        },
        {
          method: 'POST',
          path: '/products/bulk-channels',
          permission: 'product:update',
          summary: 'Asigna canales a varios productos.',
          tags: ['catálogo'],
          body: {
            productIds: rule.list({ type: 'string' }, { required: true, maxItems: 500 }),
            channelIds: rule.list({ type: 'string' }, { required: true }),
          },
          handler: ctx => module().products.bulkChannels(ctx.body.productIds, ctx.body.channelIds, ctx),
        },
        {
          method: 'GET',
          path: '/catalog/quality',
          permission: 'product:read',
          summary: 'Informe de calidad del catálogo.',
          tags: ['catálogo'],
          bodyless: true,
          handler: () => module().products.qualityReport(),
        },
        {
          method: 'POST',
          path: '/catalog/reindex',
          permission: 'product:update',
          summary: 'Reindexa el catálogo publicado.',
          tags: ['catálogo'],
          handler: () => module().products.reindex(),
        },
        {
          method: 'GET',
          path: '/catalog/search-diagnostics',
          permission: 'product:read',
          summary: 'Estado del índice y términos sin resultados.',
          tags: ['catálogo'],
          bodyless: true,
          handler: () => ({
            index: container.resolve('search').describe(),
            emptyTerms: container.resolve('search').emptySearches(),
          }),
        },
      ];
    },

    store: container => {
      const module = () => container.resolve('catalog');
      const search = () => container.resolve('search');
      return [
        {
          method: 'GET',
          path: '/catalog/products',
          permission: null,
          summary: 'Catálogo publicado con filtros, orden y paginación.',
          tags: ['store'],
          bodyless: true,
          query: LIST_QUERY,
          handler: ctx => {
            const parsed = validate(ctx.query, LIST_QUERY, { partial: true });
            const filter = { ...buildFilter(parsed, productResource), status: 'published' };
            if (ctx.channelId) filter.channelIds = { $contains: ctx.channelId };
            const result = module().products.repository.list({
              filter,
              order: parseOrder(parsed.order, { featuredRank: 'desc', createdAt: 'desc' }),
              limit: parsed.limit ?? 24,
              offset: parsed.offset ?? 0,
            });
            return { ...result, data: result.data.map(product => module().products.expand(product, ['variants', 'category', 'assets'])) };
          },
        },
        {
          method: 'GET',
          path: '/catalog/products/:handle',
          permission: null,
          summary: 'Ficha publicada por `handle`, con redirección si el handle cambió.',
          tags: ['store'],
          bodyless: true,
          handler: ctx => {
            const product = module().products.byHandle(ctx.params.handle);
            if (!product || product.status !== 'published') throw new NotFoundError('producto', ctx.params.handle);
            const expanded = module().products.expand(product, ['variants', 'options', 'category', 'tags', 'facets', 'assets']);
            return {
              ...expanded,
              movedFrom: product.handle === ctx.params.handle ? null : ctx.params.handle,
              discountPercent: discountPercent(product.price?.previousAmount, product.price?.amount),
              related: (product.relatedProductIds || [])
                .map(id => module().products.repository.byId(id))
                .filter(item => item?.status === 'published')
                .map(item => ({ id: item.id, handle: item.handle, name: item.name, price: item.price })),
            };
          },
        },
        {
          method: 'GET',
          path: '/catalog/search',
          permission: null,
          summary: 'Búsqueda con facetas sobre el catálogo publicado.',
          tags: ['store'],
          bodyless: true,
          handler: ctx => {
            const filters = { status: 'published' };
            if (ctx.query.categoryId) filters.categoryId = ctx.query.categoryId;
            if (ctx.query.minPrice || ctx.query.maxPrice) {
              filters.price = { min: ctx.query.minPrice, max: ctx.query.maxPrice };
            }
            const facetFilters = {};
            for (const [key, value] of Object.entries(ctx.query.facet || {})) {
              facetFilters[key] = String(value).split(',');
            }
            return search().search({
              query: ctx.query.q || '',
              filters,
              facetFilters,
              sort: ctx.query.sort || 'relevance',
              limit: Math.min(48, Number(ctx.query.limit) || 24),
              offset: Number(ctx.query.offset) || 0,
            });
          },
        },
        {
          method: 'GET',
          path: '/catalog/suggest',
          permission: null,
          summary: 'Sugerencias de autocompletado.',
          tags: ['store'],
          bodyless: true,
          handler: ctx => ({ data: search().suggest(ctx.query.q || '', 8) }),
        },
        {
          method: 'GET',
          path: '/catalog/categories',
          permission: null,
          summary: 'Árbol de categorías visibles.',
          tags: ['store'],
          bodyless: true,
          handler: () => ({ tree: module().categories.tree() }),
        },
        {
          method: 'GET',
          path: '/catalog/collections',
          permission: null,
          summary: 'Colecciones visibles.',
          tags: ['store'],
          bodyless: true,
          handler: () => {
            const data = module().collections.repository.all({ visible: true }).sort((a, b) => a.rank - b.rank);
            return { data, count: data.length };
          },
        },
        {
          method: 'GET',
          path: '/catalog/collections/:handle',
          permission: null,
          summary: 'Productos de una colección.',
          tags: ['store'],
          bodyless: true,
          handler: ctx => {
            const collection = module().collections.repository.find({ handle: ctx.params.handle, visible: true });
            if (!collection) throw new NotFoundError('colección', ctx.params.handle);
            const products = module().collections.productsIn(collection.id, module().products.published());
            return { collection, data: products, count: products.length };
          },
        },
        {
          method: 'GET',
          path: '/catalog/facets',
          permission: null,
          summary: 'Facetas públicas con sus valores.',
          tags: ['store'],
          bodyless: true,
          handler: () => {
            const facets = module().facets.repository.all({ private: false, filterable: true }).sort((a, b) => a.rank - b.rank);
            return { data: module().facetValues.grouped(facets), count: facets.length };
          },
        },
      ];
    },
  },
};
