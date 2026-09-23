/**
 * Comunidad del marketplace (v4).
 *
 * El objetivo no es «producto → comprar» sino descubrimiento y confianza:
 * favoritos, me gusta, seguidores, reseñas verificadas, preguntas públicas con
 * respuesta de la tienda, publicaciones, un feed de actividad, reportes y un
 * canal privado comprador ↔ tienda.
 *
 * Controles:
 *  - una reseña solo se publica como compra verificada si existe un subpedido
 *    entregado con ese producto; si la instalación lo exige, sin compra no hay
 *    reseña;
 *  - los límites de ritmo se cuentan sobre los registros persistidos (no se
 *    pierden al reiniciar) y el chat retiene para moderación los mensajes con
 *    muchos enlaces;
 *  - toda acción de moderación deja auditoría y puede ocultar, no borrar.
 */
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule } from '../../framework/validate.js';
import { ConflictError, NotFoundError, RateLimitError, UnauthorizedError, ValidationError } from '../../framework/errors.js';
import { ageInDays, now } from '../../framework/dates.js';
import { displayName } from '../marketplace/discovery.js';

const IMAGE = /^\/uploads\/[A-Za-z0-9/_-]+\.(?:png|jpe?g|webp)$/i;
const LINK = /(https?:\/\/|www\.)/gi;

export const favoriteResource = defineResource({
  name: 'favorite', collection: 'favorites', prefix: 'fav', route: 'favorites', softDelete: false, searchable: ['targetId'],
  fields: {
    customerId: rule.id({ required: true }),
    targetType: rule.enumOf(['product', 'seller'], { required: true }),
    targetId: rule.id({ required: true }),
  },
});

export const likeResource = defineResource({
  name: 'like', collection: 'likes', prefix: 'like', route: 'likes', softDelete: false, searchable: ['targetId'],
  fields: {
    customerId: rule.id({ required: true }),
    targetType: rule.enumOf(['product', 'post', 'review'], { required: true }),
    targetId: rule.id({ required: true }),
  },
});

export const followResource = defineResource({
  name: 'follow', collection: 'follows', prefix: 'fol', route: 'follows', softDelete: false, searchable: ['targetId'],
  fields: {
    followerId: rule.id({ required: true }),
    targetType: rule.enumOf(['seller', 'customer'], { required: true }),
    targetId: rule.id({ required: true }),
  },
});

export const reviewResource = defineResource({
  name: 'review', collection: 'reviews', prefix: 'rev', route: 'reviews', searchable: ['comment', 'title'],
  fields: {
    productId: rule.id({ required: true }),
    sellerId: rule.id(),
    customerId: rule.id({ required: true }),
    orderId: rule.id(),
    vendorOrderId: rule.id(),
    rating: { type: 'integer', coerce: true, required: true, min: 1, max: 5 },
    title: rule.text(120),
    comment: rule.text(2000),
    photos: rule.list({ type: 'string', maxLength: 500 }, { default: [], maxItems: 4 }),
    verifiedPurchase: rule.flag({ default: false }),
    status: rule.enumOf(['published', 'pending', 'hidden', 'rejected'], { default: 'published' }),
    sellerReply: { type: 'object', shape: { body: rule.text(1000), at: rule.date() } },
    helpfulCount: rule.quantity({ default: 0 }),
    moderationNote: rule.text(300),
    metadata: rule.metadata(),
  },
});

export const questionResource = defineResource({
  name: 'question', collection: 'questions', prefix: 'qst', route: 'questions', searchable: ['body'],
  fields: {
    productId: rule.id({ required: true }),
    sellerId: rule.id(),
    customerId: rule.id({ required: true }),
    body: rule.text(600, { required: true }),
    status: rule.enumOf(['published', 'hidden'], { default: 'published' }),
    answer: { type: 'object', shape: { body: rule.text(1000), at: rule.date(), byCustomerId: rule.id() } },
    metadata: rule.metadata(),
  },
});

export const postResource = defineResource({
  name: 'post', collection: 'posts', prefix: 'post', route: 'posts', searchable: ['body'],
  fields: {
    sellerId: rule.id({ required: true }),
    authorCustomerId: rule.id(),
    type: rule.enumOf(['update', 'offer', 'new_product', 'event'], { default: 'update' }),
    body: rule.text(1500, { required: true }),
    imageUrl: rule.text(500),
    productIds: rule.list({ type: 'string' }, { default: [], maxItems: 6 }),
    status: rule.enumOf(['published', 'hidden'], { default: 'published' }),
    likeCount: rule.quantity({ default: 0 }),
    metadata: rule.metadata(),
  },
});

export const feedItemResource = defineResource({
  name: 'feedItem', collection: 'feedItems', prefix: 'feed', route: 'feed-items', softDelete: false, searchable: ['type'],
  fields: {
    type: rule.enumOf(['new_product', 'offer', 'featured', 'new_store', 'seller_post'], { required: true }),
    sellerId: rule.id(),
    productId: rule.id(),
    postId: rule.id(),
    promotionId: rule.id(),
    localityId: rule.id(),
    visible: rule.flag({ default: true }),
    metadata: rule.metadata(),
  },
});

export const REPORT_TARGETS = ['product', 'seller', 'review', 'post', 'user', 'message', 'question'];

export const reportResource = defineResource({
  name: 'report', collection: 'reports', prefix: 'rep', route: 'reports', searchable: ['details'],
  fields: {
    reporterCustomerId: rule.id({ required: true }),
    targetType: rule.enumOf(REPORT_TARGETS, { required: true }),
    targetId: rule.id({ required: true }),
    reason: rule.enumOf(['spam', 'fraud', 'inappropriate', 'counterfeit', 'prohibited', 'wrong_info', 'other'], { required: true }),
    details: rule.text(1000),
    status: rule.enumOf(['open', 'reviewing', 'resolved', 'dismissed'], { default: 'open' }),
    action: rule.enumOf(['none', 'hidden', 'unpublished', 'suspended', 'blocked', 'warned']),
    resolution: rule.text(600),
    resolvedBy: rule.id(),
    resolvedAt: rule.date(),
    metadata: rule.metadata(),
  },
});

export const conversationResource = defineResource({
  name: 'conversation', collection: 'conversations', prefix: 'conv', route: 'conversations', searchable: ['subject'],
  fields: {
    customerId: rule.id({ required: true }),
    sellerId: rule.id({ required: true }),
    productId: rule.id(),
    vendorOrderId: rule.id(),
    subject: rule.text(160),
    status: rule.enumOf(['open', 'closed', 'blocked'], { default: 'open' }),
    lastMessageAt: rule.date(),
    lastMessagePreview: rule.text(160),
    unreadForCustomer: rule.quantity({ default: 0 }),
    unreadForSeller: rule.quantity({ default: 0 }),
    metadata: rule.metadata(),
  },
});

export const messageResource = defineResource({
  name: 'message', collection: 'messages', prefix: 'msg', route: 'messages', searchable: ['body'],
  fields: {
    conversationId: rule.id({ required: true }),
    senderType: rule.enumOf(['customer', 'seller', 'system'], { required: true }),
    senderId: rule.id({ required: true }),
    body: rule.text(2000, { required: true }),
    status: rule.enumOf(['sent', 'flagged', 'hidden'], { default: 'sent' }),
    flags: rule.list({ type: 'string' }, { default: [] }),
    metadata: rule.metadata(),
  },
});

export class CommunityService {
  constructor(deps) {
    this.store = deps.store;
    this.events = deps.events;
    this.settings = deps.settings;
    this.catalog = deps.catalog;
    this.channel = deps.channel;
    this.customer = deps.customer;
    this.marketplace = deps.marketplace;
    this.alerts = deps.alert;
    this.favorites = new BaseService(deps, favoriteResource);
    this.likes = new BaseService(deps, likeResource);
    this.follows = new BaseService(deps, followResource);
    this.reviews = new BaseService(deps, reviewResource);
    this.questions = new BaseService(deps, questionResource);
    this.posts = new BaseService(deps, postResource);
    this.feed = new BaseService(deps, feedItemResource);
    this.reports = new BaseService(deps, reportResource);
    this.conversations = new BaseService(deps, conversationResource);
    this.messages = new BaseService(deps, messageResource);
  }

  get accounts() { return this.marketplace.accounts; }
  get discovery() { return this.marketplace.discovery; }
  get inbox() { return this.marketplace.inbox; }

  requireCustomer(ctx) {
    const customer = this.customer.customers.customerFromRequest(ctx);
    if (!customer) throw new UnauthorizedError('Inicia sesión para participar en la comunidad.');
    return customer;
  }

  context(ctx, customer) {
    return { actor: { id: customer.id, type: 'customer', permissions: new Set() }, ip: ctx?.ip || null, requestId: ctx?.requestId || null };
  }

  /** Límite de ritmo sobre datos persistidos: sobrevive a reinicios y a varios procesos. */
  assertRate(rows, { windowMs, max, message }) {
    const recent = rows.filter(row => Date.now() - new Date(row.createdAt).getTime() < windowMs);
    if (recent.length >= max) throw new RateLimitError(Math.ceil(windowMs / 1000), max, message);
  }

  visibleProduct(productId) {
    const product = this.catalog.products.repository.byId(productId);
    if (!this.discovery.isVisible(product)) throw new NotFoundError('producto', productId);
    return product;
  }

  activeSeller(sellerId) {
    const seller = this.channel.sellers.repository.byId(sellerId);
    if (!seller || seller.status !== 'active') throw new NotFoundError('tienda', sellerId);
    return seller;
  }

  // --- Favoritos, me gusta y seguidores ----------------------------------------

  async toggleFavorite(ctx, { targetType, targetId }) {
    const customer = this.requireCustomer(ctx);
    if (targetType === 'product') this.visibleProduct(targetId);
    else this.activeSeller(targetId);
    const existing = this.favorites.repository.find({ customerId: customer.id, targetType, targetId });
    if (existing) {
      await this.favorites.delete(existing.id, this.context(ctx, customer));
      return { favorited: false };
    }
    this.assertRate(this.favorites.repository.all({ customerId: customer.id }), { windowMs: 60_000, max: 60, message: 'Demasiados favoritos seguidos.' });
    await this.favorites.create({ customerId: customer.id, targetType, targetId }, this.context(ctx, customer));
    return { favorited: true };
  }

  favoritesOf(ctx) {
    const customer = this.requireCustomer(ctx);
    const rows = this.favorites.repository.all({ customerId: customer.id }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return {
      products: this.discovery.cardsFor(rows.filter(row => row.targetType === 'product').map(row => row.targetId)),
      stores: rows.filter(row => row.targetType === 'seller')
        .map(row => this.channel.sellers.repository.byId(row.targetId)).filter(seller => seller?.status === 'active')
        .map(seller => this.discovery.storeCard(seller)),
      ids: rows.map(row => `${row.targetType}:${row.targetId}`),
    };
  }

  async toggleLike(ctx, { targetType, targetId }) {
    const customer = this.requireCustomer(ctx);
    const target = targetType === 'post' ? this.posts.repository.byId(targetId)
      : targetType === 'review' ? this.reviews.repository.byId(targetId)
        : this.visibleProduct(targetId);
    if (!target || (target.status && target.status !== 'published')) throw new NotFoundError(targetType, targetId);
    const existing = this.likes.repository.find({ customerId: customer.id, targetType, targetId });
    const delta = existing ? -1 : 1;
    if (existing) await this.likes.delete(existing.id, this.context(ctx, customer));
    else await this.likes.create({ customerId: customer.id, targetType, targetId }, this.context(ctx, customer));
    if (targetType !== 'product') {
      const service = targetType === 'post' ? this.posts : this.reviews;
      const field = targetType === 'post' ? 'likeCount' : 'helpfulCount';
      await this.store.transaction(state => {
        const row = service.repository.raw(state).find(item => item.id === targetId);
        if (row) row[field] = Math.max(0, (row[field] || 0) + delta);
      });
    }
    return { liked: !existing };
  }

  async toggleFollow(ctx, { targetType, targetId }) {
    const customer = this.requireCustomer(ctx);
    if (targetType === 'seller') this.activeSeller(targetId);
    else if (!this.customer.customers.repository.byId(targetId) || targetId === customer.id) throw new NotFoundError('perfil', targetId);
    const existing = this.follows.repository.find({ followerId: customer.id, targetType, targetId });
    if (existing) {
      await this.follows.delete(existing.id, this.context(ctx, customer));
      return { following: false };
    }
    await this.follows.create({ followerId: customer.id, targetType, targetId }, this.context(ctx, customer));
    return { following: true };
  }

  following(ctx) {
    const customer = this.requireCustomer(ctx);
    const rows = this.follows.repository.all({ followerId: customer.id });
    return {
      stores: rows.filter(row => row.targetType === 'seller').map(row => this.channel.sellers.repository.byId(row.targetId))
        .filter(seller => seller?.status === 'active').map(seller => this.discovery.storeCard(seller)),
      people: rows.filter(row => row.targetType === 'customer').map(row => this.profile(row.targetId, { summary: true })).filter(Boolean),
      ids: rows.map(row => `${row.targetType}:${row.targetId}`),
    };
  }

  /** Perfil público de un comprador: nombre visible y actividad pública. Nada más. */
  profile(customerId, { summary = false } = {}) {
    const customer = this.customer.customers.repository.byId(customerId);
    if (!customer || customer.status !== 'active' || !customer.hasAccount) {
      if (summary) return null;
      throw new NotFoundError('perfil', customerId);
    }
    const reviews = this.reviews.repository.all({ customerId, status: 'published' });
    const base = {
      id: customer.id,
      name: displayName(customer),
      memberSince: customer.createdAt,
      reviews: reviews.length,
      followers: this.follows.repository.all({ targetType: 'customer', targetId: customerId }).length,
      following: this.follows.repository.all({ followerId: customerId }).length,
    };
    if (summary) return base;
    return {
      ...base,
      recentReviews: reviews.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 10).map(review => {
        const product = this.catalog.products.repository.byId(review.productId);
        return { id: review.id, rating: review.rating, comment: review.comment, product: product ? { handle: product.handle, name: product.name } : null, createdAt: review.createdAt };
      }),
    };
  }

  // --- Reseñas ------------------------------------------------------------------

  /** Subpedido entregado del cliente que contiene el producto, si existe. */
  purchaseEvidence(customerId, productId) {
    return this.store.collection('vendorOrders')
      .filter(row => row.customerId === customerId && row.status === 'delivered' && !row.deletedAt)
      .find(row => (row.items || []).some(item => item.productId === productId)) || null;
  }

  async review(ctx, { productId, rating, title = null, comment = null, photos = [] }) {
    const customer = this.requireCustomer(ctx);
    const product = this.catalog.products.repository.byId(productId);
    if (!product || product.deletedAt) throw new NotFoundError('producto', productId);
    if (product.commercialModel === 'AFILIADO') {
      throw new ConflictError('Los productos afiliados se compran en el comercio externo: no podemos verificar la compra.');
    }
    for (const url of photos) if (!IMAGE.test(url)) throw ValidationError.single('photos', 'Solo se admiten fotos subidas a la plataforma.');
    const evidence = this.purchaseEvidence(customer.id, productId);
    if (!evidence && this.settings.get('marketplace.reviewsRequirePurchase', true)) {
      throw new ConflictError('Solo puedes valorar productos que compraste y recibiste.');
    }
    const status = this.settings.get('marketplace.reviewsRequireModeration', false) ? 'pending' : 'published';
    const actorCtx = this.context(ctx, customer);
    const existing = this.reviews.repository.find({ customerId: customer.id, productId });
    const payload = {
      rating, title, comment, photos, status,
      verifiedPurchase: Boolean(evidence),
      orderId: evidence?.orderId || null,
      vendorOrderId: evidence?.id || null,
    };
    const record = existing
      ? await this.reviews.update(existing.id, payload, actorCtx)
      : await this.reviews.create({ ...payload, productId, sellerId: product.sellerId || null, customerId: customer.id }, actorCtx);
    if (!existing && product.sellerId) {
      const seller = this.channel.sellers.repository.byId(product.sellerId);
      if (seller) {
        await this.accounts.notifyOwners(seller, {
          type: 'new_review', title: `Nueva reseña de ${rating}★ en ${product.name}`, body: comment ? comment.slice(0, 140) : null,
          link: `/mi-tienda/${seller.id}/resenas`, data: { reviewId: record.id },
        });
      }
    }
    return this.reviewView(record);
  }

  reviewView(review) {
    const customer = this.customer.customers.repository.byId(review.customerId);
    return {
      id: review.id, productId: review.productId, rating: review.rating, title: review.title, comment: review.comment,
      photos: review.photos || [], verifiedPurchase: review.verifiedPurchase, status: review.status,
      sellerReply: review.sellerReply?.body ? review.sellerReply : null, helpfulCount: review.helpfulCount || 0,
      author: displayName(customer), authorId: customer?.id || null, createdAt: review.createdAt,
    };
  }

  productReviews(productId, { limit = 20, offset = 0 } = {}) {
    const rows = this.reviews.repository.all({ productId, status: 'published' }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { data: rows.slice(offset, offset + limit).map(review => this.reviewView(review)), count: rows.length };
  }

  /** Productos entregados que el comprador todavía no valoró. */
  reviewable(ctx) {
    const customer = this.requireCustomer(ctx);
    const reviewed = new Set(this.reviews.repository.all({ customerId: customer.id }).map(row => row.productId));
    const seen = new Set();
    const data = [];
    for (const vendorOrder of this.store.collection('vendorOrders').filter(row => row.customerId === customer.id && row.status === 'delivered')) {
      for (const item of vendorOrder.items || []) {
        if (reviewed.has(item.productId) || seen.has(item.productId)) continue;
        seen.add(item.productId);
        const product = this.catalog.products.repository.byId(item.productId);
        if (product) data.push({ productId: product.id, handle: product.handle, name: product.name, image: this.discovery.imageOf(product), vendorOrderCode: vendorOrder.code, deliveredAt: vendorOrder.deliveredAt });
      }
    }
    return { data, count: data.length };
  }

  async replyReview(ctx, sellerId, reviewId, body) {
    const { actorCtx } = this.accounts.requireMember(ctx, sellerId);
    const review = this.reviews.repository.byId(reviewId);
    if (!review || review.sellerId !== sellerId) throw new NotFoundError('reseña', reviewId);
    const updated = await this.reviews.update(reviewId, { sellerReply: { body, at: now() } }, actorCtx);
    const product = this.catalog.products.repository.byId(review.productId);
    await this.inbox.notify({
      recipientId: review.customerId, type: 'review_reply', title: `La tienda respondió tu reseña de ${product?.name || 'un producto'}`,
      body: body.slice(0, 140), link: product ? `/producto/${product.handle}` : null,
    });
    return this.reviewView(updated);
  }

  // --- Preguntas ------------------------------------------------------------------

  async ask(ctx, { productId, body }) {
    const customer = this.requireCustomer(ctx);
    const product = this.visibleProduct(productId);
    if (String(body).trim().length < 5) throw ValidationError.single('body', 'Escribe una pregunta de al menos 5 caracteres.');
    this.assertRate(this.questions.repository.all({ customerId: customer.id }), { windowMs: 3_600_000, max: 10, message: 'Demasiadas preguntas en poco tiempo.' });
    const question = await this.questions.create({ productId, sellerId: product.sellerId || null, customerId: customer.id, body: String(body).trim(), status: 'published' }, this.context(ctx, customer));
    if (product.sellerId) {
      const seller = this.channel.sellers.repository.byId(product.sellerId);
      if (seller) {
        await this.accounts.notifyOwners(seller, {
          type: 'new_question', title: `Nueva pregunta sobre ${product.name}`, body: question.body.slice(0, 140),
          link: `/mi-tienda/${seller.id}/preguntas`, data: { questionId: question.id },
        });
      }
    } else {
      await this.inbox.notifyStaff({ type: 'new_question', title: `Pregunta sobre ${product.name}`, body: question.body.slice(0, 140), link: '/admin/moderacion' });
    }
    return { id: question.id, body: question.body, createdAt: question.createdAt, answer: null };
  }

  async answer(ctx, sellerId, questionId, body) {
    const { customer, actorCtx } = this.accounts.requireMember(ctx, sellerId);
    const question = this.questions.repository.byId(questionId);
    if (!question || question.sellerId !== sellerId) throw new NotFoundError('pregunta', questionId);
    const updated = await this.questions.update(questionId, { answer: { body, at: now(), byCustomerId: customer.id } }, actorCtx);
    const product = this.catalog.products.repository.byId(question.productId);
    await this.inbox.notify({
      recipientId: question.customerId, type: 'question_answered', title: `Respondieron tu pregunta sobre ${product?.name || 'un producto'}`,
      body: body.slice(0, 140), link: product ? `/producto/${product.handle}` : null,
    });
    return updated;
  }

  // --- Publicaciones y feed ---------------------------------------------------------

  async createPost(ctx, sellerId, { type = 'update', body, imageUrl = null, productIds = [] }) {
    const { seller, customer, actorCtx } = this.accounts.requireMember(ctx, sellerId);
    if (seller.status !== 'active') throw new ConflictError('La tienda debe estar aprobada para publicar en la comunidad.');
    if (imageUrl && !IMAGE.test(imageUrl)) throw ValidationError.single('imageUrl', 'Solo se admiten imágenes subidas a la plataforma.');
    for (const productId of productIds) {
      const product = this.catalog.products.repository.byId(productId);
      if (!product || product.sellerId !== sellerId) throw ValidationError.single('productIds', 'Solo puedes etiquetar productos de tu tienda.');
    }
    this.assertRate(this.posts.repository.all({ sellerId }), { windowMs: 3_600_000, max: 10, message: 'Demasiadas publicaciones seguidas.' });
    const post = await this.posts.create({ sellerId, authorCustomerId: customer.id, type, body, imageUrl, productIds, status: 'published' }, actorCtx);
    await this.feed.create({ type: 'seller_post', sellerId, postId: post.id, localityId: seller.localityId || null });
    return post;
  }

  async addFeedItem(item) {
    const duplicate = this.feed.repository.all({ type: item.type })
      .find(row => row.productId === (item.productId || undefined) && row.sellerId === (item.sellerId || undefined)
        && row.promotionId === (item.promotionId || undefined) && (ageInDays(row.createdAt) ?? 99) < 7);
    if (duplicate) return duplicate;
    return this.feed.create(item);
  }

  /**
   * Feed de actividad: novedades de tiendas, ofertas, nuevas tiendas y
   * publicaciones. Con `scope=following` solo las tiendas que sigue el cliente.
   * Cada 5 elementos se intercala una recomendación calculada por tendencia.
   */
  feedFor(ctx, { scope = 'all', locality = null, limit = 20, offset = 0 } = {}) {
    const customer = this.customer.customers.customerFromRequest(ctx);
    const followed = customer
      ? new Set(this.follows.repository.all({ followerId: customer.id, targetType: 'seller' }).map(row => row.targetId))
      : new Set();
    if (scope === 'following' && !customer) throw new UnauthorizedError('Inicia sesión para ver las tiendas que sigues.');
    const rows = this.feed.repository.all({ visible: true })
      .filter(row => scope !== 'following' || followed.has(row.sellerId))
      .filter(row => !locality || !row.localityId || row.localityId === locality)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const hydrated = [];
    for (const row of rows) {
      const item = this.hydrate(row, followed);
      if (item) hydrated.push(item);
      if (hydrated.length >= offset + limit) break;
    }
    const page = hydrated.slice(offset, offset + limit);
    const trending = this.discovery.home({ locality }).recommended;
    const output = [];
    page.forEach((item, index) => {
      output.push(item);
      if ((index + 1) % 5 === 0 && trending[(index + 1) / 5 - 1]) {
        output.push({ id: `rec_${index}`, type: 'recommendation', product: trending[(index + 1) / 5 - 1], createdAt: null });
      }
    });
    if (!page.length && offset === 0) {
      for (const product of trending.slice(0, 6)) output.push({ id: `rec_${product.id}`, type: 'recommendation', product, createdAt: null });
    }
    return { data: output, count: rows.length, hasMore: hydrated.length > offset + limit };
  }

  hydrate(row, followed) {
    const seller = row.sellerId ? this.channel.sellers.repository.byId(row.sellerId) : null;
    if (row.sellerId && seller?.status !== 'active') return null;
    const base = {
      id: row.id,
      type: row.type,
      createdAt: row.createdAt,
      store: seller ? { ...this.discovery.sellerSummary(seller.id), followed: followed.has(seller.id) } : null,
    };
    if (row.productId) {
      const product = this.catalog.products.repository.byId(row.productId);
      if (!this.discovery.isVisible(product)) return null;
      base.product = this.discovery.card(product);
    }
    if (row.postId) {
      const post = this.posts.repository.byId(row.postId);
      if (!post || post.status !== 'published') return null;
      base.post = {
        id: post.id, type: post.type, body: post.body, imageUrl: post.imageUrl || null, likeCount: post.likeCount || 0,
        products: this.discovery.cardsFor(post.productIds || []),
      };
    }
    if (row.promotionId) {
      const promotion = this.store.collection('promotions').find(item => item.id === row.promotionId);
      if (!promotion || promotion.status !== 'active') return null;
      base.promotion = { id: promotion.id, name: promotion.name, label: promotion.label, endsAt: promotion.endsAt || null };
    }
    return base;
  }

  // --- Reportes y moderación ----------------------------------------------------------

  targetExists(targetType, targetId) {
    const collections = {
      product: 'products', seller: 'sellers', review: 'reviews', post: 'posts', user: 'customers', message: 'messages', question: 'questions',
    };
    return this.store.collection(collections[targetType]).some(row => row.id === targetId && !row.deletedAt);
  }

  async report(ctx, { targetType, targetId, reason, details = null }) {
    const customer = this.requireCustomer(ctx);
    if (!this.targetExists(targetType, targetId)) throw new NotFoundError(targetType, targetId);
    const mine = this.reports.repository.all({ reporterCustomerId: customer.id });
    if (mine.some(row => row.targetType === targetType && row.targetId === targetId && ['open', 'reviewing'].includes(row.status))) {
      throw new ConflictError('Ya reportaste este contenido; está en revisión.');
    }
    this.assertRate(mine, { windowMs: 86_400_000, max: 15, message: 'Alcanzaste el límite diario de reportes.' });
    const record = await this.reports.create({ reporterCustomerId: customer.id, targetType, targetId, reason, details, status: 'open' }, this.context(ctx, customer));
    await this.inbox.notifyStaff({
      type: 'content_reported', title: `Reporte de ${targetType}: ${reason}`, body: details ? details.slice(0, 160) : null,
      link: '/admin/moderacion', data: { reportId: record.id },
    });
    return { id: record.id, status: record.status };
  }

  /** Aplica la acción de moderación sobre el contenido reportado. */
  async resolveReport(reportId, { status, action = 'none', resolution = null }, ctx) {
    const report = this.reports.repository.retrieve(reportId);
    if (['resolved', 'dismissed'].includes(report.status)) throw new ConflictError('El reporte ya está cerrado.');
    if (status === 'resolved' && action !== 'none') {
      await this.applyAction(report.targetType, report.targetId, action, resolution, ctx);
    }
    return this.reports.update(reportId, { status, action, resolution, resolvedBy: ctx?.actor?.id || null, resolvedAt: now() }, ctx);
  }

  async applyAction(targetType, targetId, action, reason, ctx) {
    const hideIn = { review: this.reviews, post: this.posts, question: this.questions, message: this.messages };
    if (hideIn[targetType] && action === 'hidden') return hideIn[targetType].update(targetId, { status: 'hidden' }, ctx);
    if (targetType === 'product' && ['hidden', 'unpublished'].includes(action)) return this.marketplace.listings.unpublish(targetId, ctx);
    if (targetType === 'seller' && action === 'suspended') return this.accounts.setStatus(targetId, { status: 'suspend', reason: reason || 'Suspensión por moderación' }, ctx);
    if (targetType === 'user' && action === 'blocked') return this.customer.customers.update(targetId, { status: 'blocked' }, ctx);
    if (action === 'warned') return null;
    throw ValidationError.single('action', `La acción "${action}" no aplica a ${targetType}.`);
  }

  moderationQueue() {
    const reports = this.reports.repository.all().filter(row => ['open', 'reviewing'].includes(row.status))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map(row => ({ ...row, preview: this.preview(row.targetType, row.targetId) }));
    return {
      reports,
      pendingReviews: this.reviews.repository.all({ status: 'pending' }).map(review => this.reviewView(review)),
      flaggedMessages: this.messages.repository.all({ status: 'flagged' }).map(message => ({ id: message.id, conversationId: message.conversationId, body: message.body, flags: message.flags, createdAt: message.createdAt })),
      counts: {
        reports: reports.length,
        pendingReviews: this.reviews.repository.count({ status: 'pending' }),
        flaggedMessages: this.messages.repository.count({ status: 'flagged' }),
      },
    };
  }

  preview(targetType, targetId) {
    const map = {
      product: () => this.catalog.products.repository.byId(targetId)?.name,
      seller: () => this.channel.sellers.repository.byId(targetId)?.name,
      review: () => this.reviews.repository.byId(targetId)?.comment,
      post: () => this.posts.repository.byId(targetId)?.body,
      question: () => this.questions.repository.byId(targetId)?.body,
      message: () => this.messages.repository.byId(targetId)?.body,
      user: () => displayName(this.customer.customers.repository.byId(targetId)),
    };
    return String(map[targetType]?.() || '').slice(0, 200) || null;
  }

  // --- Mensajería comprador ↔ tienda --------------------------------------------------

  /**
   * Antispam: ritmo por minuto y por día, texto duplicado y enlaces. Un mensaje
   * con muchos enlaces no se rechaza: queda retenido para moderación.
   */
  screenMessage(senderId, body) {
    const text = String(body || '').trim();
    if (!text) throw ValidationError.single('body', 'El mensaje está vacío.');
    if (text.length > 2000) throw ValidationError.single('body', 'El mensaje supera 2000 caracteres.');
    const mine = this.messages.repository.all({ senderId });
    const perMinute = this.settings.get('marketplace.messagesPerMinute', 6);
    this.assertRate(mine, { windowMs: 60_000, max: perMinute, message: 'Estás enviando mensajes muy rápido.' });
    this.assertRate(mine, { windowMs: 86_400_000, max: 200, message: 'Alcanzaste el límite diario de mensajes.' });
    if (mine.some(row => row.body === text && Date.now() - new Date(row.createdAt).getTime() < 600_000)) {
      throw new ConflictError('Ya enviaste ese mismo mensaje hace un momento.');
    }
    const flags = [];
    const links = (text.match(LINK) || []).length;
    if (links > 2) flags.push('many_links');
    return { text, status: flags.length ? 'flagged' : 'sent', flags };
  }

  async startConversation(ctx, { sellerId, productId = null, vendorOrderId = null, body }) {
    const customer = this.requireCustomer(ctx);
    const seller = this.activeSeller(sellerId);
    if (this.accounts.membershipsFor(customer.id).some(row => row.sellerId === sellerId)) {
      throw new ConflictError('No puedes escribirle a tu propia tienda.');
    }
    if (productId) {
      const product = this.catalog.products.repository.byId(productId);
      if (!product || product.sellerId !== sellerId) throw ValidationError.single('productId', 'El producto no es de esta tienda.');
    }
    if (vendorOrderId) {
      const vendorOrder = this.store.collection('vendorOrders').find(row => row.id === vendorOrderId);
      if (!vendorOrder || vendorOrder.sellerId !== sellerId || vendorOrder.customerId !== customer.id) throw ValidationError.single('vendorOrderId', 'El pedido no corresponde.');
    }
    const existing = this.conversations.repository.all({ customerId: customer.id, sellerId })
      .find(row => row.status !== 'blocked' && (row.productId || null) === productId && (row.vendorOrderId || null) === vendorOrderId);
    if (existing?.status === 'blocked') throw new ConflictError('Esta conversación está bloqueada.');
    const product = productId ? this.catalog.products.repository.byId(productId) : null;
    const conversation = existing || await this.conversations.create({
      customerId: customer.id, sellerId, productId, vendorOrderId,
      subject: product ? `Consulta sobre ${product.name}`.slice(0, 160) : vendorOrderId ? 'Consulta sobre un pedido' : `Consulta a ${seller.name}`.slice(0, 160),
      status: 'open',
    }, this.context(ctx, customer));
    await this.send(ctx, conversation.id, { senderType: 'customer', senderId: customer.id, body, customer, seller });
    return this.conversationView(this.conversations.repository.retrieve(conversation.id), 'customer');
  }

  async send(ctx, conversationId, { senderType, senderId, body, customer = null, seller = null }) {
    const conversation = this.conversations.repository.retrieve(conversationId);
    if (conversation.status !== 'open') throw new ConflictError('La conversación no admite mensajes.');
    const screened = this.screenMessage(senderId, body);
    const actorCtx = { actor: { id: senderId, type: 'customer', permissions: new Set() }, ip: ctx?.ip || null, requestId: ctx?.requestId || null };
    const message = await this.messages.create({ conversationId, senderType, senderId, body: screened.text, status: screened.status, flags: screened.flags }, actorCtx);
    if (screened.status === 'sent') {
      await this.store.transaction(state => this.conversations.repository.patch(state, conversationId, {
        lastMessageAt: now(),
        lastMessagePreview: screened.text.slice(0, 160),
        unreadForCustomer: senderType === 'seller' ? (conversation.unreadForCustomer || 0) + 1 : conversation.unreadForCustomer || 0,
        unreadForSeller: senderType === 'customer' ? (conversation.unreadForSeller || 0) + 1 : conversation.unreadForSeller || 0,
      }));
      if (senderType === 'customer') {
        const store = seller || this.channel.sellers.repository.byId(conversation.sellerId);
        if (store) await this.accounts.notifyOwners(store, { type: 'new_message', title: 'Nuevo mensaje de un cliente', body: screened.text.slice(0, 140), link: `/mi-tienda/${store.id}/mensajes/${conversationId}` });
      } else {
        await this.inbox.notify({ recipientId: conversation.customerId, type: 'seller_message', title: 'La tienda te respondió', body: screened.text.slice(0, 140), link: `/cuenta/mensajes/${conversationId}` });
      }
    } else {
      await this.inbox.notifyStaff({ type: 'message_flagged', title: 'Mensaje retenido para moderación', body: screened.flags.join(', '), link: '/admin/moderacion' });
    }
    return { id: message.id, status: message.status, held: screened.status !== 'sent' };
  }

  conversationView(conversation, perspective) {
    const seller = this.channel.sellers.repository.byId(conversation.sellerId);
    const customer = this.customer.customers.repository.byId(conversation.customerId);
    return {
      id: conversation.id,
      subject: conversation.subject,
      status: conversation.status,
      productId: conversation.productId || null,
      vendorOrderId: conversation.vendorOrderId || null,
      store: seller ? { id: seller.id, code: seller.code, name: seller.name, logoUrl: seller.logoUrl || null } : null,
      customerName: displayName(customer),
      lastMessageAt: conversation.lastMessageAt,
      lastMessagePreview: conversation.lastMessagePreview,
      unread: perspective === 'customer' ? conversation.unreadForCustomer || 0 : conversation.unreadForSeller || 0,
    };
  }

  /** Mensajes visibles de una conversación; el lector marca como leído. */
  async thread(conversation, perspective, viewerId) {
    const rows = this.messages.repository.all({ conversationId: conversation.id })
      .filter(row => row.status === 'sent' || (row.status === 'flagged' && row.senderId === viewerId))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const field = perspective === 'customer' ? 'unreadForCustomer' : 'unreadForSeller';
    if (conversation[field]) await this.store.transaction(state => this.conversations.repository.patch(state, conversation.id, { [field]: 0 }));
    return {
      conversation: this.conversationView(this.conversations.repository.retrieve(conversation.id), perspective),
      messages: rows.map(row => ({ id: row.id, mine: row.senderId === viewerId, senderType: row.senderType, body: row.body, status: row.status, createdAt: row.createdAt })),
    };
  }

  customerConversation(ctx, conversationId) {
    const customer = this.requireCustomer(ctx);
    const conversation = this.conversations.repository.byId(conversationId);
    if (!conversation || conversation.customerId !== customer.id) throw new NotFoundError('conversación', conversationId);
    return { customer, conversation };
  }

  sellerConversation(ctx, sellerId, conversationId) {
    const membership = this.accounts.requireMember(ctx, sellerId);
    const conversation = this.conversations.repository.byId(conversationId);
    if (!conversation || conversation.sellerId !== sellerId) throw new NotFoundError('conversación', conversationId);
    return { ...membership, conversation };
  }
}

export default {
  name: 'community',
  requires: ['store', 'events', 'audit', 'config', 'customFields', 'settings', 'catalog', 'channel', 'customer', 'marketplace', 'alert'],
  resources: [
    favoriteResource, likeResource, followResource, reviewResource, questionResource, postResource,
    feedItemResource, reportResource, conversationResource, messageResource,
  ],
  permissions: [
    { resource: 'review', description: 'Reseñas de productos.' },
    { resource: 'question', description: 'Preguntas sobre productos.' },
    { resource: 'post', description: 'Publicaciones de tiendas.' },
    { resource: 'report', description: 'Reportes de la comunidad y moderación.' },
    { resource: 'message', description: 'Mensajería comprador-tienda (moderación).' },
    { resource: 'conversation', description: 'Conversaciones comprador-tienda (moderación).' },
    { resource: 'feedItem', description: 'Elementos del feed.' },
  ],

  register(deps) {
    return new CommunityService(deps);
  },

  /** El feed se alimenta de eventos del marketplace, sin que los módulos se conozcan. */
  subscribers: container => {
    const service = () => container.resolve('community');
    const catalog = () => container.resolve('catalog');
    return [
      {
        event: 'marketplace.listing.published',
        handler: async ({ productId, sellerId }) => {
          const product = catalog().products.repository.byId(productId);
          await service().addFeedItem({ type: 'new_product', productId, sellerId: sellerId || null, localityId: product?.localityId || null });
        },
      },
      {
        event: 'marketplace.listing.updated',
        handler: async ({ productId, sellerId }) => {
          const product = catalog().products.repository.byId(productId);
          if (product?.status === 'published' && product.price?.previousAmount > product.price?.amount) {
            await service().addFeedItem({ type: 'offer', productId, sellerId: sellerId || null, localityId: product.localityId || null });
          }
        },
      },
      {
        event: 'marketplace.seller.approved',
        handler: async ({ sellerId }) => {
          const seller = container.resolve('channel').sellers.repository.byId(sellerId);
          await service().addFeedItem({ type: 'new_store', sellerId, localityId: seller?.localityId || null });
        },
      },
      {
        event: 'marketplace.promotion.created',
        handler: async ({ promotionId, sellerId }) => {
          const seller = container.resolve('channel').sellers.repository.byId(sellerId);
          await service().addFeedItem({ type: 'offer', promotionId, sellerId, localityId: seller?.localityId || null });
        },
      },
      {
        event: 'product.updated',
        handler: async ({ record, before }) => {
          if (record?.featured && !before?.featured && record.status === 'published') {
            await service().addFeedItem({ type: 'featured', productId: record.id, sellerId: record.sellerId || null, localityId: record.localityId || null });
          }
        },
      },
    ];
  },

  routes: {
    store: container => {
      const service = () => container.resolve('community');
      const tags = ['comunidad'];
      const target = (types) => ({ targetType: rule.enumOf(types, { required: true }), targetId: rule.id({ required: true }) });
      return [
        { method: 'POST', path: '/community/favorites', permission: null, tags, body: target(['product', 'seller']), summary: 'Agrega o quita un favorito.', handler: ctx => service().toggleFavorite(ctx, ctx.body) },
        { method: 'GET', path: '/community/favorites', permission: null, bodyless: true, tags, summary: 'Favoritos del cliente.', handler: ctx => service().favoritesOf(ctx) },
        { method: 'POST', path: '/community/likes', permission: null, tags, body: target(['product', 'post', 'review']), summary: 'Me gusta (o «útil» en reseñas).', handler: ctx => service().toggleLike(ctx, ctx.body) },
        { method: 'POST', path: '/community/follows', permission: null, tags, body: target(['seller', 'customer']), summary: 'Sigue o deja de seguir una tienda o un perfil.', handler: ctx => service().toggleFollow(ctx, ctx.body) },
        { method: 'GET', path: '/community/following', permission: null, bodyless: true, tags, summary: 'Tiendas y perfiles que sigue el cliente.', handler: ctx => service().following(ctx) },
        { method: 'GET', path: '/community/profiles/:customerId', permission: null, bodyless: true, tags, summary: 'Perfil público de un comprador (nombre visible y actividad).', handler: ctx => service().profile(ctx.params.customerId) },
        {
          method: 'GET', path: '/community/feed', permission: null, bodyless: true, tags,
          query: { scope: rule.enumOf(['all', 'following']), locality: rule.id(), limit: { type: 'integer', coerce: true, min: 1, max: 50 }, offset: { type: 'integer', coerce: true, min: 0, max: 5000 } },
          summary: 'Feed de actividad: productos nuevos, ofertas, tiendas, publicaciones y recomendaciones.',
          handler: ctx => service().feedFor(ctx, ctx.query),
        },
        {
          method: 'POST', path: '/community/reviews', permission: null, status: 201, tags,
          body: {
            productId: rule.id({ required: true }), rating: { type: 'integer', coerce: true, required: true, min: 1, max: 5 },
            title: rule.text(120), comment: rule.text(2000), photos: rule.list({ type: 'string', maxLength: 500 }, { maxItems: 4 }),
          },
          summary: 'Valora un producto comprado y recibido (compra verificada).',
          handler: ctx => service().review(ctx, ctx.body),
        },
        {
          method: 'GET', path: '/community/products/:productId/reviews', permission: null, bodyless: true, tags,
          query: { limit: { type: 'integer', coerce: true, min: 1, max: 50 }, offset: { type: 'integer', coerce: true, min: 0 } },
          summary: 'Reseñas publicadas de un producto.',
          handler: ctx => service().productReviews(ctx.params.productId, { limit: ctx.query.limit || 20, offset: ctx.query.offset || 0 }),
        },
        {
          method: 'POST', path: '/community/uploads', permission: null, status: 201, tags, maxBodyBytes: 1_200_000,
          body: { data: { type: 'string', required: true, maxLength: 1_200_000 }, alt: rule.text(300) },
          summary: 'Sube una foto para una reseña (PNG, JPEG o WebP validados por firma).',
          handler: async ctx => {
            const customer = service().requireCustomer(ctx);
            // Límite persistido: 12 fotos por hora y cliente.
            const recent = container.resolve('store').collection('assets')
              .filter(asset => asset.metadata?.uploadedBy === customer.id && Date.now() - new Date(asset.createdAt).getTime() < 3_600_000);
            if (recent.length >= 12) throw new RateLimitError(3600, 12, 'Alcanzaste el límite de fotos por hora.');
            const catalog = container.resolve('catalog');
            const asset = await catalog.assets.upload({ data: ctx.body.data, name: 'foto-resena', alt: ctx.body.alt || 'Foto de reseña', tags: ['resena'] }, service().context(ctx, customer));
            if (!asset.metadata?.uploadedBy) await catalog.assets.update(asset.id, { metadata: { ...(asset.metadata || {}), uploadedBy: customer.id } });
            return { id: asset.id, url: asset.url };
          },
        },
        { method: 'GET', path: '/community/me/reviewable', permission: null, bodyless: true, tags, summary: 'Productos recibidos pendientes de valorar.', handler: ctx => service().reviewable(ctx) },
        {
          method: 'POST', path: '/community/questions', permission: null, status: 201, tags,
          body: { productId: rule.id({ required: true }), body: rule.text(600, { required: true }) },
          summary: 'Pregunta pública sobre un producto.',
          handler: ctx => service().ask(ctx, ctx.body),
        },
        {
          method: 'POST', path: '/community/reports', permission: null, status: 201, tags,
          body: {
            targetType: rule.enumOf(REPORT_TARGETS, { required: true }), targetId: rule.id({ required: true }),
            reason: rule.enumOf(['spam', 'fraud', 'inappropriate', 'counterfeit', 'prohibited', 'wrong_info', 'other'], { required: true }),
            details: rule.text(1000),
          },
          summary: 'Reporta un producto, tienda, reseña, publicación, pregunta, mensaje o usuario.',
          handler: ctx => service().report(ctx, ctx.body),
        },
        {
          method: 'POST', path: '/community/conversations', permission: null, status: 201, tags,
          body: { sellerId: rule.id({ required: true }), productId: rule.id(), vendorOrderId: rule.id(), body: rule.text(2000, { required: true }) },
          summary: 'Inicia (o continúa) una consulta con una tienda.',
          handler: ctx => service().startConversation(ctx, ctx.body),
        },
        {
          method: 'GET', path: '/community/conversations', permission: null, bodyless: true, tags, summary: 'Conversaciones del cliente.',
          handler: ctx => {
            const customer = service().requireCustomer(ctx);
            const data = service().conversations.repository.all({ customerId: customer.id })
              .sort((a, b) => String(b.lastMessageAt || b.createdAt).localeCompare(String(a.lastMessageAt || a.createdAt)))
              .map(row => service().conversationView(row, 'customer'));
            return { data, count: data.length };
          },
        },
        {
          method: 'GET', path: '/community/conversations/:id/messages', permission: null, bodyless: true, tags, summary: 'Mensajes de una conversación propia.',
          handler: ctx => {
            const { customer, conversation } = service().customerConversation(ctx, ctx.params.id);
            return service().thread(conversation, 'customer', customer.id);
          },
        },
        {
          method: 'POST', path: '/community/conversations/:id/messages', permission: null, status: 201, tags, body: { body: rule.text(2000, { required: true }) },
          summary: 'Envía un mensaje a la tienda.',
          handler: ctx => {
            const { customer } = service().customerConversation(ctx, ctx.params.id);
            return service().send(ctx, ctx.params.id, { senderType: 'customer', senderId: customer.id, body: ctx.body.body, customer });
          },
        },
        // --- Tienda -----------------------------------------------------------------
        {
          method: 'GET', path: '/community/seller/:sellerId/reviews', permission: null, bodyless: true, tags, summary: 'Reseñas de los productos de la tienda.',
          handler: ctx => {
            container.resolve('marketplace').accounts.requireMember(ctx, ctx.params.sellerId);
            const data = service().reviews.repository.all({ sellerId: ctx.params.sellerId }).filter(row => row.status !== 'rejected')
              .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
              .map(review => ({ ...service().reviewView(review), productName: container.resolve('catalog').products.repository.byId(review.productId)?.name || null }));
            return { data, count: data.length };
          },
        },
        {
          method: 'POST', path: '/community/seller/:sellerId/reviews/:reviewId/reply', permission: null, tags, body: { body: rule.text(1000, { required: true }) },
          summary: 'La tienda responde una reseña.',
          handler: ctx => service().replyReview(ctx, ctx.params.sellerId, ctx.params.reviewId, ctx.body.body),
        },
        {
          method: 'GET', path: '/community/seller/:sellerId/questions', permission: null, bodyless: true, tags, summary: 'Preguntas sobre los productos de la tienda.',
          handler: ctx => {
            container.resolve('marketplace').accounts.requireMember(ctx, ctx.params.sellerId);
            const data = service().questions.repository.all({ sellerId: ctx.params.sellerId }).filter(row => row.status === 'published')
              .sort((a, b) => Number(Boolean(a.answer?.at)) - Number(Boolean(b.answer?.at)) || String(b.createdAt).localeCompare(String(a.createdAt)))
              .map(row => ({ ...row, productName: container.resolve('catalog').products.repository.byId(row.productId)?.name || null }));
            return { data, count: data.length };
          },
        },
        {
          method: 'POST', path: '/community/seller/:sellerId/questions/:questionId/answer', permission: null, tags, body: { body: rule.text(1000, { required: true }) },
          summary: 'La tienda responde una pregunta.',
          handler: ctx => service().answer(ctx, ctx.params.sellerId, ctx.params.questionId, ctx.body.body),
        },
        {
          method: 'GET', path: '/community/seller/:sellerId/posts', permission: null, bodyless: true, tags, summary: 'Publicaciones de la tienda.',
          handler: ctx => {
            container.resolve('marketplace').accounts.requireMember(ctx, ctx.params.sellerId);
            const data = service().posts.repository.all({ sellerId: ctx.params.sellerId }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
            return { data, count: data.length };
          },
        },
        {
          method: 'POST', path: '/community/seller/:sellerId/posts', permission: null, status: 201, tags,
          body: { type: rule.enumOf(['update', 'offer', 'new_product', 'event'], { default: 'update' }), body: rule.text(1500, { required: true }), imageUrl: rule.text(500), productIds: rule.list({ type: 'string' }, { maxItems: 6 }) },
          summary: 'Publica una novedad de la tienda en la comunidad.',
          handler: ctx => service().createPost(ctx, ctx.params.sellerId, ctx.body),
        },
        {
          method: 'DELETE', path: '/community/seller/:sellerId/posts/:postId', permission: null, bodyless: true, tags, summary: 'Retira una publicación de la tienda.',
          handler: async ctx => {
            const { actorCtx } = container.resolve('marketplace').accounts.requireMember(ctx, ctx.params.sellerId);
            const post = service().posts.repository.byId(ctx.params.postId);
            if (!post || post.sellerId !== ctx.params.sellerId) throw new NotFoundError('publicación', ctx.params.postId);
            await service().posts.update(post.id, { status: 'hidden' }, actorCtx);
            return { hidden: true };
          },
        },
        {
          method: 'GET', path: '/community/seller/:sellerId/conversations', permission: null, bodyless: true, tags, summary: 'Consultas de clientes a la tienda.',
          handler: ctx => {
            container.resolve('marketplace').accounts.requireMember(ctx, ctx.params.sellerId);
            const data = service().conversations.repository.all({ sellerId: ctx.params.sellerId })
              .filter(row => row.lastMessageAt)
              .sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt)))
              .map(row => service().conversationView(row, 'seller'));
            return { data, count: data.length };
          },
        },
        {
          method: 'GET', path: '/community/seller/:sellerId/conversations/:id/messages', permission: null, bodyless: true, tags, summary: 'Mensajes de una consulta de la tienda.',
          handler: ctx => {
            const { customer, conversation } = service().sellerConversation(ctx, ctx.params.sellerId, ctx.params.id);
            return service().thread(conversation, 'seller', customer.id);
          },
        },
        {
          method: 'POST', path: '/community/seller/:sellerId/conversations/:id/messages', permission: null, status: 201, tags, body: { body: rule.text(2000, { required: true }) },
          summary: 'La tienda responde una consulta.',
          handler: ctx => {
            const { customer, seller } = service().sellerConversation(ctx, ctx.params.sellerId, ctx.params.id);
            return service().send(ctx, ctx.params.id, { senderType: 'seller', senderId: customer.id, body: ctx.body.body, seller });
          },
        },
      ];
    },

    admin: container => {
      const service = () => container.resolve('community');
      const tags = ['comunidad'];
      const readOnly = routes => routes.filter(route => route.method === 'GET');
      return [
        ...readOnly(crudRoutes(reviewResource, () => service().reviews, { tags })),
        ...readOnly(crudRoutes(questionResource, () => service().questions, { tags })),
        ...readOnly(crudRoutes(postResource, () => service().posts, { tags })),
        ...readOnly(crudRoutes(reportResource, () => service().reports, { tags })),
        ...readOnly(crudRoutes(messageResource, () => service().messages, { tags })),
        ...readOnly(crudRoutes(conversationResource, () => service().conversations, { tags })),
        {
          method: 'GET', path: '/community/moderation', permission: 'report:read', bodyless: true, tags,
          summary: 'Bandeja de moderación: reportes abiertos, reseñas pendientes y mensajes retenidos.',
          handler: () => service().moderationQueue(),
        },
        {
          method: 'POST', path: '/community/reports/:id/resolve', permission: 'report:update', tags,
          body: {
            status: rule.enumOf(['reviewing', 'resolved', 'dismissed'], { required: true }),
            action: rule.enumOf(['none', 'hidden', 'unpublished', 'suspended', 'blocked', 'warned'], { default: 'none' }),
            resolution: rule.text(600),
          },
          summary: 'Resuelve un reporte y aplica la acción sobre el contenido.',
          handler: ctx => {
            if (ctx.body.status === 'reviewing') return service().reports.update(ctx.params.id, { status: 'reviewing' }, ctx);
            return service().resolveReport(ctx.params.id, ctx.body, ctx);
          },
        },
        {
          method: 'POST', path: '/community/reviews/:id/moderate', permission: 'review:update', tags,
          body: { status: rule.enumOf(['published', 'hidden', 'rejected'], { required: true }), note: rule.text(300) },
          summary: 'Publica, oculta o rechaza una reseña.',
          handler: ctx => service().reviews.update(ctx.params.id, { status: ctx.body.status, moderationNote: ctx.body.note || null }, ctx),
        },
        {
          method: 'POST', path: '/community/questions/:id/moderate', permission: 'question:update', tags,
          body: { status: rule.enumOf(['published', 'hidden'], { required: true }) },
          summary: 'Publica u oculta una pregunta.',
          handler: ctx => service().questions.update(ctx.params.id, { status: ctx.body.status }, ctx),
        },
        {
          method: 'POST', path: '/community/posts/:id/moderate', permission: 'post:update', tags,
          body: { status: rule.enumOf(['published', 'hidden'], { required: true }) },
          summary: 'Publica u oculta una publicación.',
          handler: ctx => service().posts.update(ctx.params.id, { status: ctx.body.status }, ctx),
        },
        {
          method: 'POST', path: '/community/messages/:id/moderate', permission: 'message:update', tags,
          body: { status: rule.enumOf(['sent', 'hidden'], { required: true }) },
          summary: 'Libera u oculta un mensaje retenido.',
          handler: async ctx => {
            const message = await service().messages.update(ctx.params.id, { status: ctx.body.status }, ctx);
            if (ctx.body.status === 'sent') {
              await container.resolve('store').transaction(state => service().conversations.repository.patch(state, message.conversationId, {
                lastMessageAt: now(), lastMessagePreview: message.body.slice(0, 160),
              }));
            }
            return message;
          },
        },
        {
          method: 'POST', path: '/community/conversations/:id/block', permission: 'conversation:update', tags,
          body: { reason: rule.text(300) },
          summary: 'Bloquea una conversación abusiva.',
          handler: ctx => service().conversations.update(ctx.params.id, { status: 'blocked', metadata: { blockedReason: ctx.body.reason || null } }, ctx),
        },
      ];
    },
  },
};
