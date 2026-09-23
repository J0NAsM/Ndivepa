/** Vistas públicas: descubrir, buscar, ver producto y tienda, explorar y comunidad. */
import {
  $, $$, addToCart, ago, api, bindForm, date, esc, localities, money, modal, navigate, query, rememberViewed,
  requireLogin, setLocality, setQuery, state, storage, toast, trackView,
} from '../core.js';
import {
  avatar, CATEGORY_ICONS, DELIVERY_LABELS, empty, flattenCategories, formError, icon, loading, media, mountTabs,
  productCard, rail, section, stars, storeCard, storeType,
} from '../ui.js';

const grid = (items, options) => (items?.length ? `<div class="grid">${items.map(item => productCard(item, options)).join('')}</div>` : '');

async function sponsored(placement, params = {}) {
  try {
    const search = new URLSearchParams({ placement, ...params });
    const result = await api(`/marketplace/sponsored?${search}`);
    if (!result.data.length) return '';
    api('/marketplace/sponsored/events', {
      method: 'POST', body: { type: 'impression', campaignIds: result.data.map(ad => ad.id), placement, sessionId: state.visitor, consent: state.consent === 'granted' },
    }).catch(() => {});
    return `<aside class="sponsored-block" aria-label="Contenido patrocinado">
      <div class="split"><span class="sponsored-tag">Patrocinado</span><span class="muted small">Separado de los resultados</span></div>
      <div class="rail" style="margin-top:8px">${result.data.map(ad => `<div data-ad="${esc(ad.id)}">${ad.product ? productCard(ad.product) : ad.store ? storeCard(ad.store) : `<a class="card" href="${esc(ad.linkPath)}"><strong>${esc(ad.title)}</strong><p class="small muted">${esc(ad.body || '')}</p></a>`}</div>`).join('')}</div>
    </aside>`;
  } catch {
    return '';
  }
}

/** Clic en un anuncio: se registra antes de navegar. */
document.addEventListener('click', event => {
  const ad = event.target.closest('[data-ad]');
  if (!ad) return;
  api('/marketplace/sponsored/events', { method: 'POST', body: { type: 'click', campaignIds: [ad.dataset.ad], sessionId: state.visitor, consent: state.consent === 'granted' } }).catch(() => {});
}, true);

// --- Portada ------------------------------------------------------------------------

export async function home() {
  const [data, ads, feed] = await Promise.all([
    api('/marketplace/home'),
    sponsored('home'),
    api('/community/feed?limit=4').catch(() => ({ data: [] })),
  ]);
  const viewedIds = storage.get('ndv-viewed', []);
  const viewed = viewedIds.length ? (await api('/marketplace/products/cards', { method: 'POST', body: { ids: viewedIds } }).catch(() => ({ data: [] }))).data : [];
  const locality = data.marketplace.locality;
  return {
    title: null,
    html: `<div class="wrap page">
      <section class="hero">
        <h1>${esc(locality ? `Lo mejor de ${locality}, en un solo lugar` : data.marketplace.name)}</h1>
        <p>${esc(data.marketplace.tagline)}</p>
        <form role="search" data-search-form>
          <input type="search" name="q" placeholder="Buscá hamacas, chipa, ropa, servicios…" aria-label="Buscar productos" autocomplete="off">
          <button class="btn accent" type="submit">${icon('search')}<span class="sr-only">Buscar</span></button>
        </form>
        <div class="stats"><span><strong>${data.counts.products}</strong> productos</span><span><strong>${data.counts.stores}</strong> tiendas locales</span>${data.counts.deliveredOrders > 0 ? `<span><strong>${data.counts.deliveredOrders}</strong> pedidos entregados</span>` : ''}${data.counts.rating ? `<span><strong>${data.counts.rating.average}★</strong> en ${data.counts.rating.count} reseñas</span>` : ''}<a href="/explorar" style="color:#fff">${icon('map')} Explorar el mapa</a></div>
      </section>
      ${howItWorks()}
      ${section('Categorías', `<div class="cat-grid">${data.categories.slice(0, 16).map(category => `<a class="cat-tile" href="/categoria/${esc(category.handle)}"><span class="ico" aria-hidden="true">${CATEGORY_ICONS[category.handle] || '🛍️'}</span>${esc(category.name)}</a>`).join('')}<a class="cat-tile" href="/ofertas"><span class="ico" aria-hidden="true">🏷️</span>Ofertas</a></div>`)}
      ${section('Ofertas', rail(data.offers, item => productCard(item)), { link: '/ofertas' })}
      ${ads ? `<div class="section">${ads}</div>` : ''}
      ${section('Populares', rail(data.popular, item => productCard(item)), { link: '/buscar?sort=popularity' })}
      ${section('Tiendas locales', rail(data.stores, storeCard), { link: '/tiendas' })}
      ${section('Nuevos vendedores', rail(data.newStores, storeCard), { link: '/tiendas?sort=newest' })}
      ${section(`Artesanía${locality ? ` de ${locality}` : ''}`, rail(data.artisans, item => productCard(item)), { link: '/categoria/artesania' })}
      ${section('Recomendados para vos', rail(data.recommended, item => productCard(item)))}
      ${viewed.length ? section('Vistos recientemente', rail(viewed, item => productCard(item))) : ''}
      ${feed.data.length ? section('En la comunidad', `<div class="feed">${feed.data.slice(0, 3).map(feedItem).join('')}</div>`, { link: '/comunidad' }) : ''}
      <section class="section cta-band">
        <div><h2>¿Tenés un comercio, un taller o un emprendimiento?</h2><p class="muted" style="margin:0">Abrí tu tienda en minutos, llegá a toda la comunidad y gestioná tus pedidos desde el celular.</p></div>
        <a class="btn accent" href="/vender">Quiero vender</a>
      </section>
    </div>`,
  };
}

/**
 * Cómo funciona comprar aquí. Quien entra por primera vez a un sitio que no
 * conoce necesita saber cómo paga, cómo recibe y qué pasa si algo sale mal,
 * antes de mirar precios.
 */
function howItWorks() {
  const trust = state.config?.trust;
  if (!trust) return '';
  const steps = [
    ['1. Elegí', 'Productos de tiendas de tu ciudad, con su valoración real y su tiempo de entrega.'],
    ['2. Pagá', trust.paymentMethods?.length ? `Con ${trust.paymentMethods.map(method => method.name).join(', ').toLowerCase()}. No guardamos datos de tarjetas.` : 'Con los medios que acepta cada tienda. No guardamos datos de tarjetas.'],
    ['3. Recibí', 'Retirás en la tienda o te lo llevan. Seguís cada pedido desde tu cuenta.'],
    ['4. Si algo falla', trust.returnWindowDays ? `Tenés ${trust.returnWindowDays} días para pedir la devolución desde tu pedido.` : 'Pedís la devolución desde tu pedido y la tienda responde.'],
  ];
  return `<section class="section how-works" aria-label="Cómo comprar en Ndivepa">
    ${steps.map(([title, body]) => `<div class="card"><strong>${esc(title)}</strong><p class="small muted" style="margin:4px 0 0">${esc(body)}</p></div>`).join('')}
  </section>`;
}

const FILTER_LABELS = {
  delivery: 'Entrega', minPrice: 'Desde', maxPrice: 'Hasta', inStock: 'Solo disponibles',
  onSale: 'En oferta', minRating: 'Valoración', seller: 'Tienda',
};

/**
 * Filtros activos a la vista y con salida en un clic. Un filtro olvidado deja
 * al comprador creyendo que no hay nada y lo manda a otro sitio.
 */
function activeFilters(filters) {
  const chips = Object.entries(filters)
    .filter(([key, value]) => value && FILTER_LABELS[key])
    .map(([key, value]) => {
      const label = key === 'inStock' || key === 'onSale'
        ? FILTER_LABELS[key]
        : `${FILTER_LABELS[key]}: ${key === 'delivery' ? String(value).split(',').map(mode => DELIVERY_LABELS[mode] || mode).join(', ') : value}${key === 'minRating' ? '★ o más' : ''}`;
      return `<button class="chip" data-clear-filter="${esc(key)}">${esc(label)} ✕</button>`;
    });
  if (!chips.length) return '';
  return `<div class="chips" style="margin:0 0 12px">${chips.join('')}<button class="chip" data-clear-filter="all">Limpiar todo</button></div>`;
}

// --- Búsqueda y categorías -------------------------------------------------------------

const SORTS =[['relevance', 'Relevancia'], ['popularity', 'Más vendidos'], ['newest', 'Novedades'], ['price_asc', 'Menor precio'], ['price_desc', 'Mayor precio'], ['rating', 'Mejor valorados']];

export async function search({ category = null } = {}) {
  const params = query();
  const filters = {
    q: params.q || '', sort: params.sort || '', delivery: params.delivery || '', minPrice: params.minPrice || '', maxPrice: params.maxPrice || '',
    inStock: params.inStock || '', onSale: params.onSale || '', seller: params.seller || '', minRating: params.minRating || '',
    offset: params.offset || '',
  };
  const apiParams = new URLSearchParams(Object.fromEntries(Object.entries({ ...filters, category: category || params.category || '', limit: 24 }).filter(([, value]) => value !== '')));
  if (state.consent === 'granted' && filters.q) { apiParams.set('consent', 'true'); apiParams.set('sid', state.visitor); }
  const [results, categories, ads] = await Promise.all([
    api(`/marketplace/search?${apiParams}`),
    api('/marketplace/categories'),
    sponsored(category ? 'category' : 'search', category ? { category } : filters.q ? { q: filters.q } : {}),
  ]);
  const flat = flattenCategories(categories.tree);
  const current = category ? categories.tree.flatMap(node => [node, ...(node.children || [])]).find(node => node.handle === category) : null;
  const title = current ? current.name : filters.q ? `Resultados para «${filters.q}»` : 'Todos los productos';
  const deliveryOn = new Set(filters.delivery ? filters.delivery.split(',') : []);
  const page = Number(filters.offset || 0);
  return {
    title,
    html: `<div class="wrap page">
      <nav class="breadcrumb" aria-label="Ruta"><a href="/">Inicio</a> › ${current ? `<a href="/buscar">Productos</a> › <span>${esc(current.name)}</span>` : '<span>Buscar</span>'}</nav>
      <div class="split"><h1>${esc(title)}</h1><span class="muted small">${results.count} resultado(s)</span></div>
      ${activeFilters(filters)}
      ${results.corrected?.length ? `<p class="notice">Mostramos resultados para <strong>${esc(correctedQuery(filters.q, results.corrected))}</strong> (buscaste «${esc(filters.q)}»).</p>` : ''}
      ${current?.children?.length ? `<div class="chips" style="margin:8px 0 12px">${current.children.map(child => `<a class="chip" href="/categoria/${esc(child.handle)}">${esc(child.name)} <span class="muted">${child.productCount}</span></a>`).join('')}</div>` : ''}
      <div class="search-layout">
        <aside class="filters card" id="filters" aria-label="Filtros">
          <form data-filters>
            ${category ? '' : `<div class="group"><label>Categoría<select name="category"><option value="">Todas</option>${flat.map(item => `<option value="${esc(item.handle)}" ${params.category === item.handle ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label></div>`}
            <div class="group"><strong class="small">Entrega</strong>
              ${Object.entries(DELIVERY_LABELS).map(([key, label]) => `<label class="check"><input type="checkbox" name="delivery" value="${key}" data-multi ${deliveryOn.has(key) ? 'checked' : ''}> ${esc(label)}</label>`).join('')}
            </div>
            <div class="group grid-2">
              <label>Desde (Gs.)<input type="text" inputmode="numeric" name="minPrice" value="${esc(filters.minPrice)}"></label>
              <label>Hasta (Gs.)<input type="text" inputmode="numeric" name="maxPrice" value="${esc(filters.maxPrice)}"></label>
            </div>
            <div class="group">
              <label class="check"><input type="checkbox" name="inStock" ${filters.inStock ? 'checked' : ''}> Solo disponibles</label>
              <label class="check"><input type="checkbox" name="onSale" ${filters.onSale ? 'checked' : ''}> En oferta</label>
            </div>
            <div class="group"><label>Valoración<select name="minRating"><option value="">Cualquiera</option>${[4, 3].map(value => `<option value="${value}" ${String(filters.minRating) === String(value) ? 'selected' : ''}>${value}★ o más</option>`).join('')}</select></label></div>
            <button class="btn block" type="submit">Aplicar filtros</button>
          </form>
        </aside>
        <div>
          <div class="split" style="margin-bottom:12px">
            <button class="btn ghost small filters-toggle" data-action="toggle-filters">${icon('filter')} Filtros</button>
            <label class="small" style="display:flex;gap:8px;align-items:center;margin:0">Ordenar
              <select data-sort style="width:auto;min-height:36px;padding:6px 10px">${SORTS.map(([value, label]) => `<option value="${value}" ${(filters.sort || 'relevance') === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
            </label>
          </div>
          ${ads ? `<div style="margin-bottom:14px">${ads}</div>` : ''}
          ${grid(results.data, { compare: true }) || empty(filters.q ? `No encontramos «${filters.q}». Probá con otra palabra o revisá la ortografía.` : 'No hay productos con esos filtros.', { emoji: '🔎' })}
          <div class="btn-row" style="justify-content:center;margin-top:16px">
            ${page > 0 ? `<button class="btn ghost" data-page="${Math.max(0, page - 24)}">Anterior</button>` : ''}
            ${page + 24 < results.count ? `<button class="btn ghost" data-page="${page + 24}">Ver más</button>` : ''}
          </div>
        </div>
      </div>
      ${compareTray()}
    </div>`,
    mount(root) {
      bindForm($('[data-filters]', root), values => {
        const next = {
          delivery: (values.delivery || []).join(','), minPrice: values.minPrice.replace(/\D/g, ''), maxPrice: values.maxPrice.replace(/\D/g, ''),
          inStock: values.inStock ? 'true' : '', onSale: values.onSale ? 'true' : '', minRating: values.minRating || '', offset: '',
        };
        if (!category) next.category = values.category;
        setQuery(next);
      });
      $$('[data-clear-filter]', root).forEach(button => button.addEventListener('click', () => {
        const key = button.dataset.clearFilter;
        const cleared = key === 'all'
          ? Object.fromEntries(Object.keys(FILTER_LABELS).map(name => [name, '']))
          : { [key]: '' };
        setQuery({ ...cleared, offset: '' });
      }));
      $('[data-sort]', root)?.addEventListener('change', event => setQuery({ sort: event.target.value, offset: '' }));
      $$('[data-page]', root).forEach(button => button.addEventListener('click', () => setQuery({ offset: button.dataset.page })));
    },
  };
}

/** Consulta completa con las palabras corregidas por el buscador. */
function correctedQuery(query, corrections) {
  const plain = word => word.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return query.split(/\s+/).map(word => corrections.find(item => item.from === plain(word))?.to || word).join(' ');
}

function compareTray() {
  if (!state.compare.length) return '';
  return `<div class="compare-tray" role="region" aria-label="Comparador"><span>${state.compare.length} para comparar</span><span class="btn-row"><button class="btn ghost small" style="color:inherit" data-action="compare-clear">Limpiar</button><a class="btn accent small" href="/comparar">Comparar</a></span></div>`;
}

export async function compare() {
  if (!state.compare.length) return { title: 'Comparar', html: `<div class="wrap page"><h1>Comparar</h1>${empty('Marcá «Comparar» en hasta cuatro productos.', { emoji: '⚖️' })}</div>` };
  const result = await api(`/marketplace/compare?ids=${encodeURIComponent(state.compare.join(','))}`);
  const rows = [
    ['Precio', item => `<strong>${money(item.price.amount, item.price.currency)}</strong>`],
    ['Tienda', item => esc(item.seller?.name || item.merchantName || 'Ndivepa')],
    ['Valoración', item => stars(item.rating)],
    ['Categoría', item => esc(item.category || '—')],
    ['Marca', item => esc(item.brand || '—')],
    ['Peso', item => esc(item.weight || '—')],
    ['Medidas', item => esc(item.dimensions || '—')],
    ['Entrega', item => esc(item.deliveryLabels.join(', ') || '—')],
    ['Disponible', item => (item.inStock ? 'Sí' : 'No')],
  ];
  return {
    title: 'Comparar',
    html: `<div class="wrap page"><div class="split"><h1>Comparar productos</h1><button class="btn ghost small" data-action="compare-clear">Limpiar</button></div>
      <div class="table-wrap scroll-x"><table class="compare-table"><thead><tr><th></th>${result.data.map(item => `<th><a href="/producto/${esc(item.handle)}">${media(item)}<span>${esc(item.name)}</span></a></th>`).join('')}</tr></thead>
      <tbody>${rows.map(([label, render]) => `<tr><th scope="row">${label}</th>${result.data.map(item => `<td>${render(item)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`,
  };
}

export async function offers() {
  const result = await api('/marketplace/offers');
  return { title: 'Ofertas', html: `<div class="wrap page"><h1>Ofertas</h1><p class="muted">Precios rebajados por las tiendas.</p>${grid(result.data) || empty('No hay ofertas activas en este momento.', { emoji: '🏷️' })}</div>` };
}

// --- Ficha de producto ----------------------------------------------------------------

export async function product({ handle }) {
  const item = await api(`/marketplace/products/${encodeURIComponent(handle)}${state.locality ? `?locality=${encodeURIComponent(state.locality)}` : ''}`);
  const recommendations = await api(`/marketplace/products/${encodeURIComponent(handle)}/recommendations`).catch(() => ({}));
  const cities = await localities().catch(() => []);
  rememberViewed(item.id);
  trackView(item.id);
  const variant = item.variants.find(entry => entry.availability.hasStock) || item.variants[0] || null;
  const gallery = item.gallery.length ? item.gallery : [{ url: null, alt: item.name }];
  const distribution = item.rating.distribution || [0, 0, 0, 0, 0];
  const maxBar = Math.max(1, ...distribution);
  const external = item.externalOffer;
  const goHref = external ? `${external.path}?placement=product-page&source=marketplace&sid=${encodeURIComponent(state.visitor)}&consent=${state.consent === 'granted' ? 1 : 0}` : null;
  const buyBox = item.cta === 'external'
    ? `<div class="notice warn"><strong>Compra en sitio externo.</strong> ${esc(external?.notice || 'Este producto se compra en un comercio externo.')}</div>
       ${external ? `<a class="btn accent block" href="${esc(goHref)}" rel="sponsored nofollow noopener" target="_blank" data-external>Ver oferta en ${esc(external.merchantName)} ${icon('external')}</a>` : '<p class="muted">Oferta no disponible temporalmente.</p>'}
       <p class="small muted" style="margin-top:8px">${esc(external?.disclosure || '')}</p>`
    : `${item.variants.length > 1 ? `<label>Opción<select data-variant>${item.variants.map(entry => `<option value="${esc(entry.id)}" data-price="${entry.price}" ${entry.id === variant?.id ? 'selected' : ''} ${entry.availability.hasStock ? '' : 'disabled'}>${esc(entry.title)} — ${money(entry.price, item.price.currency)}${entry.availability.hasStock ? '' : ' (agotado)'}</option>`).join('')}</select></label>` : ''}
       <p class="small" data-availability>${availabilityText(variant)}</p>
       <div class="btn-row sticky-buy">
         <div class="qty"><button type="button" data-qty="-1" aria-label="Menos">−</button><input type="number" min="1" max="99" value="1" data-quantity aria-label="Cantidad"><button type="button" data-qty="1" aria-label="Más">+</button></div>
         <button class="btn accent" style="flex:1" data-action="add-to-cart" ${variant?.availability.hasStock ? '' : 'disabled'}>${icon('cart')} Agregar al carrito</button>
       </div>
       ${variant && !variant.availability.hasStock ? `<form class="stack" data-stock-alert style="gap:6px;margin-top:6px">${formError()}
         <p class="small muted" style="margin:0">¿Querés que te avisemos cuando vuelva?</p>
         <div class="btn-row">
           ${state.me ? '' : '<input type="email" name="email" required placeholder="Tu correo" style="flex:1" aria-label="Correo para el aviso">'}
           <button class="btn ghost" type="submit">${icon('bell')} Avisarme</button>
         </div>
       </form>` : ''}`;
  const store = item.store;
  return {
    title: item.name,
    html: `<div class="wrap page">
      <nav class="breadcrumb" aria-label="Ruta"><a href="/">Inicio</a>${item.categoryPath.map(node => ` › <a href="/categoria/${esc(node.handle)}">${esc(node.name)}</a>`).join('')}</nav>
      <div class="pdp">
        <div class="gallery">
          <div class="main" data-main-image>${gallery[0].url ? `<img src="${esc(gallery[0].url)}" alt="${esc(gallery[0].alt)}">` : media(item)}</div>
          ${gallery.length > 1 ? `<div class="thumbs">${gallery.map((image, index) => `<button type="button" data-thumb="${esc(image.url)}" aria-pressed="${index === 0}" aria-label="Imagen ${index + 1}"><img src="${esc(image.url)}" alt=""></button>`).join('')}</div>` : ''}
        </div>
        <div class="buybox stack">
          <div>
            ${item.discountPercent ? `<span class="badge sale">-${item.discountPercent}%</span> ` : ''}${item.isNew ? '<span class="badge new">Nuevo</span>' : ''}
            <h1 style="margin-top:6px">${esc(item.name)}</h1>
            <div class="meta">${stars(item.rating)}${item.unitsSold ? `<span>· ${item.unitsSold} vendidos</span>` : ''}${item.brand ? `<span>· ${esc(item.brand)}</span>` : ''}</div>
          </div>
          <div class="price" data-price>${money(variant?.price ?? item.price.amount, item.price.currency)}${item.price.compareAt ? `<s>${money(item.price.compareAt, item.price.currency)}</s>` : ''}</div>
          ${item.savings > 0 ? `<p class="small saving" style="margin:-4px 0 0">Ahorrás ${money(item.savings, item.price.currency)}</p>` : ''}
          ${item.favorites >= 3 ? `<p class="small muted" style="margin:0">${item.favorites} personas lo guardaron</p>` : ''}
          ${buyBox}
          <div class="btn-row">
            <button class="btn ghost small" data-action="fav" data-type="product" data-id="${esc(item.id)}" aria-pressed="${state.favorites.has(`product:${item.id}`)}">${icon('heart')} Guardar</button>
            <button class="btn ghost small" data-action="share" data-title="${esc(item.name)}">${icon('share')} Compartir</button>
            <button class="btn ghost small" data-action="report" data-type="product" data-id="${esc(item.id)}">${icon('flag')} Reportar</button>
          </div>
          ${deliveryCard(item, cities)}
          ${guaranteesCard(item)}
          ${store ? `<div class="card">
            <div class="split"><a class="store-card" style="border:0;padding:0" href="/tienda/${esc(store.code)}">${avatar(store)}<span><span class="name">${esc(store.name)}</span><span class="meta">${esc(storeType(store.type))}${store.area ? ` · ${esc(store.area)}` : ''}${store.locality ? `, ${esc(store.locality)}` : ''}</span></span></a>
            <button class="btn ghost small" data-action="follow" data-id="${esc(store.id)}" aria-pressed="${state.following.has(`seller:${store.id}`)}">${state.following.has(`seller:${store.id}`) ? 'Siguiendo' : 'Seguir'}</button></div>
            <div class="rep-grid" style="margin-top:10px">${reputationTiles(store.reputation)}</div>
            <button class="btn ghost small block" style="margin-top:10px" data-action="contact" data-seller="${esc(store.id)}" data-product="${esc(item.id)}">${icon('chat')} Consultar a la tienda</button>
          </div>` : ''}
        </div>
      </div>
      <section class="section">
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected="true" data-tab="desc">Descripción</button>
          <button role="tab" aria-selected="false" data-tab="reviews">Reseñas (${item.rating.count})</button>
          <button role="tab" aria-selected="false" data-tab="questions">Preguntas (${item.questions.length})</button>
        </div>
        <div data-panel="desc"><div class="card"><p style="white-space:pre-wrap">${esc(item.description || 'Sin descripción.')}</p>${item.tags.length ? `<div class="chips">${item.tags.map(tag => `<a class="chip" href="/buscar?q=${encodeURIComponent(tag)}">#${esc(tag)}</a>`).join('')}</div>` : ''}
          ${item.variants[0]?.dimensions || item.variants[0]?.weight ? `<dl class="kv" style="margin-top:12px">${item.variants[0].weight ? `<dt>Peso</dt><dd>${esc(item.variants[0].weight)} ${esc(item.variants[0].weightUnit)}</dd>` : ''}${item.variants[0].dimensions ? `<dt>Medidas</dt><dd>${esc([item.variants[0].dimensions.length, item.variants[0].dimensions.width, item.variants[0].dimensions.height].filter(Boolean).join(' × '))} ${esc(item.variants[0].dimensions.unit)}</dd>` : ''}</dl>` : ''}</div></div>
        <div data-panel="reviews" hidden><div class="card">
          ${item.rating.count ? `<div class="split"><div><strong style="font-size:2rem">${item.rating.average}</strong> ${stars(item.rating, { showCount: false })}<div class="muted small">${item.rating.count} reseña(s)</div></div>
            <div style="flex:1;max-width:320px">${[5, 4, 3, 2, 1].map(value => `<div class="bar-row"><span>${value}★</span><span class="bar"><span style="width:${Math.round((distribution[value - 1] / maxBar) * 100)}%"></span></span><span>${distribution[value - 1]}</span></div>`).join('')}</div></div><hr>` : ''}
          ${item.reviews.map(review => `<div class="review"><div class="split"><strong>${esc(review.author)}</strong><span class="muted small">${date(review.createdAt)}</span></div>${stars({ average: review.rating, count: 1 }, { showCount: false })} ${review.verifiedPurchase ? '<span class="badge ok">Compra verificada</span>' : ''}
            ${review.title ? `<p style="margin:6px 0 0"><strong>${esc(review.title)}</strong></p>` : ''}<p style="margin:4px 0">${esc(review.comment || '')}</p>
            ${review.photos.length ? `<div class="upload-grid">${review.photos.map(url => `<span class="thumb"><img src="${esc(url)}" alt="Foto de la reseña"></span>`).join('')}</div>` : ''}
            ${review.sellerReply ? `<div class="reply"><strong>Respuesta de la tienda:</strong> ${esc(review.sellerReply.body)}</div>` : ''}
            <div class="btn-row" style="margin-top:6px"><button class="linkish small" data-action="like" data-type="review" data-id="${esc(review.id)}">Útil (${review.helpfulCount})</button><button class="linkish small" data-action="report" data-type="review" data-id="${esc(review.id)}">Reportar</button></div></div>`).join('') || '<p class="muted">Todavía no hay reseñas. Solo quienes compraron y recibieron el producto pueden valorarlo.</p>'}
          ${item.cta === 'cart' ? '<p class="small muted" style="margin-top:10px">¿Lo compraste? Valoralo desde <a href="/cuenta/resenas">Mis reseñas</a>.</p>' : ''}
        </div></div>
        <div data-panel="questions" hidden><div class="card">
          ${item.cta === 'cart' ? `<form data-question-form class="stack">${formError()}<label>Preguntale a la tienda<textarea name="body" required minlength="5" maxlength="600" placeholder="¿Tiene otros colores? ¿Hacen envíos a…?"></textarea></label><button class="btn" type="submit">Preguntar</button></form><hr>` : ''}
          ${item.questions.map(question => `<div class="review"><p style="margin:0"><strong>${esc(question.body)}</strong></p><p class="muted small" style="margin:2px 0">${esc(question.author)} · ${ago(question.createdAt)}</p>${question.answer ? `<div class="reply">${esc(question.answer.body)}</div>` : '<p class="small muted">Esperando respuesta de la tienda.</p>'}</div>`).join('') || '<p class="muted">Aún no hay preguntas.</p>'}
        </div></div>
      </section>
      ${section('De la misma tienda', rail(recommendations.sameStore, entry => productCard(entry)))}
      ${section('Productos similares', rail(recommendations.similar, entry => productCard(entry)))}
      ${section('Comprados juntos', rail(recommendations.related, entry => productCard(entry)))}
      ${!recommendations.similar?.length ? section('Populares', rail(recommendations.popular, entry => productCard(entry))) : ''}
    </div>`,
    mount(root) {
      let current = variant;
      $$('[data-thumb]', root).forEach(button => button.addEventListener('click', () => {
        $('[data-main-image]', root).innerHTML = `<img src="${esc(button.dataset.thumb)}" alt="${esc(item.name)}">`;
        $$('[data-thumb]', root).forEach(other => other.setAttribute('aria-pressed', String(other === button)));
      }));
      $('[data-variant]', root)?.addEventListener('change', event => {
        current = item.variants.find(entry => entry.id === event.target.value);
        $('[data-price]', root).innerHTML = money(current.price, item.price.currency);
        $('[data-availability]', root).textContent = availabilityText(current);
        $('[data-action="add-to-cart"]', root).disabled = !current.availability.hasStock;
      });
      $$('[data-qty]', root).forEach(button => button.addEventListener('click', () => {
        const input = $('[data-quantity]', root);
        input.value = Math.max(1, Math.min(99, Number(input.value || 1) + Number(button.dataset.qty)));
      }));
      $('[data-action="add-to-cart"]', root)?.addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await addToCart(current.id, Number($('[data-quantity]', root).value || 1));
          toast('Agregado al carrito');
        } catch (error) {
          toast(error.message);
        } finally {
          button.disabled = !current?.availability.hasStock;
        }
      });
      $('[data-locality]', root)?.addEventListener('change', event => {
        setLocality(event.target.value);
        navigate(location.pathname, { replace: true });
      });
      bindForm($('[data-stock-alert]', root), async values => {
        await api('/marketplace/stock-alerts', {
          method: 'POST',
          body: { productId: item.id, variantId: current?.id || undefined, email: values.email || undefined },
        });
        toast('Listo, te avisamos cuando vuelva');
      });
      mountTabs(root);
      bindForm($('[data-question-form]', root), async values => {
        if (!requireLogin('Inicia sesión para preguntar.')) return;
        await api('/community/questions', { method: 'POST', body: { productId: item.id, body: values.body } });
        toast('Pregunta enviada. Te avisaremos cuando respondan.');
        navigate(location.pathname, { replace: true });
      });
    },
  };
}

/** Plazo en palabras: «hoy o mañana» se entiende mejor que «0-1 días». */
function daysLabel(option) {
  const min = option.estimatedDaysMin;
  const max = option.estimatedDaysMax;
  if (min === null && max === null) return '';
  if (max === 0) return ' · hoy';
  if (min === 0 && max === 1) return ' · hoy o mañana';
  if (min === max) return ` · en ${min} día${min === 1 ? '' : 's'}`;
  return ` · en ${min ?? 1} a ${max} días`;
}

/**
 * Entrega estimada en la ficha. El coste de envío que aparece recién en el
 * checkout es la principal causa de carritos abandonados: aquí se muestra con
 * las mismas opciones reales que después se cobran.
 */
function deliveryCard(item, cities = []) {
  if (item.cta === 'external') return '';
  const delivery = item.delivery;
  const picker = cities.length > 1
    ? `<label class="small" style="margin:8px 0 0">Entregar en
        <select data-locality style="min-height:36px">${cities.map(city => `<option value="${esc(city.id)}" ${city.id === delivery?.localityId ? 'selected' : ''}>${esc(city.name)}</option>`).join('')}</select>
      </label>`
    : '';
  if (!delivery?.available) {
    const labels = item.deliveryLabels?.length
      ? `<ul class="small" style="margin:6px 0 0;padding-left:18px">${item.deliveryLabels.map(label => `<li>${esc(label)}</li>`).join('')}</ul>`
      : '<p class="small muted" style="margin:6px 0 0">Todavía no podemos estimar el envío a esa ciudad. La tienda lo confirma al preparar el pedido.</p>';
    return `<div class="card"><strong>${icon('truck')} Entrega</strong>${labels}${picker}</div>`;
  }
  const options = delivery.options.map(option => `<li><strong>${esc(option.modeLabel)}</strong>: ${option.amount > 0 ? money(option.amount, option.currency) : 'sin coste'}${daysLabel(option)}</li>`).join('');
  const free = delivery.freeFrom ? `<p class="small ok" style="margin:6px 0 0">Envío gratis a partir de ${money(delivery.freeFrom, item.price.currency)}.</p>` : '';
  const handling = item.shippingInfo?.handlingDays
    ? `<p class="small muted" style="margin:6px 0 0">La tienda lo prepara en ${item.shippingInfo.handlingDays} día(s).</p>` : '';
  const notes = item.shippingInfo?.notes ? `<p class="small muted" style="margin:4px 0 0">${esc(item.shippingInfo.notes)}</p>` : '';
  return `<div class="card"><strong>${icon('truck')} Entrega a ${esc(delivery.localityName || 'tu ciudad')}</strong>
    <ul class="small" style="margin:6px 0 0;padding-left:18px">${options}</ul>${free}${handling}${notes}${picker}</div>`;
}

/**
 * Lo que protege la compra: devolución, medios de pago reales y el aviso de que
 * no guardamos datos de tarjetas. Sale de la configuración, no de un texto fijo.
 */
function guaranteesCard(item) {
  const trust = state.config?.trust;
  const days = item.guarantees?.returnWindowDays ?? trust?.returnWindowDays;
  const points = [];
  if (days) points.push(`<li>Devolución dentro de ${days} días de recibido el pedido.</li>`);
  if (trust?.paymentMethods?.length) points.push(`<li>Pagás con ${trust.paymentMethods.map(method => esc(method.name)).join(', ')}.</li>`);
  points.push('<li>No guardamos datos de tarjetas.</li>');
  if (item.guarantees?.reviewsRequirePurchase) points.push('<li>Solo valora quien compró: las reseñas son de compras verificadas.</li>');
  return `<div class="card"><strong>${icon('shield')} Tu compra está protegida</strong>
    <ul class="small" style="margin:6px 0 0;padding-left:18px">${points.join('')}</ul></div>`;
}

function availabilityText(variant) {
  if (!variant) return 'Sin variantes disponibles.';
  if (!variant.availability.hasStock) return 'Agotado por ahora.';
  if (variant.availability.lastUnits) return '¡Últimas unidades!';
  return 'Disponible.';
}

export function reputationTiles(reputation) {
  if (!reputation) return '';
  const tile = (value, label) => `<div class="rep"><strong>${value}</strong><span>${label}</span></div>`;
  return [
    tile(reputation.rating.average ? `${reputation.rating.average}★` : '—', reputation.rating.count ? `${reputation.rating.count} reseñas` : 'Sin reseñas aún'),
    tile(reputation.salesCount, 'ventas entregadas'),
    tile(reputation.fulfillmentRate === null ? '—' : `${reputation.fulfillmentRate}%`, 'pedidos cumplidos'),
    tile(reputation.responseTimeHours === null ? '—' : `${reputation.responseTimeHours} h`, 'tiempo de respuesta'),
  ].join('');
}

// --- Tiendas ---------------------------------------------------------------------------

export async function storePage({ code }) {
  const [data, ads] = await Promise.all([api(`/marketplace/stores/${encodeURIComponent(code)}`), Promise.resolve('')]);
  const { store, reputation } = data;
  const following = state.following.has(`seller:${store.id}`);
  const days = { lunes: 'Lun', martes: 'Mar', miercoles: 'Mié', jueves: 'Jue', viernes: 'Vie', sabado: 'Sáb', domingo: 'Dom' };
  const social = store.social || {};
  return {
    title: store.name,
    html: `<div class="wrap page">
      <div class="store-hero">
        <div class="banner" ${store.bannerUrl ? `style="background-image:url('${esc(store.bannerUrl)}')"` : ''}></div>
        <div class="inner">
          ${avatar(store, 'lg')}
          <div class="split" style="margin-top:8px"><div><h1 style="margin:0">${esc(store.name)}</h1><p class="muted" style="margin:2px 0 0">${esc(storeType(store.type))}${store.area ? ` · ${esc(store.area)}` : ''}${store.locality ? `, ${esc(store.locality)}` : ''}</p></div>
            <div class="btn-row"><button class="btn ${following ? 'ghost' : ''}" data-action="follow" data-id="${esc(store.id)}" aria-pressed="${following}">${following ? 'Siguiendo' : 'Seguir'}</button>
            <button class="btn ghost" data-action="contact" data-seller="${esc(store.id)}">${icon('chat')} Consultar</button>
            <button class="icon-btn" data-action="share" data-title="${esc(store.name)}" aria-label="Compartir">${icon('share')}</button>
            <button class="icon-btn" data-action="report" data-type="seller" data-id="${esc(store.id)}" aria-label="Reportar tienda">${icon('flag')}</button></div></div>
          ${store.tagline ? `<p style="margin-top:10px"><strong>${esc(store.tagline)}</strong></p>` : ''}
          <div class="rep-grid" style="margin-top:12px">${reputationTiles(reputation)}</div>
          <p class="small muted" style="margin-top:8px">${reputation.followers} seguidor(es) · ${reputation.productsPublished} producto(s) · En Ndivepa desde ${date(reputation.memberSince)}${reputation.incidents ? ` · ${reputation.incidents} incidencia(s) registradas` : ''}</p>
        </div>
      </div>
      <div class="tabs" role="tablist" style="margin-top:16px">
        <button role="tab" aria-selected="true" data-tab="products">Productos</button>
        <button role="tab" aria-selected="false" data-tab="about">Información</button>
        <button role="tab" aria-selected="false" data-tab="posts">Publicaciones</button>
        <button role="tab" aria-selected="false" data-tab="reviews">Reseñas</button>
      </div>
      <div data-panel="products">
        ${data.promotions.length ? `<div class="notice accent">${data.promotions.map(promo => `<div><strong>${esc(promo.label || promo.name)}</strong>${promo.description ? ` — ${esc(promo.description)}` : ''}${promo.endsAt ? ` <span class="muted small">hasta ${date(promo.endsAt)}</span>` : ''}</div>`).join('')}</div>` : ''}
        ${grid(data.products) || empty('Esta tienda todavía no publicó productos.')}
      </div>
      <div data-panel="about" hidden><div class="card stack">
        ${store.description ? `<p style="white-space:pre-wrap">${esc(store.description)}</p>` : ''}
        ${store.hours?.length ? `<div><strong>Horarios</strong><dl class="kv">${store.hours.map(hour => `<dt>${days[hour.day] || esc(hour.day)}</dt><dd>${hour.closed ? 'Cerrado' : `${esc(hour.opens || '')}–${esc(hour.closes || '')}`}</dd>`).join('')}</dl></div>` : ''}
        ${store.deliveryModes?.length ? `<div><strong>Entrega</strong><p>${store.deliveryModes.map(mode => esc(DELIVERY_LABELS[mode] || mode)).join(' · ')}</p></div>` : ''}
        ${store.businessInfo ? `<div><strong>Información comercial</strong><p style="white-space:pre-wrap">${esc(store.businessInfo)}</p></div>` : ''}
        <div><strong>Ubicación</strong><p>${esc([store.area, store.locality].filter(Boolean).join(', ') || 'No indicada')}${store.publicLocation ? ` · <a href="/explorar">Ver en el mapa</a>` : ' · La tienda no publica su ubicación exacta.'}</p></div>
        ${Object.values(social).some(Boolean) ? `<div><strong>Redes</strong><p>${social.instagram ? `<a href="https://instagram.com/${encodeURIComponent(social.instagram.replace('@', ''))}" target="_blank" rel="noopener nofollow">Instagram</a> ` : ''}${social.facebook ? `<a href="https://facebook.com/${encodeURIComponent(social.facebook)}" target="_blank" rel="noopener nofollow">Facebook</a> ` : ''}${social.tiktok ? `<a href="https://tiktok.com/@${encodeURIComponent(social.tiktok.replace('@', ''))}" target="_blank" rel="noopener nofollow">TikTok</a> ` : ''}${social.whatsapp ? `<a href="https://wa.me/${encodeURIComponent(social.whatsapp.replace(/\D/g, ''))}" target="_blank" rel="noopener nofollow">WhatsApp</a>` : ''}</p></div>` : ''}
      </div></div>
      <div data-panel="posts" hidden><div class="feed">${data.posts.map(post => `<article class="card feed-item"><span class="feed-kind">${esc(postKind(post.type))}</span><p style="white-space:pre-wrap;margin:6px 0">${esc(post.body)}</p>${post.imageUrl ? `<img src="${esc(post.imageUrl)}" alt="" style="border-radius:12px">` : ''}<div class="split small muted"><span>${ago(post.createdAt)}</span><button class="linkish" data-action="like" data-type="post" data-id="${esc(post.id)}">♥ ${post.likeCount}</button></div></article>`).join('') || empty('Sin publicaciones todavía.', { emoji: '📰' })}</div></div>
      <div data-panel="reviews" hidden><div class="card">${data.reviews.map(review => `<div class="review"><div class="split"><strong>${esc(review.author)}</strong><span class="small muted">${date(review.createdAt)}</span></div>${stars({ average: review.rating, count: 1 }, { showCount: false })} ${review.verifiedPurchase ? '<span class="badge ok">Compra verificada</span>' : ''}<p class="small muted" style="margin:2px 0">${esc(review.productName || '')}</p><p>${esc(review.comment || '')}</p>${review.sellerReply ? `<div class="reply"><strong>Respuesta:</strong> ${esc(review.sellerReply.body)}</div>` : ''}</div>`).join('') || '<p class="muted">Sin reseñas todavía.</p>'}</div></div>
      ${ads}
    </div>`,
    mount(root) {
      mountTabs(root);
    },
  };
}

const POST_KINDS = { update: 'Novedad', offer: 'Oferta', new_product: 'Nuevo producto', event: 'Evento' };
const postKind = type => POST_KINDS[type] || 'Novedad';

export async function stores() {
  const params = query();
  const search = new URLSearchParams(Object.fromEntries(Object.entries({ q: params.q || '', type: params.type || '', sort: params.sort || '' }).filter(([, value]) => value)));
  const result = await api(`/marketplace/stores?${search}`);
  const types = [['', 'Todas'], ['artisan', 'Artesanos'], ['entrepreneur', 'Emprendimientos'], ['commerce', 'Comercios'], ['services', 'Servicios']];
  return {
    title: 'Tiendas',
    html: `<div class="wrap page">
      <div class="split"><h1>Tiendas locales</h1><a class="btn ghost small" href="/explorar">${icon('map')} Ver mapa</a></div>
      <form data-store-search class="btn-row" style="margin:10px 0" role="search"><input type="search" name="q" value="${esc(params.q || '')}" placeholder="Buscar tienda o zona" style="flex:1"><button class="btn" type="submit">Buscar</button></form>
      <div class="chips" style="margin-bottom:12px">${types.map(([value, label]) => `<button class="chip" data-type="${value}" aria-pressed="${(params.type || '') === value}">${label}</button>`).join('')}</div>
      ${result.data.length ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">${result.data.map(storeCard).join('')}</div>` : empty('No encontramos tiendas con ese criterio.', { emoji: '🏪' })}
    </div>`,
    mount(root) {
      bindForm($('[data-store-search]', root), values => setQuery({ q: values.q }));
      $$('[data-type]', root).forEach(chip => chip.addEventListener('click', () => setQuery({ type: chip.dataset.type })));
    },
  };
}

// --- Mapa -----------------------------------------------------------------------------------

export async function explore() {
  const params = query();
  const [data, localities] = await Promise.all([api(`/marketplace/explore${params.localidad ? `?locality=${encodeURIComponent(params.localidad)}` : ''}`), api('/marketplace/localities')]);
  const cities = localities.tree.flatMap(function walk(node) { return [node, ...node.children.flatMap(walk)]; }).filter(node => node.type === 'city');
  const bounds = data.locality.bounds;
  const project = point => {
    if (!bounds) return { x: 50, y: 50 };
    return {
      x: ((point.lng - bounds.west) / (bounds.east - bounds.west)) * 100,
      y: ((bounds.north - point.lat) / (bounds.north - bounds.south)) * 75,
    };
  };
  const pins = data.points.map(point => ({ ...point, ...project(point) }));
  return {
    title: `Explorar ${data.locality.name}`,
    html: `<div class="wrap page">
      <div class="split"><h1>Explorar ${esc(data.locality.name)}</h1>
        <label class="small" style="margin:0">Ciudad <select data-city style="width:auto;min-height:36px">${cities.map(city => `<option value="${esc(city.code)}" ${city.id === data.locality.id ? 'selected' : ''} ${city.launchStatus !== 'active' ? 'disabled' : ''}>${esc(city.name)}${city.launchStatus === 'coming_soon' ? ' (próximamente)' : ''}</option>`).join('')}</select></label></div>
      <p class="muted">Solo se muestran en el mapa las tiendas que eligieron publicar su ubicación. El resto aparece por zona general.</p>
      <div class="map" role="img" aria-label="Mapa esquemático de ${esc(data.locality.name)} con ${pins.length} tiendas">
        <svg viewBox="0 0 100 75" preserveAspectRatio="xMidYMid meet">
          <defs><pattern id="g" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" stroke="currentColor" stroke-opacity=".08" stroke-width=".3"/></pattern></defs>
          <rect width="100" height="75" fill="url(#g)" style="color:var(--primary)"/>
          ${data.locality.center && bounds ? (() => { const c = project(data.locality.center); return `<circle cx="${c.x}" cy="${c.y}" r="14" fill="var(--primary)" fill-opacity=".08"/><text x="${c.x}" y="${c.y - 15.5}" text-anchor="middle" font-size="2.6" fill="var(--muted)">${esc(data.locality.name)}</text>`; })() : ''}
          ${pins.map(pin => `<a class="pin" href="/tienda/${esc(pin.code)}" aria-label="${esc(pin.name)}"><circle cx="${pin.x}" cy="${pin.y}" r="1.8" fill="var(--accent)" stroke="#fff" stroke-width=".5"/><text x="${pin.x + 2.4}" y="${pin.y + 0.9}" font-size="2.3" fill="var(--ink)">${esc(pin.name)}</text></a>`).join('')}
        </svg>
      </div>
      ${data.areas.map(area => section(`${area.name} (${area.stores.length})`, `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">${area.stores.map(storeCard).join('')}</div>`)).join('') || empty('Aún no hay tiendas en esta ciudad.', { emoji: '🗺️' })}
    </div>`,
    mount(root) {
      $('[data-city]', root)?.addEventListener('change', event => setQuery({ localidad: event.target.value }));
    },
  };
}

// --- Comunidad ---------------------------------------------------------------------------------

const FEED_KINDS = { new_product: 'Nuevo producto', offer: 'Oferta', featured: 'Destacado', new_store: 'Nueva tienda', seller_post: 'Publicación', recommendation: 'Recomendado para vos' };

export function feedItem(item) {
  const head = item.store ? `<div class="head">${avatar(item.store)}<div><a href="/tienda/${esc(item.store.code)}"><strong>${esc(item.store.name)}</strong></a><div class="small muted">${item.createdAt ? ago(item.createdAt) : ''}</div></div></div>` : '';
  const productBlock = product => `<a class="feed-product" href="/producto/${esc(product.handle)}">${media(product)}<span><strong>${esc(product.name)}</strong><span class="price" style="display:block">${money(product.price.amount, product.price.currency)}${product.price.compareAt ? `<s>${money(product.price.compareAt, product.price.currency)}</s>` : ''}</span></span></a>`;
  let body = '';
  if (item.type === 'seller_post' && item.post) {
    body = `<p style="white-space:pre-wrap">${esc(item.post.body)}</p>${item.post.imageUrl ? `<img src="${esc(item.post.imageUrl)}" alt="" style="border-radius:12px;margin-bottom:8px">` : ''}${item.post.products.map(productBlock).join('')}
      <div class="btn-row small" style="margin-top:8px"><button class="linkish" data-action="like" data-type="post" data-id="${esc(item.post.id)}">♥ ${item.post.likeCount}</button><button class="linkish" data-action="report" data-type="post" data-id="${esc(item.post.id)}">Reportar</button></div>`;
  } else if (item.type === 'new_store' && item.store) {
    body = `<p>¡Nueva tienda en la comunidad! <a href="/tienda/${esc(item.store.code)}">Conocé ${esc(item.store.name)}</a>.</p>`;
  } else if (item.promotion) {
    body = `<p><strong>${esc(item.promotion.label || item.promotion.name)}</strong>${item.promotion.endsAt ? ` · hasta ${date(item.promotion.endsAt)}` : ''}</p>`;
  }
  if (item.product) body += productBlock(item.product);
  return `<article class="card feed-item"><span class="feed-kind">${esc(FEED_KINDS[item.type] || '')}</span>${head}${body}</article>`;
}

export async function community() {
  const params = query();
  const scope = params.vista === 'siguiendo' ? 'following' : 'all';
  let result;
  try {
    result = await api(`/community/feed?scope=${scope}&limit=30`);
  } catch (error) {
    if (error.status === 401) result = { data: [], needsLogin: true };
    else throw error;
  }
  return {
    title: 'Comunidad',
    html: `<div class="wrap page">
      <h1>Comunidad</h1>
      <p class="muted">Novedades de las tiendas, ofertas, nuevos vendedores y recomendaciones.</p>
      <div class="tabs"><a href="/comunidad" aria-current="${scope === 'all' ? 'page' : 'false'}">Todo</a><a href="/comunidad?vista=siguiendo" aria-current="${scope === 'following' ? 'page' : 'false'}">Siguiendo</a></div>
      ${result.needsLogin ? empty('Inicia sesión para ver las tiendas que seguís.', { emoji: '👋', action: '<a class="btn" href="/ingresar?volver=/comunidad?vista=siguiendo">Ingresar</a>' })
        : result.data.length ? `<div class="feed">${result.data.map(feedItem).join('')}</div>` : empty(scope === 'following' ? 'Todavía no seguís a ninguna tienda.' : 'La comunidad está empezando: ¡todavía no hay actividad!', { emoji: '🌱', action: '<a class="btn" href="/tiendas">Descubrir tiendas</a>' })}
    </div>`,
  };
}

export async function profile({ id }) {
  const data = await api(`/community/profiles/${encodeURIComponent(id)}`);
  const following = state.following.has(`customer:${data.id}`);
  return {
    title: data.name,
    html: `<div class="wrap page"><div class="card"><div class="split"><div style="display:flex;gap:12px;align-items:center">${avatar({ name: data.name })}<div><h1 style="margin:0">${esc(data.name)}</h1><p class="muted small" style="margin:0">Miembro desde ${date(data.memberSince)}</p></div></div>
      ${state.me && state.me.id !== data.id ? `<button class="btn ghost small" data-action="follow-person" data-id="${esc(data.id)}">${following ? 'Siguiendo' : 'Seguir'}</button>` : ''}</div>
      <p class="small muted" style="margin-top:10px">${data.reviews} reseñas · ${data.followers} seguidores · sigue a ${data.following}</p></div>
      ${section('Reseñas recientes', data.recentReviews.length ? `<div class="card">${data.recentReviews.map(review => `<div class="review">${stars({ average: review.rating, count: 1 }, { showCount: false })} ${review.product ? `<a href="/producto/${esc(review.product.handle)}">${esc(review.product.name)}</a>` : ''}<p>${esc(review.comment || '')}</p></div>`).join('')}</div>` : '<p class="muted">Sin reseñas públicas.</p>')}
    </div>`,
  };
}

/** Diálogo de reporte reutilizable. */
export function openReport(targetType, targetId) {
  if (!requireLogin('Inicia sesión para reportar contenido.')) return;
  modal(`<h2>Reportar</h2><form data-report class="stack">${formError()}
    <label>Motivo<select name="reason" required><option value="spam">Spam</option><option value="fraud">Posible fraude</option><option value="counterfeit">Falsificación</option><option value="prohibited">Producto prohibido</option><option value="inappropriate">Contenido inapropiado</option><option value="wrong_info">Información incorrecta</option><option value="other">Otro</option></select></label>
    <label>Detalle (opcional)<textarea name="details" maxlength="1000"></textarea></label>
    <div class="btn-row"><button class="btn" type="submit">Enviar reporte</button><button class="btn ghost" type="button" data-close-btn>Cancelar</button></div></form>`, {
    onMount(element, close) {
      bindForm($('[data-report]', element), async values => {
        await api('/community/reports', { method: 'POST', body: { targetType, targetId, reason: values.reason, details: values.details || undefined } });
        close();
        toast('Gracias. La moderación revisará el reporte.');
      });
    },
  });
}

/** Diálogo para consultar a una tienda. */
export function openContact(sellerId, productId = null) {
  if (!requireLogin('Inicia sesión para consultar a la tienda.')) return;
  modal(`<h2>Consultar a la tienda</h2><form data-contact class="stack">${formError()}<label>Mensaje<textarea name="body" required maxlength="2000" placeholder="Escribí tu consulta"></textarea></label>
    <p class="small muted">No compartas datos de tarjetas ni contraseñas. Los mensajes con muchos enlaces se revisan antes de entregarse.</p>
    <div class="btn-row"><button class="btn" type="submit">Enviar</button><button class="btn ghost" type="button" data-close-btn>Cancelar</button></div></form>`, {
    onMount(element, close) {
      bindForm($('[data-contact]', element), async values => {
        const conversation = await api('/community/conversations', { method: 'POST', body: { sellerId, productId: productId || undefined, body: values.body } });
        close();
        navigate(`/cuenta/mensajes/${conversation.id}`);
      });
    },
  });
}

export { loading };
