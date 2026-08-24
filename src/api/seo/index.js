/**
 * Páginas SEO renderizadas en el servidor (M-0156 … M-0158, M-0406, M-0407).
 *
 * Ficha de producto, página de campaña, guía editorial, `sitemap.xml` y `robots.txt`.
 * Todo lo interpolado pasa por `escapeHtml`, y el JSON-LD por `escapeJsonLd`: la
 * descripción de un producto es contenido de usuario y no puede cerrar la etiqueta.
 */
import { escapeHtml, escapeJsonLd, escapeXml, slug, truncate } from '../../framework/strings.js';
import { format as formatMoney } from '../../framework/money.js';
import { ageInDays, now } from '../../framework/dates.js';
import * as respond from '../../framework/http/respond.js';

const BASE_STYLE = `
:root{--bg:#f6f8fc;--fg:#15213a;--muted:#62708a;--line:#e5e9f0;--card:#fff;--accent:#6457e9;--shadow:0 14px 34px #17233b12}
@media(prefers-color-scheme:dark){:root{--bg:#0f1424;--fg:#e8ecf6;--muted:#97a3bd;--line:#232c45;--card:#161d33;--shadow:0 14px 34px #0006}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 Inter,system-ui,-apple-system,sans-serif}
.wrap{width:min(1080px,calc(100% - 40px));margin:0 auto}
.skip{position:absolute;left:-9999px}.skip:focus{left:16px;top:16px;background:var(--card);padding:10px 14px;border-radius:8px;z-index:10}
a{color:var(--accent)}
.nav{display:flex;align-items:center;justify-content:space-between;padding:22px 0;gap:16px;flex-wrap:wrap}
.brand{color:var(--fg);text-decoration:none;font-size:1.45rem;font-weight:850;letter-spacing:-.05em}
.brand i{color:var(--accent);font-style:normal}
.nav a.link{color:var(--muted);text-decoration:none;font-size:.88rem;font-weight:600}
.nav a.link:hover{color:var(--accent)}
.crumb{display:inline-block;margin-bottom:14px;font-size:.82rem;color:var(--muted);text-decoration:none}
.eyebrow{color:var(--accent);font-size:.72rem;letter-spacing:.12em;font-weight:850;text-transform:uppercase}
h1{font-size:clamp(1.9rem,4.5vw,3.1rem);line-height:1.05;letter-spacing:-.05em;margin:10px 0 14px}
.tag{display:inline-block;padding:4px 9px;border-radius:99px;background:#e8eafe;color:#4538c1;font-size:.74rem;font-weight:800}
@media(prefers-color-scheme:dark){.tag{background:#26224d;color:#c3bcff}}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px;box-shadow:var(--shadow)}
.split{display:grid;grid-template-columns:280px 1fr;gap:34px;align-items:start}
.visual{min-height:250px;display:grid;place-items:center;border-radius:16px;background:linear-gradient(145deg,#ebe9ff,#e5f7f0);font-size:5rem}
.price{font-size:1.75rem;font-weight:850;letter-spacing:-.04em;margin:22px 0 6px}
.price small{display:block;font-size:.78rem;font-weight:600;color:var(--muted);letter-spacing:0}
.was{color:var(--muted);text-decoration:line-through;font-size:1rem;font-weight:600;margin-left:8px}
.button{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;border-radius:10px;padding:13px 18px;font-weight:800}
.button:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.unavailable{font-weight:750;color:#a45f00}
.notice{margin:22px 0 0;padding:13px 15px;border-left:3px solid var(--accent);background:#f2f1ff;color:#4b5370;font-size:.85rem;border-radius:0 8px 8px 0}
@media(prefers-color-scheme:dark){.notice{background:#1c2038;color:#b9c2d8}}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px;padding-bottom:56px}
.grid article{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px}
.grid .icon{height:140px;display:grid;place-items:center;background:linear-gradient(145deg,#ebe9ff,#e5f7f0);border-radius:11px;font-size:3.4rem}
.grid h2{font-size:1.1rem;letter-spacing:-.03em;margin:10px 0 6px}
.grid p{color:var(--muted);font-size:.87rem;min-height:56px}
table{width:100%;border-collapse:collapse;font-size:.88rem}
th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:left}
th{font-weight:800;font-size:.76rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.scroll{overflow-x:auto}
footer{padding:34px 0;color:var(--muted);font-size:.82rem;border-top:1px solid var(--line);margin-top:40px}
@media(max-width:720px){.split{grid-template-columns:1fr;gap:20px}.visual{min-height:150px}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

function page({ title, description, canonical, body, structuredData = null, noindex = false, socialImage = null }) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description || '')}">
${noindex ? '<meta name="robots" content="noindex">' : ''}
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description || '')}">
<meta property="og:url" content="${escapeHtml(canonical)}">
${socialImage ? `<meta property="og:image" content="${escapeHtml(socialImage)}">` : ''}
<meta name="twitter:card" content="summary">
${structuredData ? `<script type="application/ld+json">${escapeJsonLd(structuredData)}</script>` : ''}
<style>${BASE_STYLE}</style></head>
<body><a class="skip" href="#contenido">Ir al contenido principal</a>
<div class="wrap">
<nav class="nav"><a class="brand" href="/">Ndi<i>vepa</i></a>
<span><a class="link" href="/guias.html">Guías</a> · <a class="link" href="/privacidad.html">Privacidad</a></span></nav>
<main id="contenido">${body}</main>
<footer>Ndivepa presenta ofertas de terceros y deriva al comercio. No procesa el pago del cliente ni gestiona envíos de las ofertas afiliadas.</footer>
</div></body></html>`;
}

export function productPath(product) {
  return `/producto/${slug(product.name)}-${product.id}`;
}

export class SeoRenderer {
  constructor({ container, config }) {
    this.container = container;
    this.config = config;
  }

  get catalog() { return this.container.resolve('catalog'); }
  get affiliate() { return this.container.resolve('affiliate'); }
  get settings() { return this.container.resolve('settings').settings; }
  get content() { return this.container.resolve('content'); }

  origin(ctx) {
    if (this.config.publicBaseUrl) return this.config.publicBaseUrl;
    const protocol = ctx.req.socket?.encrypted ? 'https' : 'http';
    return `${protocol}://${ctx.req.headers.host || `localhost:${this.config.port}`}`;
  }

  /** Ficha de producto indexable con JSON-LD `Product`/`Offer`. */
  renderProduct(ctx, product) {
    const origin = this.origin(ctx);
    const canonical = product.seo?.canonical || `${origin}${productPath(product)}`;
    const settings = this.settings.all();
    const category = product.categoryId ? this.catalog.categories.repository.byId(product.categoryId) : null;
    const merchant = product.merchantId ? this.affiliate.merchants.repository.byId(product.merchantId) : null;
    const link = this.affiliate.links.bestFor(product.id);

    const currency = product.price?.currency || settings.defaultCurrency || 'USD';
    const amount = product.price?.amount;
    const hasPrice = Number.isFinite(Number(amount));
    const priceAge = ageInDays(product.price?.updatedAt);
    const staleDays = settings.affiliate?.priceStaleDays ?? 30;
    const priceStale = priceAge !== null && priceAge > staleDays;

    const offer = hasPrice && !priceStale
      ? {
        '@type': 'Offer',
        price: Number(amount) / 10 ** (currency === 'PYG' ? 0 : 2),
        priceCurrency: currency,
        availability: 'https://schema.org/InStock',
        url: link?.affiliateUrl || canonical,
        seller: merchant ? { '@type': 'Organization', name: merchant.name } : undefined,
      }
      : undefined;

    const structuredData = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: product.name,
      description: product.description || undefined,
      category: category?.name || undefined,
      brand: product.brand ? { '@type': 'Brand', name: product.brand } : undefined,
      image: typeof product.image === 'string' && product.image.startsWith('http') ? product.image : undefined,
      offers: offer,
    };

    const priceBlock = hasPrice
      ? `<div class="price">${escapeHtml(formatMoney(amount, currency))}
${product.price?.previousAmount ? `<span class="was">${escapeHtml(formatMoney(product.price.previousAmount, currency))}</span>` : ''}
<small>${priceStale
        ? `Precio registrado hace ${priceAge} días; no está verificado hoy. Consúltalo en el comercio.`
        : `Precio verificado el ${escapeHtml(String(product.price.updatedAt || '').slice(0, 10))} en ${escapeHtml(merchant?.name || 'el comercio')}.`}</small></div>`
      : '<div class="price">Consultar precio<small>El precio lo publica el comercio externo.</small></div>';

    const button = link?.id && link.status !== 'invalid'
      ? `<a class="button" href="/go/${encodeURIComponent(link.id)}?placement=plc-product-page&amp;source=organic&amp;consent=1" rel="sponsored nofollow noopener" target="_blank">Ver oferta en ${escapeHtml(merchant?.name || 'el proveedor')} ↗</a>`
      : '<span class="unavailable">Oferta no disponible temporalmente</span>';

    const comparison = this.affiliate.links.compare(product.id);
    const comparisonBlock = comparison.visible
      ? `<h2 style="font-size:1.05rem;margin:28px 0 10px">Precio por comercio</h2><div class="scroll"><table>
<caption class="crumb" style="text-align:left">Solo se listan precios verificados en los últimos ${staleDays} días.</caption>
<thead><tr><th scope="col">Comercio</th><th scope="col">Precio</th><th scope="col">Verificado</th></tr></thead><tbody>
${comparison.rows.filter(row => row.verified).map(row => `<tr><td>${escapeHtml(row.merchantName || 'Comercio')}</td><td>${escapeHtml(formatMoney(row.amount, row.currency || currency))}</td><td>hace ${row.ageDays} día(s)</td></tr>`).join('')}
</tbody></table></div>`
      : '';

    const body = `<a class="crumb" href="/">← Volver a recomendaciones</a>
<article class="card split">
<div class="visual" aria-hidden="true">${escapeHtml(typeof product.image === 'string' && !product.image.startsWith('http') ? product.image : '🔗')}</div>
<div>
<span class="eyebrow">Recomendación Ndivepa</span>
<div class="tag">${escapeHtml(category?.name || 'Recomendación')}</div>
<h1>${escapeHtml(product.name)}</h1>
<p style="color:var(--muted);margin:0">Vendido y gestionado por ${escapeHtml(merchant?.name || 'el proveedor externo')}</p>
<p>${escapeHtml(product.description || '')}</p>
${priceBlock}
${button}
${comparisonBlock}
<p class="notice"><strong>Divulgación afiliada:</strong> ${escapeHtml(settings.affiliateDisclosure)}</p>
</div></article>`;

    return page({
      title: `${product.name}${settings.seo?.titleSuffix || ' | Ndivepa'}`,
      description: product.seo?.description || truncate(product.description || `Recomendación de ${product.name} en Ndivepa`, 160),
      canonical,
      body,
      structuredData,
      noindex: Boolean(product.seo?.noindex),
      socialImage: product.seo?.socialImage || null,
    });
  }

  renderCampaign(ctx, campaign, products) {
    const origin = this.origin(ctx);
    const cards = products.length
      ? products.map(product => `<article>
<div class="icon" aria-hidden="true">${escapeHtml(typeof product.image === 'string' && !product.image.startsWith('http') ? product.image : '🔗')}</div>
<span class="eyebrow">${escapeHtml(this.catalog.categories.repository.byId(product.categoryId)?.name || 'Recomendación')}</span>
<h2>${escapeHtml(product.name)}</h2>
<p>${escapeHtml(truncate(product.description || '', 120))}</p>
<a href="${escapeHtml(productPath(product))}">Ver recomendación →</a></article>`).join('')
      : '<p>No hay recomendaciones publicadas para esta campaña.</p>';

    const body = `<section style="padding:36px 0">
<span class="eyebrow">Campaña ${escapeHtml(campaign.code || '')}</span>
<h1>${escapeHtml(campaign.name)}</h1>
<p style="color:var(--muted);max-width:620px">${escapeHtml(campaign.objective || 'Recomendaciones seleccionadas para esta campaña. Las compras se realizan directamente con cada proveedor.')}</p>
</section><section class="grid">${cards}</section>`;

    return page({
      title: `${campaign.name} | Ndivepa`,
      description: `Recomendaciones de la campaña ${campaign.name} en Ndivepa.`,
      canonical: `${origin}/campana/${encodeURIComponent(campaign.code)}`,
      body,
      structuredData: {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: campaign.name,
        numberOfItems: products.length,
        itemListElement: products.map((product, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          url: `${origin}${productPath(product)}`,
          name: product.name,
        })),
      },
    });
  }

  renderContent(ctx, content) {
    const origin = this.origin(ctx);
    const view = this.content.publicView(content);
    const canonical = view.seo?.canonical || `${origin}/contenido/${encodeURIComponent(view.handle)}`;

    const productCards = view.products.map(product => `<article>
<div class="icon" aria-hidden="true">${escapeHtml(typeof product.image === 'string' && !product.image.startsWith('http') ? product.image : '🔗')}</div>
<h2>${escapeHtml(product.name)}</h2>
<p>${escapeHtml(truncate(product.subtitle || '', 110))}</p>
<a href="/producto/${escapeHtml(slug(product.name))}-${escapeHtml(product.id)}">Ver ficha →</a></article>`).join('');

    const comparisonTable = view.type === 'comparison' && view.comparisonCriteria.length
      ? `<div class="scroll"><table><thead><tr><th scope="col">Criterio</th>
${view.products.map(product => `<th scope="col">${escapeHtml(product.name)}</th>`).join('')}</tr></thead><tbody>
${view.comparisonCriteria.map(criterion => `<tr><th scope="row">${escapeHtml(criterion.label)}</th>
${view.products.map(product => `<td>${escapeHtml(String(view.comparisonValues[product.id]?.[criterion.key] ?? '—'))}</td>`).join('')}</tr>`).join('')}
</tbody></table></div>`
      : '';

    const body = `<section style="padding:32px 0">
<span class="eyebrow">${escapeHtml(view.type === 'comparison' ? 'Comparativa' : 'Guía editorial')}</span>
<h1>${escapeHtml(view.title)}</h1>
<p style="color:var(--muted);max-width:680px">${escapeHtml(view.excerpt || '')}</p>
${view.author ? `<p class="crumb">Por ${escapeHtml(view.author)} · revisado el ${escapeHtml(String(view.reviewedAt || '').slice(0, 10))}</p>` : ''}
${view.outdated ? `<p class="notice">${escapeHtml(view.outdatedNote)}</p>` : ''}
</section>
<article class="card">${view.body ? `<p>${escapeHtml(view.body).replace(/\n\n/g, '</p><p>')}</p>` : ''}${comparisonTable}</article>
${productCards ? `<h2 style="font-size:1.1rem;margin:30px 0 12px">Productos mencionados</h2><section class="grid">${productCards}</section>` : ''}
${view.affiliateDisclosure ? `<p class="notice"><strong>Divulgación afiliada:</strong> ${escapeHtml(view.affiliateDisclosure)}</p>` : ''}`;

    return page({
      title: `${view.title} | Ndivepa`,
      description: view.seo?.description || truncate(view.excerpt || view.title, 160),
      canonical,
      body,
      structuredData: {
        '@context': 'https://schema.org',
        '@type': view.type === 'comparison' ? 'ItemList' : 'Article',
        headline: view.title,
        datePublished: view.publishedAt || undefined,
        author: view.author ? { '@type': 'Person', name: view.author } : undefined,
      },
      noindex: Boolean(view.seo?.noindex),
    });
  }

  notFoundPage(what) {
    return page({
      title: `${what} no encontrada | Ndivepa`,
      description: '',
      canonical: '/',
      noindex: true,
      body: `<section style="padding:60px 0"><h1>${escapeHtml(what)} no encontrada</h1>
<p style="color:var(--muted)">Es posible que ya no esté publicada.</p><p><a href="/">Volver a Ndivepa</a></p></section>`,
    });
  }

  sitemap(ctx) {
    const origin = this.origin(ctx);
    const entries = [{ loc: `${origin}/`, lastmod: null, priority: '1.0' }];

    for (const product of this.catalog.products.published()) {
      if (product.seo?.noindex) continue;
      entries.push({
        loc: `${origin}${productPath(product)}`,
        lastmod: product.price?.updatedAt || product.updatedAt || product.createdAt,
        priority: '0.8',
      });
    }
    for (const campaign of this.affiliate.campaigns.repository.all({ status: 'active' })) {
      if (!campaign.code) continue;
      entries.push({ loc: `${origin}/campana/${encodeURIComponent(campaign.code)}`, lastmod: campaign.updatedAt, priority: '0.6' });
    }
    for (const content of this.content.published()) {
      if (content.seo?.noindex) continue;
      entries.push({ loc: `${origin}/contenido/${encodeURIComponent(content.handle)}`, lastmod: content.updatedAt, priority: '0.7' });
    }

    const urls = entries.map(entry => `<url><loc>${escapeXml(entry.loc)}</loc>`
      + (entry.lastmod ? `<lastmod>${escapeXml(entry.lastmod)}</lastmod>` : '')
      + `<priority>${entry.priority}</priority></url>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
  }

  robots(ctx) {
    const origin = this.origin(ctx);
    const indexable = this.settings.get('seo.robotsIndex', true);
    if (!indexable) return `User-agent: *\nDisallow: /\n`;
    return [
      'User-agent: *',
      'Allow: /',
      'Disallow: /api/',
      'Disallow: /go/',
      'Disallow: /uploads/',
      `Sitemap: ${origin}/sitemap.xml`,
      '',
    ].join('\n');
  }
}

/** Rutas SEO, registradas sin prefijo. */
export function seoRoutes(container, config) {
  const renderer = new SeoRenderer({ container, config });

  return [
    {
      method: 'GET',
      path: '/sitemap.xml',
      permission: null,
      bodyless: true,
      summary: 'Sitemap XML dinámico con fichas, campañas y contenido.',
      tags: ['seo'],
      handler: ctx => respond.xml(ctx.res, 200, renderer.sitemap(ctx), { 'Cache-Control': 'public, max-age=600' }),
    },
    {
      method: 'GET',
      path: '/robots.txt',
      permission: null,
      bodyless: true,
      summary: 'robots.txt dinámico con el sitemap.',
      tags: ['seo'],
      handler: ctx => respond.text(ctx.res, 200, renderer.robots(ctx), { 'Cache-Control': 'public, max-age=600' }),
    },
    {
      method: 'GET',
      path: '/producto/:route',
      permission: null,
      bodyless: true,
      summary: 'Ficha pública indexable de un producto.',
      tags: ['seo'],
      handler: ctx => {
        const route = ctx.params.route;
        const catalog = container.resolve('catalog');
        const product = catalog.products.published().find(item => route === `${slug(item.name)}-${item.id}`);
        if (!product) return respond.html(ctx.res, 404, renderer.notFoundPage('Oferta'));
        return respond.html(ctx.res, 200, renderer.renderProduct(ctx, product), { 'Cache-Control': 'public, max-age=120' });
      },
    },
    {
      method: 'GET',
      path: '/campana/:code',
      permission: null,
      bodyless: true,
      summary: 'Página pública de una campaña activa.',
      tags: ['seo'],
      handler: ctx => {
        const affiliate = container.resolve('affiliate');
        const catalog = container.resolve('catalog');
        const code = String(ctx.params.code || '').toLowerCase();
        const campaign = affiliate.campaigns.repository
          .all({ status: 'active' })
          .find(item => String(item.code || '').toLowerCase() === code);
        if (!campaign) return respond.html(ctx.res, 404, renderer.notFoundPage('Campaña'));
        const products = catalog.products.published().filter(product => product.campaignId === campaign.id);
        return respond.html(ctx.res, 200, renderer.renderCampaign(ctx, campaign, products), { 'Cache-Control': 'public, max-age=120' });
      },
    },
    {
      method: 'GET',
      path: '/contenido/:handle',
      permission: null,
      bodyless: true,
      summary: 'Guía o comparativa editorial publicada.',
      tags: ['seo'],
      handler: ctx => {
        const content = container.resolve('content').byHandle(ctx.params.handle);
        if (!content || content.status !== 'published') return respond.html(ctx.res, 404, renderer.notFoundPage('Página'));
        return respond.html(ctx.res, 200, renderer.renderContent(ctx, content), { 'Cache-Control': 'public, max-age=180' });
      },
    },
    {
      method: 'GET',
      path: '/api/health',
      permission: null,
      bodyless: true,
      summary: 'Estado del almacenamiento, la cola y los módulos.',
      tags: ['operación'],
      handler: () => {
        const store = container.resolve('store');
        const jobs = container.resolve('jobs');
        return {
          status: 'ok',
          checkedAt: now(),
          schemaVersion: store.read().schemaVersion,
          storage: store.describe(),
          jobs: jobs.catalog().byStatus,
        };
      },
    },
  ];
}
