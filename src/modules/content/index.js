/**
 * Contenido editorial (M-0396 … M-0410).
 *
 * Guías y comparativas con productos referenciados. Dos reglas del proyecto que este
 * módulo hace cumplir por construcción:
 *
 *  - toda pieza con enlaces afiliados lleva **divulgación de afiliado** (M-0403);
 *  - una comparativa exige **criterios declarados** y al menos dos productos reales:
 *    sin eso no es una comparativa, es una recomendación disfrazada (M-0398).
 */
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule } from '../../framework/validate.js';
import { NotFoundError, ValidationError } from '../../framework/errors.js';
import { uniqueSlug } from '../../framework/strings.js';
import { ageInDays, isActiveNow, now } from '../../framework/dates.js';

export const CONTENT_TYPES = ['guide', 'comparison', 'review', 'page', 'faq'];

export const contentResource = defineResource({
  name: 'content',
  collection: 'contents',
  prefix: 'page',
  route: 'contents',
  unique: ['handle'],
  searchable: ['title', 'excerpt', 'body'],
  translatable: ['title', 'excerpt', 'body', 'handle'],
  fields: {
    type: rule.enumOf(CONTENT_TYPES, { default: 'guide' }),
    title: rule.text(200, { required: true }),
    handle: rule.handle(),
    excerpt: rule.text(500),
    body: rule.longText(),
    blocks: rule.list({
      type: 'object',
      shape: {
        kind: rule.enumOf(['text', 'products', 'comparison', 'quote', 'faq', 'callout'], { required: true }),
        title: rule.text(200),
        text: rule.longText(),
        productIds: rule.list({ type: 'string' }),
        items: rule.list({ type: 'object', shape: { question: rule.text(300), answer: rule.longText() } }),
      },
    }, { default: [] }),
    productIds: rule.list({ type: 'string' }, { default: [] }),
    // Criterios de comparación declarados: obligatorios en `comparison`.
    comparisonCriteria: rule.list({
      type: 'object',
      shape: {
        key: rule.text(60, { required: true }),
        label: rule.text(120, { required: true }),
        weight: { type: 'number', coerce: true, min: 0, max: 100 },
        direction: rule.enumOf(['higher_better', 'lower_better', 'informative'], { default: 'informative' }),
      },
    }, { default: [] }),
    comparisonValues: rule.metadata(),
    categoryId: rule.id(),
    tagIds: rule.list({ type: 'string' }, { default: [] }),
    assetId: rule.id(),
    author: rule.text(120),
    reviewedAt: rule.date(),
    reviewIntervalDays: { type: 'integer', coerce: true, min: 0, max: 730, default: 180 },
    status: rule.enumOf(['draft', 'scheduled', 'published', 'archived'], { default: 'draft' }),
    publishAt: rule.date(),
    publishedAt: rule.date(),
    // Se calcula: no se acepta desactivar la divulgación desde el cuerpo.
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
    clickCount: rule.quantity({ default: 0 }),
    metadata: rule.metadata(),
  },
});

export class ContentService extends BaseService {
  constructor(deps) {
    super(deps, contentResource);
    this.catalog = deps.catalog;
    this.settings = deps.settings;
  }

  handles() {
    return new Set(this.repository.all().map(row => row.handle).filter(Boolean));
  }

  async beforeCreate(data) {
    this.assertConsistent(data);
    return {
      ...data,
      handle: data.handle || uniqueSlug(data.title, this.handles()),
      publishedAt: data.status === 'published' ? now() : null,
      reviewedAt: data.reviewedAt || now(),
    };
  }

  async beforeUpdate(existing, changes) {
    const merged = { ...existing, ...changes };
    this.assertConsistent(merged);
    if (changes.status === 'published' && existing.status !== 'published') changes.publishedAt = now();
    return changes;
  }

  assertConsistent(content) {
    const issues = [];
    const productIds = [
      ...(content.productIds || []),
      ...(content.blocks || []).flatMap(block => block.productIds || []),
    ];
    const unique = [...new Set(productIds)];

    for (const productId of unique) {
      if (!this.catalog.products.repository.byId(productId)) {
        issues.push({ field: 'productIds', message: `El producto ${productId} no existe.` });
      }
    }

    if (content.type === 'comparison') {
      if (unique.length < 2) {
        issues.push({ field: 'productIds', message: 'Una comparativa necesita al menos dos productos reales.' });
      }
      if (!(content.comparisonCriteria || []).length) {
        issues.push({ field: 'comparisonCriteria', message: 'Una comparativa necesita criterios declarados.' });
      }
      for (const productId of unique) {
        const values = (content.comparisonValues || {})[productId];
        const missing = (content.comparisonCriteria || [])
          .map(criterion => criterion.key)
          .filter(key => values?.[key] === undefined || values?.[key] === null || values?.[key] === '');
        if (missing.length) {
          issues.push({
            field: 'comparisonValues',
            message: `Faltan valores de ${missing.join(', ')} para el producto ${productId}.`,
          });
        }
      }
    }

    if (content.status === 'scheduled' && !content.publishAt) {
      issues.push({ field: 'publishAt', message: 'Una publicación programada necesita fecha.' });
    }
    if (issues.length) throw new ValidationError(issues);
    return true;
  }

  byHandle(handle) {
    return this.repository.find({ handle });
  }

  published() {
    return this.repository.all({ status: 'published' }).sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  }

  /** ¿La pieza enlaza a productos afiliados? Decide si la divulgación es obligatoria. */
  hasAffiliateLinks(content) {
    const productIds = [
      ...(content.productIds || []),
      ...(content.blocks || []).flatMap(block => block.productIds || []),
    ];
    return productIds.some(productId => {
      const product = this.catalog.products.repository.byId(productId);
      return product && product.monetizationType !== 'DIRECT';
    });
  }

  /** Proyección pública con divulgación resuelta y productos expandidos. */
  publicView(content) {
    if (!content) return null;
    const products = [
      ...new Set([...(content.productIds || []), ...(content.blocks || []).flatMap(block => block.productIds || [])]),
    ]
      .map(productId => this.catalog.products.repository.byId(productId))
      .filter(product => product?.status === 'published')
      .map(product => ({
        id: product.id,
        handle: product.handle,
        name: product.name,
        subtitle: product.subtitle,
        image: product.image,
        price: product.price || null,
        monetizationType: product.monetizationType,
      }));

    const requiresDisclosure = this.hasAffiliateLinks(content);
    const stale = (ageInDays(content.reviewedAt) ?? 0) > (content.reviewIntervalDays || 180);

    return {
      id: content.id,
      type: content.type,
      title: content.title,
      handle: content.handle,
      excerpt: content.excerpt,
      body: content.body,
      blocks: content.blocks || [],
      comparisonCriteria: content.comparisonCriteria || [],
      comparisonValues: content.comparisonValues || {},
      products,
      author: content.author,
      reviewedAt: content.reviewedAt,
      publishedAt: content.publishedAt,
      seo: content.seo || {},
      // La divulgación se calcula, no se declara: no se puede desactivar por error.
      affiliateDisclosure: requiresDisclosure
        ? this.settings.get('affiliateDisclosure', 'Algunos enlaces son enlaces de afiliado.')
        : null,
      outdated: stale,
      outdatedNote: stale ? `Esta pieza se revisó hace ${ageInDays(content.reviewedAt)} días.` : null,
    };
  }

  /** Publica lo programado cuya fecha ya llegó (M-0400). */
  async publishScheduled(ctx = null) {
    const due = this.repository
      .all({ status: 'scheduled' })
      .filter(content => content.publishAt && isActiveNow({ startsAt: content.publishAt }));
    for (const content of due) await this.update(content.id, { status: 'published' }, ctx);
    return { published: due.length };
  }

  /** Contenido publicado que ya debería revisarse (M-0402). */
  needsReview() {
    return this.published()
      .map(content => ({
        id: content.id,
        title: content.title,
        handle: content.handle,
        reviewedAt: content.reviewedAt,
        ageDays: ageInDays(content.reviewedAt),
        intervalDays: content.reviewIntervalDays || 180,
      }))
      .filter(row => (row.ageDays ?? 0) > row.intervalDays)
      .sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));
  }

  async registerClick(contentId) {
    return this.store.transaction(state => {
      const row = (state.contents || []).find(entry => entry.id === contentId);
      if (!row) return null;
      row.clickCount = (row.clickCount || 0) + 1;
      return row.clickCount;
    });
  }
}

export default {
  name: 'content',
  requires: ['store', 'events', 'audit', 'config', 'customFields', 'translations', 'catalog', 'settings'],
  resources: [contentResource],
  permissions: [{ resource: 'content', description: 'Contenido editorial: guías y comparativas.' }],

  jobs: container => [
    {
      name: 'content.publish-scheduled',
      everyMs: 15 * 60_000,
      handler: () => container.resolve('content').publishScheduled(),
    },
    {
      name: 'content.review-reminder',
      everyMs: 24 * 3_600_000,
      handler: async () => {
        const stale = container.resolve('content').needsReview();
        for (const row of stale) {
          await container.resolve('alert').raise({
            type: 'content_outdated',
            severity: 'info',
            message: `«${row.title}» se revisó hace ${row.ageDays} días (intervalo ${row.intervalDays}).`,
            entityId: row.id,
            entityType: 'content',
          });
        }
        return { stale: stale.length };
      },
    },
  ],

  register(deps) {
    return new ContentService(deps);
  },

  routes: {
    admin: container => {
      const service = () => container.resolve('content');
      return [
        ...crudRoutes(contentResource, () => service(), { tags: ['contenido'] }),
        {
          method: 'GET',
          path: '/contents/needs-review',
          permission: 'content:read',
          summary: 'Contenido publicado pendiente de revisión editorial.',
          tags: ['contenido'],
          bodyless: true,
          handler: () => {
            const data = service().needsReview();
            return { data, count: data.length };
          },
        },
      ];
    },

    store: container => {
      const service = () => container.resolve('content');
      return [
        {
          method: 'GET',
          path: '/contents',
          permission: null,
          summary: 'Contenido publicado.',
          tags: ['store'],
          bodyless: true,
          handler: ctx => {
            const rows = service().published().filter(content => !ctx.query.type || content.type === ctx.query.type);
            const data = rows.map(content => ({
              id: content.id,
              type: content.type,
              title: content.title,
              handle: content.handle,
              excerpt: content.excerpt,
              publishedAt: content.publishedAt,
            }));
            return { data, count: data.length };
          },
        },
        {
          method: 'GET',
          path: '/contents/:handle',
          permission: null,
          summary: 'Pieza de contenido publicada, con divulgación de afiliado si aplica.',
          tags: ['store'],
          bodyless: true,
          handler: ctx => {
            const content = service().byHandle(ctx.params.handle);
            if (!content || content.status !== 'published') {
              throw new NotFoundError('contenido', ctx.params.handle);
            }
            return service().publicView(content);
          },
        },
      ];
    },
  },
};
