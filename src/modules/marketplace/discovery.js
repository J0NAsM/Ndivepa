/**
 * Descubrimiento, reputación y recomendaciones del marketplace.
 *
 * Reglas que este fichero respeta:
 *  - **No inventa métricas.** Una tienda sin reseñas no tiene «5 estrellas»: su
 *    valoración es `null` y la interfaz muestra «Sin reseñas todavía».
 *  - **No expone datos privados.** Las proyecciones públicas se construyen campo
 *    a campo; nunca se devuelve el registro completo de una tienda o un cliente.
 *  - **Lo patrocinado va aparte.** El ranking orgánico no conoce la publicidad;
 *    los anuncios los sirve el módulo `advertising` en su propia lista.
 *  - **Recomendaciones determinísticas.** Reglas explicables (misma categoría,
 *    misma tienda, comprados juntos, tendencia). Un proveedor de IA puede
 *    reordenarlas con `useRecommender`, pero no es necesario para funcionar.
 */
import { NotFoundError } from '../../framework/errors.js';
import { ageInDays } from '../../framework/dates.js';
import { discountPercent } from '../../framework/money.js';
import { normalizeForSearch } from '../../framework/strings.js';
import { tokenize } from '../../framework/search.js';
import { COMMERCIAL_MODELS, inferCommercialModel } from '../catalog/index.js';
import { DELIVERY_MODE_LABELS } from './models.js';

const IMAGE = /^\/uploads\/[A-Za-z0-9/_-]+\.(?:png|jpe?g|webp|avif|gif)$/i;
const STATS_TTL_MS = 3_000;

/** Nombre visible de un cliente: nombre e inicial del apellido, nunca el correo. */
export function displayName(customer) {
  if (!customer) return 'Cliente';
  const first = String(customer.firstName || '').trim();
  const last = String(customer.lastName || '').trim();
  if (!first) return 'Cliente';
  return last ? `${first} ${last[0].toUpperCase()}.` : first;
}

export class DiscoveryService {
  constructor({ store, settings, catalog, inventory, affiliate, channel, analytics, search, cache, deliveryEstimates = null }) {
    this.deliveryEstimates = deliveryEstimates;
    this.store = store;
    this.settings = settings;
    this.catalog = catalog;
    this.inventory = inventory;
    this.affiliate = affiliate;
    this.channel = channel;
    this.analytics = analytics;
    this.searchIndex = search;
    this.cache = cache;
    this.memo = null;
    this.recommenders = [];
  }

  /**
   * Lectura pública cacheada. Todo lo cacheado lleva la etiqueta `marketplace` y se
   * invalida con cada cambio de catálogo, tienda, reseña o pedido, así que nadie ve
   * un dato viejo por haber publicado un producto.
   */
  cached(key, ttlMs, build) {
    if (!this.cache) return build();
    const hit = this.cache.get(key);
    if (hit !== undefined && hit !== null) return hit;
    const value = build();
    this.cache.set(key, value, { ttlMs, tags: ['marketplace'] });
    return value;
  }

  invalidateCache() {
    this.cache?.invalidateTag('marketplace');
    this.memo = null;
  }

  /** Punto de integración para recomendaciones con IA: reordena, no sustituye. */
  useRecommender(recommender) {
    this.recommenders.push(recommender);
    return this;
  }

  // --- Estadísticas agregadas (memo corto) ------------------------------------

  stats() {
    if (this.memo && Date.now() - this.memo.at < STATS_TTL_MS) return this.memo.value;
    const unitsByProduct = new Map();
    const recentUnits = new Map();
    const deliveredBySeller = new Map();
    const cancelledBySeller = new Map();
    const coPurchase = new Map();
    for (const vendorOrder of this.store.collection('vendorOrders')) {
      if (vendorOrder.deletedAt) continue;
      if (vendorOrder.sellerId) {
        if (vendorOrder.status === 'delivered') deliveredBySeller.set(vendorOrder.sellerId, (deliveredBySeller.get(vendorOrder.sellerId) || 0) + 1);
        if (vendorOrder.status === 'cancelled' && vendorOrder.cancelledBy === 'seller') {
          cancelledBySeller.set(vendorOrder.sellerId, (cancelledBySeller.get(vendorOrder.sellerId) || 0) + 1);
        }
      }
      if (vendorOrder.status === 'cancelled') continue;
      const recent = (ageInDays(vendorOrder.createdAt) ?? 99) <= 7;
      for (const item of vendorOrder.items || []) {
        unitsByProduct.set(item.productId, (unitsByProduct.get(item.productId) || 0) + item.quantity);
        if (recent) recentUnits.set(item.productId, (recentUnits.get(item.productId) || 0) + item.quantity);
      }
    }
    for (const order of this.store.collection('orders')) {
      if (order.status === 'cancelled') continue;
      const ids = [...new Set((order.items || []).map(item => item.productId))];
      for (const id of ids) {
        const peers = coPurchase.get(id) || new Map();
        for (const other of ids) if (other !== id) peers.set(other, (peers.get(other) || 0) + 1);
        coPurchase.set(id, peers);
      }
    }
    const ratingByProduct = new Map();
    const ratingBySeller = new Map();
    for (const review of this.store.collection('reviews')) {
      if (review.deletedAt || review.status !== 'published') continue;
      const add = (map, key) => {
        if (!key) return;
        const current = map.get(key) || { sum: 0, count: 0, distribution: [0, 0, 0, 0, 0] };
        current.sum += review.rating;
        current.count += 1;
        current.distribution[review.rating - 1] += 1;
        map.set(key, current);
      };
      add(ratingByProduct, review.productId);
      add(ratingBySeller, review.sellerId);
    }
    const favoritesByProduct = new Map();
    const followersBySeller = new Map();
    for (const favorite of this.store.collection('favorites')) {
      if (favorite.deletedAt) continue;
      if (favorite.targetType === 'product') favoritesByProduct.set(favorite.targetId, (favoritesByProduct.get(favorite.targetId) || 0) + 1);
    }
    for (const follow of this.store.collection('follows')) {
      if (follow.deletedAt || follow.targetType !== 'seller') continue;
      followersBySeller.set(follow.targetId, (followersBySeller.get(follow.targetId) || 0) + 1);
    }
    const recentViews = new Map();
    for (const event of this.store.collection('events')) {
      if (event.type !== 'product_view' || !event.productId) continue;
      if ((ageInDays(event.timestamp) ?? 99) > 7) continue;
      recentViews.set(event.productId, (recentViews.get(event.productId) || 0) + 1);
    }
    const value = {
      unitsByProduct, recentUnits, deliveredBySeller, cancelledBySeller, coPurchase,
      ratingByProduct, ratingBySeller, favoritesByProduct, followersBySeller, recentViews,
    };
    this.memo = { at: Date.now(), value };
    return value;
  }

  invalidate() {
    this.memo = null;
    this.cache?.invalidateTag('marketplace');
  }

  static rating(aggregate) {
    if (!aggregate?.count) return { average: null, count: 0, distribution: [0, 0, 0, 0, 0] };
    return { average: Math.round((aggregate.sum / aggregate.count) * 10) / 10, count: aggregate.count, distribution: aggregate.distribution };
  }

  // --- Reputación --------------------------------------------------------------

  /**
   * Reputación de una tienda. Cada indicador es `null` cuando no hay datos
   * suficientes para calcularlo; ninguno se rellena con un valor supuesto.
   */
  sellerReputation(sellerId) {
    const stats = this.stats();
    const seller = this.channel.sellers.repository.byId(sellerId);
    const rating = DiscoveryService.rating(stats.ratingBySeller.get(sellerId));
    const delivered = stats.deliveredBySeller.get(sellerId) || 0;
    const cancelled = stats.cancelledBySeller.get(sellerId) || 0;
    const finished = delivered + cancelled;
    const productIds = new Set(this.catalog.products.repository.all({ sellerId }).map(product => product.id));
    const questions = this.store.collection('questions').filter(row => !row.deletedAt && productIds.has(row.productId));
    const answered = questions.filter(row => row.answer?.at);
    const hours = answered
      .map(row => (new Date(row.answer.at).getTime() - new Date(row.createdAt).getTime()) / 3_600_000)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const median = hours.length ? hours[Math.floor(hours.length / 2)] : null;
    const incidents = this.store.collection('reports').filter(report => !report.deletedAt && report.status === 'resolved'
      && report.action && report.action !== 'none'
      && ((report.targetType === 'seller' && report.targetId === sellerId) || (report.targetType === 'product' && productIds.has(report.targetId))))
      .length + cancelled;
    return {
      rating,
      salesCount: delivered,
      productsPublished: this.catalog.products.repository.all({ sellerId, status: 'published' }).length,
      fulfillmentRate: finished ? Math.round((delivered / finished) * 100) : null,
      responseTimeHours: median === null ? null : Math.round(median * 10) / 10,
      questionsAnswered: questions.length ? `${answered.length}/${questions.length}` : null,
      incidents,
      followers: stats.followersBySeller.get(sellerId) || 0,
      memberSince: seller?.approvedAt || seller?.createdAt || null,
    };
  }

  // --- Visibilidad y proyecciones ---------------------------------------------

  sellerActive(sellerId) {
    const seller = sellerId ? this.channel.sellers.repository.byId(sellerId) : null;
    return seller?.status === 'active';
  }

  /** ¿Se puede mostrar en la tienda pública? */
  isVisible(product) {
    if (!product || product.status !== 'published' || product.deletedAt) return false;
    const model = inferCommercialModel(product);
    if (model === 'LOCAL' && !this.sellerActive(product.sellerId)) return false;
    if (model === 'DROPSHIPPING') {
      const supplier = this.store.collection('suppliers').find(row => row.id === product.supplierId);
      if (supplier?.status !== 'active') return false;
    }
    return true;
  }

  visibleProducts() {
    return this.catalog.products.published().filter(product => this.isVisible(product));
  }

  imageOf(product) {
    const asset = product.primaryAssetId ? this.catalog.assets.repository.byId(product.primaryAssetId) : null;
    if (asset?.url && IMAGE.test(asset.url)) return asset.url;
    const firstAsset = (product.assetIds || []).map(id => this.catalog.assets.repository.byId(id)).find(row => row?.url && IMAGE.test(row.url));
    if (firstAsset) return firstAsset.url;
    if (typeof product.image === 'string' && IMAGE.test(product.image)) return product.image;
    return null;
  }

  gallery(product) {
    const assets = (product.assetIds || []).map(id => this.catalog.assets.repository.byId(id)).filter(row => row?.url && IMAGE.test(row.url));
    const urls = [...assets.map(asset => ({ url: asset.url, alt: asset.alt || product.name }))];
    for (const url of product.metadata?.imageUrls || []) if (IMAGE.test(url) && !urls.some(item => item.url === url)) urls.push({ url, alt: product.name });
    if (!urls.length && typeof product.image === 'string' && IMAGE.test(product.image)) urls.push({ url: product.image, alt: product.name });
    return urls;
  }

  /**
   * Disponibilidad resumida de un producto. `lastUnits` sale del stock real: es
   * la única escasez que mostramos, nunca un contador inventado.
   */
  stockState(product) {
    if (inferCommercialModel(product) === 'AFILIADO') return { hasStock: true, lastUnits: false };
    const variants = this.catalog.variants.forProduct(product.id).filter(variant => variant.active !== false);
    if (!variants.length) return { hasStock: false, lastUnits: false };
    let hasStock = false;
    let lastUnits = false;
    for (const variant of variants) {
      try {
        const availability = this.inventory.service.publicAvailability(variant.id);
        if (availability.hasStock) {
          hasStock = true;
          if (availability.lastUnits) lastUnits = true;
        }
      } catch { /* variante sin inventario */ }
    }
    return { hasStock, lastUnits: hasStock && lastUnits };
  }

  hasStock(product) {
    return this.stockState(product).hasStock;
  }

  localityName(localityId) {
    return localityId ? this.store.collection('localities').find(row => row.id === localityId)?.name || null : null;
  }

  sellerSummary(sellerId) {
    const seller = sellerId ? this.channel.sellers.repository.byId(sellerId) : null;
    if (!seller) return null;
    const rating = DiscoveryService.rating(this.stats().ratingBySeller.get(seller.id));
    return {
      id: seller.id, code: seller.code, name: seller.name, logoUrl: seller.logoUrl || null, type: seller.type || 'commerce',
      area: seller.location?.area || null, locality: this.localityName(seller.localityId), rating,
    };
  }

  /** Tarjeta de producto para listados. */
  card(product) {
    const stats = this.stats();
    const stock = this.stockState(product);
    const model = inferCommercialModel(product);
    const definition = COMMERCIAL_MODELS[model] || COMMERCIAL_MODELS.PROPIO;
    const amount = product.price?.amount ?? null;
    const previous = product.price?.previousAmount ?? null;
    const discount = previous && amount && previous > amount ? discountPercent(previous, amount) : null;
    return {
      id: product.id,
      handle: product.handle,
      name: product.name,
      subtitle: product.subtitle || null,
      image: this.imageOf(product),
      emoji: typeof product.image === 'string' && !product.image.startsWith('/') && product.image.length <= 4 ? product.image : null,
      price: { amount, compareAt: previous && previous > (amount || 0) ? previous : null, currency: product.price?.currency || this.settings.get('marketplace.currencyCode', 'PYG') },
      discountPercent: discount,
      commercialModel: model,
      commercialModelLabel: definition.label,
      cta: definition.cta,
      seller: model === 'LOCAL' ? this.sellerSummary(product.sellerId) : null,
      merchantName: model === 'AFILIADO' && product.merchantId ? this.affiliate.merchants.repository.byId(product.merchantId)?.name || null : null,
      locality: this.localityName(product.localityId),
      categoryId: product.categoryId || null,
      rating: DiscoveryService.rating(stats.ratingByProduct.get(product.id)),
      unitsSold: stats.unitsByProduct.get(product.id) || 0,
      favorites: stats.favoritesByProduct.get(product.id) || 0,
      deliveryModes: product.deliveryModes || [],
      inStock: stock.hasStock,
      lastUnits: stock.lastUnits,
      isNew: (ageInDays(product.publishedAt || product.createdAt) ?? 99) <= 14,
      featured: Boolean(product.featured),
    };
  }

  popularity(product) {
    const stats = this.stats();
    return (stats.unitsByProduct.get(product.id) || 0) * 5
      + (product.clickCount || 0) * 3
      + (stats.favoritesByProduct.get(product.id) || 0) * 2
      + (product.viewCount || 0);
  }

  trendScore(product) {
    const stats = this.stats();
    return (stats.recentUnits.get(product.id) || 0) * 6 + (stats.recentViews.get(product.id) || 0)
      + ((ageInDays(product.publishedAt) ?? 99) <= 7 ? 2 : 0);
  }

  /**
   * Entrega estimada a una localidad. Devuelve `available: false` cuando no hay
   * ninguna opción configurada: preferimos decir «no podemos estimarlo» antes
   * que mostrar un importe que después no se cobra.
   */
  deliveryEstimate(product, localityId = null) {
    if (!this.deliveryEstimates || inferCommercialModel(product) === 'AFILIADO') return null;
    const target = localityId
      || product.localityId
      || this.settings.get('marketplace.defaultLocalityId', null);
    try {
      return this.deliveryEstimates.forProduct(product, { localityId: target });
    } catch {
      return null;
    }
  }

  categoryPath(categoryId) {
    const path = [];
    let cursor = categoryId ? this.catalog.categories.repository.byId(categoryId) : null;
    for (let guard = 0; cursor && guard < 10; guard += 1) {
      path.unshift({ id: cursor.id, name: cursor.name, handle: cursor.handle });
      cursor = cursor.parentId ? this.catalog.categories.repository.byId(cursor.parentId) : null;
    }
    return path;
  }

  /** Ficha pública completa (cacheada unos segundos: es la página más pedida). */
  detail(handle, { locality = null } = {}) {
    return this.cached(`mp:detail:${handle}:${locality || 'default'}`, 20_000, () => this.buildDetail(handle, { locality }));
  }

  buildDetail(handle, { locality = null } = {}) {
    const product = this.catalog.products.byHandle(handle);
    if (!this.isVisible(product)) throw new NotFoundError('producto', handle);
    const card = this.card(product);
    const currency = card.price.currency;
    const variants = this.catalog.variants.forProduct(product.id).filter(variant => variant.active !== false).map(variant => {
      const price = this.store.collection('prices').find(row => row.variantId === variant.id && row.currencyCode === currency && !row.priceListId && row.active !== false && !row.deletedAt);
      let availability = { state: 'untracked', hasStock: true, lastUnits: false };
      try { availability = this.inventory.service.publicAvailability(variant.id); } catch { /* variante sin inventario */ }
      return {
        id: variant.id, title: variant.title, sku: variant.sku, optionValues: variant.optionValues || {},
        price: price?.amount ?? card.price.amount, compareAt: price?.compareAtAmount || null,
        availability: { state: availability.state, hasStock: availability.hasStock, lastUnits: Boolean(availability.lastUnits) },
        weight: variant.weight || null, weightUnit: variant.weightUnit || 'g',
        dimensions: variant.length || variant.width || variant.height
          ? { length: variant.length || null, width: variant.width || null, height: variant.height || null, unit: variant.dimensionUnit || 'cm' }
          : null,
      };
    });
    const model = card.commercialModel;
    let externalOffer = null;
    if (model === 'AFILIADO' || product.monetizationType === 'BOTH') {
      const link = this.affiliate.links.bestFor(product.id);
      const merchant = product.merchantId ? this.affiliate.merchants.repository.byId(product.merchantId) : null;
      externalOffer = link && link.status !== 'invalid'
        ? {
          linkId: link.id,
          path: `/go/${encodeURIComponent(link.id)}`,
          merchantName: merchant?.name || 'el comercio',
          disclosure: this.settings.get('affiliateDisclosure', ''),
          notice: `Serás redirigido a ${merchant?.name || 'un sitio externo'} para completar la compra. El precio, el envío y la garantía los gestiona ese comercio.`,
        }
        : null;
    }
    const seller = model === 'LOCAL' ? this.channel.sellers.repository.byId(product.sellerId) : null;
    const reviews = this.store.collection('reviews')
      .filter(row => row.productId === product.id && row.status === 'published' && !row.deletedAt)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const customers = this.store.collection('customers');
    const questions = this.store.collection('questions')
      .filter(row => row.productId === product.id && row.status === 'published' && !row.deletedAt)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 20);
    const tags = (product.tagIds || []).map(id => this.catalog.tags.repository.byId(id)?.value).filter(Boolean);
    const deliveryModes = (product.deliveryModes?.length ? product.deliveryModes : seller?.deliveryModes || []);
    return {
      ...card,
      description: product.description || '',
      brand: product.brand || null,
      tags,
      gallery: this.gallery(product),
      categoryPath: this.categoryPath(product.categoryId),
      variants,
      deliveryModes,
      deliveryLabels: deliveryModes.map(mode => DELIVERY_MODE_LABELS[mode] || mode),
      shippingInfo: product.shippingInfo || {},
      // Coste y plazo antes de agregar al carrito: es lo que el comprador
      // pregunta primero y lo que más carritos hace abandonar si aparece tarde.
      delivery: this.deliveryEstimate(product, locality),
      savings: card.price.compareAt ? card.price.compareAt - card.price.amount : null,
      // Lo que protege la compra, dicho en la ficha y no solo en la letra chica.
      guarantees: {
        returnWindowDays: this.settings.get('order.returnWindowDays', 30),
        reviewsRequirePurchase: this.settings.get('marketplace.reviewsRequirePurchase', true),
        storedCardData: false,
      },
      externalOffer,
      store: seller ? { ...this.channel.sellers.publicView(seller), reputation: this.sellerReputation(seller.id) } : null,
      reviews: reviews.slice(0, 10).map(review => ({
        id: review.id,
        rating: review.rating,
        title: review.title || null,
        comment: review.comment || null,
        photos: (review.photos || []).filter(url => IMAGE.test(url)),
        author: displayName(customers.find(row => row.id === review.customerId)),
        verifiedPurchase: Boolean(review.verifiedPurchase),
        sellerReply: review.sellerReply?.body ? review.sellerReply : null,
        helpfulCount: review.helpfulCount || 0,
        createdAt: review.createdAt,
      })),
      questions: questions.map(question => ({
        id: question.id,
        body: question.body,
        author: displayName(customers.find(row => row.id === question.customerId)),
        answer: question.answer?.body ? { body: question.answer.body, at: question.answer.at } : null,
        createdAt: question.createdAt,
      })),
      seo: {
        title: product.seo?.title || product.name,
        description: product.seo?.description || String(product.description || product.name).slice(0, 160),
        noindex: Boolean(product.seo?.noindex),
      },
      publishedAt: product.publishedAt,
    };
  }

  // --- Búsqueda ------------------------------------------------------------------

  categorySubtree(handleOrId) {
    if (!handleOrId) return null;
    const category = this.catalog.categories.repository.find({ handle: handleOrId }) || this.catalog.categories.repository.byId(handleOrId);
    if (!category) return [];
    return this.catalog.categories.subtreeIds(category.id);
  }

  /**
   * Búsqueda del marketplace sobre el índice compartido del catálogo. Los filtros
   * locales (zona, entrega, retiro, disponibilidad) se aplican aquí porque son
   * propiedades de la tienda y del stock, no del texto.
   */
  search(params = {}) {
    const {
      q = '', category = null, seller = null, locality = null, area = null, minPrice = null, maxPrice = null,
      delivery = null, model = null, inStock = false, onSale = false, minRating = null, sort = 'relevance', limit = 24, offset = 0,
    } = params;
    const filters = { status: 'published', sellerActive: true };
    const subtree = this.categorySubtree(category);
    if (subtree) filters.categoryIds = subtree.length ? subtree : ['__ninguna__'];
    if (seller) {
      const record = this.channel.sellers.byCode(seller) || this.channel.sellers.repository.byId(seller);
      filters.sellerId = record?.id || '__ninguna__';
    }
    if (locality) filters.localityId = locality;
    if (model) filters.commercialModel = String(model).split(',');
    if (delivery) filters.deliveryModes = String(delivery).split(',');
    if (minPrice || maxPrice) filters.price = { min: minPrice ?? undefined, max: maxPrice ?? undefined };
    if (inStock) filters.inStock = true;
    if (onSale) filters.onSale = true;
    if (area) filters.area = normalizeForSearch(area);
    // «4 estrellas o más»: la valoración ya está en el índice, con reseñas reales.
    if (minRating) filters.rating = { min: Number(minRating) };
    const effectiveSort = sort === 'relevance' && !String(q).trim() ? 'popularity' : sort;
    const result = this.searchIndex.search({
      query: q, filters, sort: effectiveSort, limit: Math.min(48, Number(limit) || 24), offset: Number(offset) || 0,
    });
    const products = result.data
      .map(entry => this.catalog.products.repository.byId(entry.id))
      .filter(product => this.isVisible(product));
    return {
      data: products.map(product => this.card(product)),
      count: result.count,
      limit: result.limit,
      offset: result.offset,
      facets: result.facets,
      corrected: result.corrected,
      query: q,
    };
  }

  /** Datos que el marketplace añade al documento de búsqueda de cada producto. */
  enrichSearchDocument(document, product) {
    const model = inferCommercialModel(product);
    const seller = model === 'LOCAL' ? this.channel.sellers.repository.byId(product.sellerId) : null;
    const stats = this.stats();
    const rating = DiscoveryService.rating(stats.ratingByProduct.get(product.id));
    const previous = product.price?.previousAmount;
    document.fields.seller = [seller?.name, seller?.location?.area].filter(Boolean).join(' ');
    document.fields.attributes = [
      ...(product.deliveryModes || []).map(mode => DELIVERY_MODE_LABELS[mode]),
      COMMERCIAL_MODELS[model]?.label,
      this.localityName(product.localityId),
    ].filter(Boolean).join(' ');
    Object.assign(document.filters, {
      sellerActive: model !== 'LOCAL' || seller?.status === 'active',
      inStock: this.hasStock(product),
      onSale: Boolean(previous && product.price?.amount && previous > product.price.amount),
      rating: rating.average ?? 0,
      reviewCount: rating.count,
      area: seller?.location?.area ? normalizeForSearch(seller.location.area) : null,
      popularity: this.popularity(product),
    });
  }

  suggest(q) {
    const term = String(q || '').trim();
    if (term.length < 2) return { products: [], stores: [], categories: [] };
    const products = this.search({ q: term, limit: 5 }).data.map(card => ({ handle: card.handle, name: card.name, image: card.image }));
    const needle = normalizeForSearch(term);
    const stores = this.channel.sellers.active()
      .filter(seller => normalizeForSearch(seller.name).includes(needle))
      .slice(0, 4)
      .map(seller => ({ code: seller.code, name: seller.name, logoUrl: seller.logoUrl || null }));
    const categories = this.catalog.categories.repository.all({ visible: true })
      .filter(category => normalizeForSearch(category.name).includes(needle))
      .slice(0, 4)
      .map(category => ({ handle: category.handle, name: category.name }));
    return { products, stores, categories };
  }

  // --- Categorías, tiendas y localidades ---------------------------------------

  categoryTree() {
    return this.cached('mp:categories', 120_000, () => this.buildCategoryTree());
  }

  buildCategoryTree() {
    const visible = this.visibleProducts();
    const count = category => {
      const ids = new Set(this.catalog.categories.subtreeIds(category.id));
      return visible.filter(product => [product.categoryId, ...(product.categoryIds || [])].some(id => ids.has(id))).length;
    };
    const decorate = nodes => nodes.map(node => ({
      id: node.id, name: node.name, handle: node.handle, description: node.description || null,
      productCount: count(node), children: decorate(node.children || []),
    }));
    return decorate(this.catalog.categories.tree());
  }

  storeCard(seller) {
    const reputation = this.sellerReputation(seller.id);
    return {
      ...this.channel.sellers.publicView(seller),
      locality: this.localityName(seller.localityId),
      rating: reputation.rating,
      salesCount: reputation.salesCount,
      productsPublished: reputation.productsPublished,
      followers: reputation.followers,
      isNew: (ageInDays(seller.approvedAt) ?? 99) <= 45,
    };
  }

  stores(params = {}) {
    return this.cached(`mp:stores:${JSON.stringify(params)}`, 60_000, () => this.buildStores(params));
  }

  buildStores({ locality = null, type = null, category = null, q = null, sort = 'relevance', limit = 48 } = {}) {
    const needle = q ? normalizeForSearch(q) : null;
    const rows = this.channel.sellers.active()
      .filter(seller => !locality || seller.localityId === locality)
      .filter(seller => !type || seller.type === type)
      .filter(seller => !category || (seller.categoryIds || []).includes(category))
      .filter(seller => !needle || normalizeForSearch(`${seller.name} ${seller.tagline || ''} ${seller.location?.area || ''}`).includes(needle))
      .map(seller => this.storeCard(seller));
    const sorters = {
      relevance: (a, b) => b.salesCount - a.salesCount || (b.rating.average || 0) - (a.rating.average || 0) || a.name.localeCompare(b.name),
      newest: (a, b) => String(b.approvedAt || '').localeCompare(String(a.approvedAt || '')),
      rating: (a, b) => (b.rating.average || 0) - (a.rating.average || 0) || b.rating.count - a.rating.count,
      name: (a, b) => a.name.localeCompare(b.name),
    };
    const data = rows.sort(sorters[sort] || sorters.relevance).slice(0, limit);
    return { data, count: rows.length };
  }

  storePage(code) {
    return this.cached(`mp:store:${code}`, 30_000, () => this.buildStorePage(code));
  }

  buildStorePage(code) {
    const seller = this.channel.sellers.byCode(code);
    if (!seller || seller.status !== 'active') throw new NotFoundError('tienda', code);
    const products = this.visibleProducts().filter(product => product.sellerId === seller.id);
    const promotions = this.store.collection('promotions')
      .filter(row => !row.deletedAt && row.status === 'active' && row.metadata?.sellerId === seller.id && row.showInCatalog)
      .map(row => ({ id: row.id, name: row.name, label: row.label || null, description: row.description || null, endsAt: row.endsAt || null, requiresCode: row.requiresCode }));
    const posts = this.store.collection('posts')
      .filter(row => !row.deletedAt && row.sellerId === seller.id && row.status === 'published')
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 10);
    const customers = this.store.collection('customers');
    const reviews = this.store.collection('reviews')
      .filter(row => !row.deletedAt && row.sellerId === seller.id && row.status === 'published')
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 10)
      .map(review => ({
        id: review.id, rating: review.rating, comment: review.comment || null, author: displayName(customers.find(row => row.id === review.customerId)),
        productName: this.catalog.products.repository.byId(review.productId)?.name || null, verifiedPurchase: Boolean(review.verifiedPurchase),
        sellerReply: review.sellerReply?.body ? review.sellerReply : null, createdAt: review.createdAt,
      }));
    const categories = (seller.categoryIds || []).map(id => this.catalog.categories.repository.byId(id)).filter(Boolean)
      .map(category => ({ id: category.id, name: category.name, handle: category.handle }));
    return {
      store: { ...this.channel.sellers.publicView(seller), locality: this.localityName(seller.localityId), categories },
      reputation: this.sellerReputation(seller.id),
      products: products.map(product => this.card(product)).sort((a, b) => Number(b.featured) - Number(a.featured) || b.unitsSold - a.unitsSold),
      promotions,
      posts: posts.map(post => ({ id: post.id, type: post.type, body: post.body, imageUrl: IMAGE.test(post.imageUrl || '') ? post.imageUrl : null, likeCount: post.likeCount || 0, createdAt: post.createdAt })),
      reviews,
    };
  }

  localities() {
    return this.cached('mp:localities', 300_000, () => this.buildLocalities());
  }

  buildLocalities() {
    const rows = this.store.collection('localities').filter(row => !row.deletedAt && row.launchStatus !== 'hidden');
    const sellersByLocality = new Map();
    for (const seller of this.channel.sellers.active()) {
      if (seller.localityId) sellersByLocality.set(seller.localityId, (sellersByLocality.get(seller.localityId) || 0) + 1);
    }
    const build = parentId => rows
      .filter(row => (row.parentId || null) === parentId)
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
      .map(row => ({
        id: row.id, code: row.code, name: row.name, type: row.type, launchStatus: row.launchStatus, areas: row.areas || [],
        center: row.center || null, sellers: sellersByLocality.get(row.id) || 0, children: build(row.id),
      }));
    return build(null);
  }

  /**
   * Mapa de una localidad. La coordenada solo aparece si la tienda eligió hacerla
   * pública; el resto se agrupa por zona general, sin ubicación precisa.
   */
  explore(localityId) {
    const locality = localityId
      ? this.store.collection('localities').find(row => row.id === localityId || row.code === localityId)
      : this.store.collection('localities').find(row => row.id === this.settings.get('marketplace.defaultLocalityId', null));
    if (!locality) throw new NotFoundError('localidad', localityId || '(predeterminada)');
    const sellers = this.channel.sellers.active().filter(seller => seller.localityId === locality.id);
    const points = [];
    const byArea = new Map();
    for (const seller of sellers) {
      const card = this.storeCard(seller);
      if (card.publicLocation) points.push({ ...card, lat: card.publicLocation.lat, lng: card.publicLocation.lng });
      const area = seller.location?.area || 'Sin zona indicada';
      byArea.set(area, [...(byArea.get(area) || []), card]);
    }
    return {
      locality: { id: locality.id, code: locality.code, name: locality.name, center: locality.center || null, bounds: locality.bounds || null, areas: locality.areas || [] },
      points,
      areas: [...byArea.entries()].map(([name, stores]) => ({ name, stores })).sort((a, b) => b.stores.length - a.stores.length),
      total: sellers.length,
    };
  }

  // --- Portada ---------------------------------------------------------------------

  home({ locality = null } = {}) {
    return this.cached(`mp:home:${locality || 'default'}`, 60_000, () => this.buildHome({ locality }));
  }

  buildHome({ locality = null } = {}) {
    const localityId = locality || this.settings.get('marketplace.defaultLocalityId', null);
    const visible = this.visibleProducts();
    // Ordenar y filtrar con los datos del producto; la tarjeta (que consulta stock,
    // tienda y reseñas) se arma solo para lo que realmente se muestra.
    const local = product => !localityId || product.localityId === localityId || !product.localityId;
    const discount = product => {
      const previous = product.price?.previousAmount;
      const amount = product.price?.amount;
      return previous && amount && previous > amount ? previous - amount : 0;
    };
    const toCards = list => list.slice(0, 12).map(product => this.card(product));
    const artisanIds = new Set(this.categorySubtree('artesania') || []);
    const sellerTypes = new Map(this.channel.sellers.active().map(seller => [seller.id, seller.type]));
    const offers = visible.filter(product => discount(product) > 0 && local(product))
      .sort((a, b) => discount(b) / (b.price?.previousAmount || 1) - discount(a) / (a.price?.previousAmount || 1));
    const popular = visible.filter(local).sort((a, b) => this.popularity(b) - this.popularity(a));
    const trending = [...visible].sort((a, b) => this.trendScore(b) - this.trendScore(a) || String(b.publishedAt).localeCompare(String(a.publishedAt)));
    const artisans = visible.filter(product => local(product) && (sellerTypes.get(product.sellerId) === 'artisan'
      || [product.categoryId, ...(product.categoryIds || [])].some(id => artisanIds.has(id))));
    const storeRows = this.stores({ locality: localityId }).data;
    return {
      marketplace: {
        name: this.settings.get('marketplace.name', 'Ndivepa'),
        tagline: this.settings.get('marketplace.tagline', ''),
        locality: localityId ? this.store.collection('localities').find(row => row.id === localityId)?.name || null : null,
      },
      categories: this.categoryTree().filter(node => node.productCount > 0 || node.children.some(child => child.productCount > 0)),
      offers: toCards(offers),
      popular: toCards(popular),
      stores: storeRows.slice(0, 12),
      newStores: [...storeRows].filter(store => store.isNew).sort((a, b) => String(b.approvedAt).localeCompare(String(a.approvedAt))).slice(0, 8),
      artisans: toCards(artisans),
      recommended: toCards(trending),
      counts: { products: visible.length, stores: storeRows.length, ...this.socialProof() },
    };
  }

  /**
   * Prueba social de la portada, solo con hechos: pedidos realmente entregados y
   * la media de las reseñas publicadas. Si todavía no hay, se devuelve `null` y
   * la portada no dice nada, en vez de inventar una cifra.
   */
  socialProof() {
    const stats = this.stats();
    let delivered = 0;
    for (const vendorOrder of this.store.collection('vendorOrders')) {
      if (!vendorOrder.deletedAt && vendorOrder.status === 'delivered') delivered += 1;
    }
    let sum = 0;
    let count = 0;
    for (const entry of stats.ratingByProduct.values()) {
      sum += entry.sum;
      count += entry.count;
    }
    return {
      deliveredOrders: delivered,
      rating: count ? { average: Math.round((sum / count) * 10) / 10, count } : null,
    };
  }

  offers({ limit = 48 } = {}) {
    return this.cached(`mp:offers:${limit}`, 60_000, () => {
      // Se filtra por precio antes de armar tarjetas: son la parte cara.
      const rebajados = this.visibleProducts()
        .filter(product => product.price?.previousAmount && product.price?.amount && product.price.previousAmount > product.price.amount);
      const data = rebajados.map(product => this.card(product))
        .sort((a, b) => b.discountPercent - a.discountPercent).slice(0, limit);
      return { data, count: data.length };
    });
  }

  // --- Recomendaciones -----------------------------------------------------------

  applyRecommenders(kind, product, list) {
    let output = list;
    for (const recommender of this.recommenders) {
      try {
        output = recommender({ kind, product, candidates: output }) || output;
      } catch {
        // Un proveedor externo fallido no rompe la ficha: se mantiene la regla determinística.
      }
    }
    return output;
  }

  recommendations(handle, { limit = 8 } = {}) {
    const product = this.catalog.products.byHandle(handle);
    if (!this.isVisible(product)) throw new NotFoundError('producto', handle);
    const visible = this.visibleProducts().filter(item => item.id !== product.id);
    const lineage = new Set(this.categoryPath(product.categoryId).map(node => node.id));
    const tokens = new Set(tokenize(`${product.name} ${product.subtitle || ''}`));
    const tags = new Set(product.tagIds || []);
    const similarity = item => {
      let score = 0;
      if (item.categoryId === product.categoryId) score += 5;
      else if ([item.categoryId, ...(item.categoryIds || [])].some(id => lineage.has(id))) score += 2;
      for (const tag of item.tagIds || []) if (tags.has(tag)) score += 2;
      for (const token of tokenize(`${item.name} ${item.subtitle || ''}`)) if (tokens.has(token)) score += 1;
      return score;
    };
    const similar = visible.map(item => ({ item, score: similarity(item) })).filter(entry => entry.score >= 3)
      .sort((a, b) => b.score - a.score || this.popularity(b.item) - this.popularity(a.item)).map(entry => entry.item);
    const sameStore = product.sellerId ? visible.filter(item => item.sellerId === product.sellerId)
      .sort((a, b) => this.popularity(b) - this.popularity(a)) : [];
    const peers = this.stats().coPurchase.get(product.id) || new Map();
    const explicit = (product.relatedProductIds || []).map(id => visible.find(item => item.id === id)).filter(Boolean);
    const bought = visible.filter(item => peers.has(item.id)).sort((a, b) => peers.get(b.id) - peers.get(a.id));
    const related = [...new Map([...explicit, ...bought].map(item => [item.id, item])).values()];
    const toCards = (kind, list) => this.applyRecommenders(kind, product, list).slice(0, limit).map(item => this.card(item));
    return {
      similar: toCards('similar', similar),
      sameStore: toCards('sameStore', sameStore),
      related: toCards('related', related),
      popular: toCards('popular', [...visible].sort((a, b) => this.popularity(b) - this.popularity(a))),
    };
  }

  /** Tarjetas para una lista de ids (vistos recientemente, favoritos de invitado). */
  cardsFor(ids = []) {
    const unique = [...new Set(ids)].slice(0, 48);
    return unique.map(id => this.catalog.products.repository.byId(id)).filter(product => this.isVisible(product)).map(product => this.card(product));
  }

  /** Comparador: atributos alineados de hasta cuatro productos. */
  compare(ids = []) {
    const products = [...new Set(ids)].slice(0, 4).map(id => this.catalog.products.repository.byId(id)).filter(product => this.isVisible(product));
    return {
      data: products.map(product => {
        const card = this.card(product);
        const variant = this.catalog.variants.forProduct(product.id)[0];
        return {
          ...card,
          brand: product.brand || null,
          category: this.categoryPath(product.categoryId).map(node => node.name).join(' › ') || null,
          weight: variant?.weight ? `${variant.weight} ${variant.weightUnit || 'g'}` : null,
          dimensions: variant?.length ? `${variant.length}×${variant.width || '?'}×${variant.height || '?'} ${variant.dimensionUnit || 'cm'}` : null,
          deliveryLabels: (product.deliveryModes || []).map(mode => DELIVERY_MODE_LABELS[mode] || mode),
        };
      }),
    };
  }
}
