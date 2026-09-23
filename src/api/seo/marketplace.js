/**
 * SEO del marketplace.
 *
 * La tienda pública es una SPA, pero cada URL indexable se sirve desde el
 * servidor con su `<title>`, descripción, `canonical`, Open Graph, datos
 * estructurados y un resumen legible sin JavaScript. La SPA toma el control
 * después sobre el mismo HTML.
 *
 * Productos afiliados: la ficha del marketplace declara como `canonical` la
 * ficha editorial ya existente (`/producto/<slug>-<id>`), para no competir con
 * ella con contenido duplicado, y no se incluye en el sitemap.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvRow, escapeHtml, escapeJsonLd, slug, truncate } from '../../framework/strings.js';
import { format as formatMoney, toDecimal } from '../../framework/money.js';
import * as respond from '../../framework/http/respond.js';

const shellPath = join(fileURLToPath(new URL('../../..', import.meta.url)), 'public', 'index.html');
let cache = { mtime: 0, html: '' };

function shell() {
  const mtime = statSync(shellPath).mtimeMs;
  if (mtime !== cache.mtime) cache = { mtime, html: readFileSync(shellPath, 'utf8') };
  return cache.html;
}

/**
 * @param {object} options
 * @param {string} [options.type] `product` en las fichas: Facebook y WhatsApp
 *   muestran precio y disponibilidad en la vista previa del enlace compartido.
 * @param {string[]} [options.extraMeta] Etiquetas ya formadas (precio, marca…).
 */
export function renderShell({
  title, description = '', canonical = null, jsonLd = null, noindex = false, image = null, prerender = '',
  type = 'website', siteName = 'Ndivepa', imageAlt = null, extraMeta = [],
}) {
  const head = [
    `<meta name="description" content="${escapeHtml(truncate(description, 300))}">`,
    `<meta name="robots" content="${noindex ? 'noindex,follow' : 'index,follow'}">`,
    canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : '',
    `<meta property="og:type" content="${escapeHtml(type)}">`,
    `<meta property="og:site_name" content="${escapeHtml(siteName)}">`,
    '<meta property="og:locale" content="es_PY">',
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(truncate(description, 300))}">`,
    canonical ? `<meta property="og:url" content="${escapeHtml(canonical)}">` : '',
    image ? `<meta property="og:image" content="${escapeHtml(image)}">` : '',
    image && imageAlt ? `<meta property="og:image:alt" content="${escapeHtml(imageAlt)}">` : '',
    '<meta name="twitter:card" content="summary_large_image">',
    ...extraMeta,
    jsonLd ? `<script type="application/ld+json">${escapeJsonLd(jsonLd)}</script>` : '',
  ].filter(Boolean).join('\n    ');
  return shell()
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(/<meta name="description"[^>]*>\s*/, '')
    .replace(/<meta name="robots"[^>]*>\s*/, '')
    .replace('<!--ndv:head-->', head)
    .replace('<!--ndv:prerender-->', prerender);
}

export class MarketplaceSeo {
  constructor({ container, config }) {
    this.container = container;
    this.config = config;
  }

  get mp() { return this.container.resolve('marketplace'); }
  get settings() { return this.container.resolve('settings').settings; }

  origin(ctx) {
    if (this.config.publicBaseUrl) return this.config.publicBaseUrl;
    return `http://${ctx.req.headers.host || `localhost:${this.config.port}`}`;
  }

  brand() {
    return this.settings.get('marketplace.name', 'Ndivepa');
  }

  home(ctx) {
    const origin = this.origin(ctx);
    const home = this.mp.discovery.home();
    const title = `${this.brand()} · Comercio local de ${home.marketplace.locality || 'tu ciudad'}`;
    const description = this.settings.get('marketplace.tagline', '');
    return renderShell({
      title,
      description,
      canonical: `${origin}/`,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: this.brand(),
        url: `${origin}/`,
        potentialAction: { '@type': 'SearchAction', target: `${origin}/buscar?q={search_term_string}`, 'query-input': 'required name=search_term_string' },
      },
      prerender: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p><ul>${home.categories.map(category => `<li><a href="/categoria/${escapeHtml(category.handle)}">${escapeHtml(category.name)}</a></li>`).join('')}</ul>`,
    });
  }

  product(ctx, handle) {
    const origin = this.origin(ctx);
    const detail = this.mp.discovery.detail(handle);
    const product = this.container.resolve('catalog').products.byHandle(handle);
    const affiliate = detail.commercialModel === 'AFILIADO';
    const canonical = affiliate
      ? `${origin}/producto/${slug(product.name)}-${product.id}`
      : product.seo?.canonical || `${origin}/producto/${product.handle}`;
    const currency = detail.price.currency;
    const offer = detail.price.amount !== null && !affiliate ? {
      '@type': 'Offer',
      price: toDecimal(detail.price.amount, currency),
      priceCurrency: currency,
      availability: detail.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      url: canonical,
      seller: detail.store ? { '@type': 'Organization', name: detail.store.name } : { '@type': 'Organization', name: this.brand() },
    } : undefined;
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: detail.name,
      description: detail.description || undefined,
      image: detail.gallery.map(item => `${origin}${item.url}`),
      brand: detail.brand ? { '@type': 'Brand', name: detail.brand } : undefined,
      category: detail.categoryPath.map(node => node.name).join(' > ') || undefined,
      offers: offer,
      // Solo con reseñas reales: nunca una valoración supuesta.
      aggregateRating: detail.rating.count ? { '@type': 'AggregateRating', ratingValue: detail.rating.average, reviewCount: detail.rating.count } : undefined,
    };
    const price = detail.price.amount !== null ? formatMoney(detail.price.amount, currency) : '';
    return renderShell({
      title: `${detail.seo.title} | ${this.brand()}`,
      description: detail.seo.description,
      canonical,
      noindex: detail.seo.noindex,
      image: detail.gallery[0] ? `${origin}${detail.gallery[0].url}` : null,
      imageAlt: detail.name,
      siteName: this.brand(),
      // Compartido en Facebook o WhatsApp, el enlace muestra precio y si hay stock.
      type: 'product',
      extraMeta: [
        detail.price.amount !== null ? `<meta property="product:price:amount" content="${toDecimal(detail.price.amount, currency)}">` : '',
        detail.price.amount !== null ? `<meta property="product:price:currency" content="${escapeHtml(currency)}">` : '',
        `<meta property="product:availability" content="${detail.inStock ? 'in stock' : 'out of stock'}">`,
        detail.brand ? `<meta property="product:brand" content="${escapeHtml(detail.brand)}">` : '',
        detail.store ? `<meta property="product:retailer_title" content="${escapeHtml(detail.store.name)}">` : '',
      ].filter(Boolean),
      jsonLd,
      prerender: `<h1>${escapeHtml(detail.name)}</h1><p>${escapeHtml(price)}</p><p>${escapeHtml(truncate(detail.description || '', 400))}</p>${detail.store ? `<p>Vendido por <a href="/tienda/${escapeHtml(detail.store.code)}">${escapeHtml(detail.store.name)}</a></p>` : ''}`,
    });
  }

  storePage(ctx, code) {
    const origin = this.origin(ctx);
    const page = this.mp.discovery.storePage(code);
    const { store, reputation } = page;
    const canonical = `${origin}/tienda/${store.code}`;
    return renderShell({
      title: `${store.name} en ${this.brand()}`,
      description: store.tagline || store.description || `Productos de ${store.name}.`,
      canonical,
      image: store.logoUrl ? `${origin}${store.logoUrl}` : null,
      imageAlt: store.name,
      siteName: this.brand(),
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'Store',
        name: store.name,
        url: canonical,
        description: store.description || undefined,
        // Dirección solo a nivel de localidad y zona: la exacta es privada.
        address: { '@type': 'PostalAddress', addressLocality: store.locality || undefined, addressRegion: store.area || undefined, addressCountry: 'PY' },
        geo: store.publicLocation ? { '@type': 'GeoCoordinates', latitude: store.publicLocation.lat, longitude: store.publicLocation.lng } : undefined,
        aggregateRating: reputation.rating.count ? { '@type': 'AggregateRating', ratingValue: reputation.rating.average, reviewCount: reputation.rating.count } : undefined,
      },
      prerender: `<h1>${escapeHtml(store.name)}</h1><p>${escapeHtml(store.description || '')}</p><ul>${page.products.slice(0, 30).map(item => `<li><a href="/producto/${escapeHtml(item.handle)}">${escapeHtml(item.name)}</a></li>`).join('')}</ul>`,
    });
  }

  category(ctx, handle) {
    const origin = this.origin(ctx);
    const category = this.container.resolve('catalog').categories.repository.find({ handle, visible: true });
    if (!category) return null;
    const results = this.mp.discovery.search({ category: handle, limit: 48 });
    const canonical = `${origin}/categoria/${category.handle}`;
    return renderShell({
      title: `${category.seo?.title || category.name} | ${this.brand()}`,
      description: category.seo?.description || category.description || `${category.name}: productos de comercios y artesanos locales.`,
      canonical,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: category.name,
        numberOfItems: results.count,
        itemListElement: results.data.map((item, index) => ({ '@type': 'ListItem', position: index + 1, url: `${origin}/producto/${item.handle}`, name: item.name })),
      },
      prerender: `<h1>${escapeHtml(category.name)}</h1><ul>${results.data.map(item => `<li><a href="/producto/${escapeHtml(item.handle)}">${escapeHtml(item.name)}</a></li>`).join('')}</ul>`,
    });
  }

  /**
   * Catálogo para las tiendas de Facebook e Instagram y para Google Merchant.
   *
   * Es el mismo catálogo publicado, con los campos que esos servicios esperan.
   * Quedan fuera los productos afiliados: se compran en otro sitio y anunciarlos
   * como propios sería engañoso. La disponibilidad sale del stock real.
   */
  catalogFeed(ctx, { sellerCode = null } = {}) {
    const origin = this.origin(ctx);
    const seller = sellerCode ? this.container.resolve('channel').sellers.byCode(sellerCode) : null;
    if (sellerCode && !seller) return null;
    const currency = this.settings.get('marketplace.currencyCode', 'PYG');
    const catalog = this.container.resolve('catalog');
    return this.mp.discovery.visibleProducts()
      .filter(product => !seller || product.sellerId === seller.id)
      .map(product => this.mp.discovery.card(product))
      .filter(card => card.commercialModel !== 'AFILIADO' && card.price.amount !== null)
      .map(card => {
        const product = catalog.products.repository.byId(card.id);
        return {
          id: card.id,
          title: card.name,
          description: truncate(String(product?.description || card.subtitle || card.name), 500),
          availability: card.inStock ? 'in stock' : 'out of stock',
          condition: 'new',
          price: `${toDecimal(card.price.amount, card.price.currency || currency)} ${card.price.currency || currency}`,
          sale_price: card.price.compareAt ? `${toDecimal(card.price.amount, card.price.currency || currency)} ${card.price.currency || currency}` : '',
          link: `${origin}/producto/${card.handle}`,
          image_link: card.image ? `${origin}${card.image}` : '',
          brand: product?.brand || card.seller?.name || this.brand(),
          google_product_category: '',
          product_type: this.mp.discovery.categoryPath(product?.categoryId).map(node => node.name).join(' > '),
        };
      });
  }

  /** Mismo catálogo en el RSS que leen Google Merchant y Facebook. */
  catalogFeedXml(ctx, options = {}) {
    const rows = this.catalogFeed(ctx, options);
    if (!rows) return null;
    const items = rows.map(item => `<item>
      <g:id>${escapeHtml(item.id)}</g:id>
      <g:title>${escapeHtml(item.title)}</g:title>
      <g:description>${escapeHtml(item.description)}</g:description>
      <g:link>${escapeHtml(item.link)}</g:link>
      ${item.image_link ? `<g:image_link>${escapeHtml(item.image_link)}</g:image_link>` : ''}
      <g:availability>${escapeHtml(item.availability)}</g:availability>
      <g:condition>${escapeHtml(item.condition)}</g:condition>
      <g:price>${escapeHtml(item.price)}</g:price>
      <g:brand>${escapeHtml(item.brand)}</g:brand>
      ${item.product_type ? `<g:product_type>${escapeHtml(item.product_type)}</g:product_type>` : ''}
    </item>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>`
      + `<title>${escapeHtml(this.brand())}</title><link>${escapeHtml(this.origin(ctx))}</link>`
      + `<description>${escapeHtml(this.settings.get('marketplace.tagline', ''))}</description>${items}</channel></rss>`;
  }

  /** Entradas del sitemap del marketplace (los afiliados ya están con su URL editorial). */
  sitemapEntries(ctx) {
    const origin = this.origin(ctx);
    const entries = [];
    for (const product of this.mp.discovery.visibleProducts()) {
      if (product.commercialModel === 'AFILIADO' || product.seo?.noindex) continue;
      entries.push({ loc: `${origin}/producto/${product.handle}`, lastmod: product.updatedAt, priority: '0.8' });
    }
    for (const seller of this.container.resolve('channel').sellers.active()) {
      entries.push({ loc: `${origin}/tienda/${seller.code}`, lastmod: seller.updatedAt, priority: '0.7' });
    }
    for (const node of this.mp.discovery.categoryTree()) {
      const visit = item => {
        if (item.productCount) entries.push({ loc: `${origin}/categoria/${item.handle}`, lastmod: null, priority: '0.6' });
        (item.children || []).forEach(visit);
      };
      visit(node);
    }
    return entries;
  }
}

/** Rutas de la SPA: indexables con metadatos, o privadas con `noindex`. */
export function marketplaceSeoRoutes(container, config) {
  const seo = new MarketplaceSeo({ container, config });
  const html = (ctx, body, status = 200, maxAge = 60) => respond.html(ctx.res, status, body, { 'Cache-Control': `public, max-age=${maxAge}` });
  const notFound = (ctx, what) => respond.html(ctx.res, 404, renderShell({ title: `${what} no encontrada | ${seo.brand()}`, noindex: true }), { 'Cache-Control': 'no-store' });
  const publicPages = [
    ['/buscar', 'Buscar', true],
    ['/ofertas', 'Ofertas', false],
    ['/tiendas', 'Tiendas', false],
    ['/explorar', 'Explorar el mapa', false],
    ['/comunidad', 'Comunidad', false],
    ['/vender', 'Quiero vender', false],
  ];
  const privatePrefixes = ['/carrito', '/checkout', '/cuenta', '/mi-tienda', '/admin', '/ingresar'];
  const routes = [
    { method: 'GET', path: '/', permission: null, bodyless: true, tags: ['seo'], summary: 'Portada del marketplace.', handler: ctx => html(ctx, seo.home(ctx)) },
    {
      method: 'GET', path: '/tienda/:code', permission: null, bodyless: true, tags: ['seo'], summary: 'Página pública de una tienda.',
      handler: ctx => {
        try { return html(ctx, seo.storePage(ctx, ctx.params.code), 200, 120); } catch { return notFound(ctx, 'Tienda'); }
      },
    },
    {
      method: 'GET', path: '/feeds/catalogo.csv', permission: null, bodyless: true, tags: ['seo'],
      query: { tienda: { type: 'string', maxLength: 120 } },
      summary: 'Catálogo en CSV para las tiendas de Facebook e Instagram; con ?tienda=<código>, solo esa tienda.',
      handler: ctx => {
        const rows = seo.catalogFeed(ctx, { sellerCode: ctx.query.tienda || null });
        if (!rows) return respond.text(ctx.res, 404, 'Tienda no encontrada', { 'Cache-Control': 'no-store' });
        const header = Object.keys(rows[0] || {
          id: '', title: '', description: '', availability: '', condition: '', price: '', sale_price: '',
          link: '', image_link: '', brand: '', google_product_category: '', product_type: '',
        });
        const csv = [csvRow(header), ...rows.map(row => csvRow(header.map(key => row[key])))].join('\r\n');
        return respond.text(ctx.res, 200, csv, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Cache-Control': 'public, max-age=1800',
        });
      },
    },
    {
      method: 'GET', path: '/feeds/catalogo.xml', permission: null, bodyless: true, tags: ['seo'],
      query: { tienda: { type: 'string', maxLength: 120 } },
      summary: 'Catálogo en RSS para Google Merchant y Facebook; con ?tienda=<código>, solo esa tienda.',
      handler: ctx => {
        const body = seo.catalogFeedXml(ctx, { sellerCode: ctx.query.tienda || null });
        return body
          ? respond.xml(ctx.res, 200, body, { 'Cache-Control': 'public, max-age=1800' })
          : respond.text(ctx.res, 404, 'Tienda no encontrada', { 'Cache-Control': 'no-store' });
      },
    },
    {
      method: 'GET', path: '/categoria/:handle', permission: null, bodyless: true, tags: ['seo'], summary: 'Página de categoría.',
      handler: ctx => {
        const body = seo.category(ctx, ctx.params.handle);
        return body ? html(ctx, body, 200, 120) : notFound(ctx, 'Categoría');
      },
    },
  ];
  for (const [path, title, noindex] of publicPages) {
    routes.push({
      method: 'GET', path, permission: null, bodyless: true, tags: ['seo'], summary: `Página ${title}.`,
      handler: ctx => html(ctx, renderShell({ title: `${title} | ${seo.brand()}`, description: seo.settings.get('marketplace.tagline', ''), canonical: `${seo.origin(ctx)}${path}`, noindex })),
    });
  }
  for (const prefix of privatePrefixes) {
    for (const path of [prefix, `${prefix}/*`]) {
      routes.push({
        method: 'GET', path, permission: null, bodyless: true, tags: ['seo'], summary: `Vista privada de la SPA (${prefix}).`,
        handler: ctx => respond.html(ctx.res, 200, renderShell({ title: seo.brand(), noindex: true }), { 'Cache-Control': 'no-store' }),
      });
    }
  }
  return { routes, seo };
}
