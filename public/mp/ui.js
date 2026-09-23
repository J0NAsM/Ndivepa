/** Componentes de interfaz compartidos por todas las vistas. */
import { esc, money, state } from './core.js';

const PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.6 12.2a2 2 0 0 0 2 1.6h8.1a2 2 0 0 0 2-1.5L22 8H6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  heart: '<path d="M12 20s-7-4.4-9.3-8.5A5 5 0 0 1 12 6a5 5 0 0 1 9.3 5.5C19 15.6 12 20 12 20z"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  store: '<path d="M4 9 5.5 4h13L20 9"/><path d="M4 9v11h16V9"/><path d="M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0"/><path d="M10 20v-5h4v5"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.8 7L3 20l1-5.2A8 8 0 1 1 21 12z"/>',
  flag: '<path d="M4 21V4M4 4h13l-2 4 2 4H4"/>',
  map: '<path d="m9 4-6 2v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
  filter: '<path d="M3 5h18M6 12h12M10 19h4"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v6H4V6h6"/>',
  truck: '<path d="M3 6h11v10H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.5"/><circle cx="17" cy="17.5" r="1.5"/>',
  shield: '<path d="M12 3l7 3v6c0 4.4-3 8.1-7 9-4-.9-7-4.6-7-9V6z"/><path d="m9 12 2 2 4-4"/>',
};

export function icon(name, label = '') {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'}>${PATHS[name] || ''}</svg>`;
}

/** Emoji por categoría: identificación rápida sin depender de imágenes externas. */
export const CATEGORY_ICONS = {
  artesania: '🏺', poyvi: '🧶', hogar: '🏡', decoracion: '🪴', textiles: '🧵', cocina: '🍳', moda: '👗', ropa: '👕',
  calzados: '👟', accesorios: '👜', tecnologia: '📱', gastronomia: '🥯', deportes: '⚽', belleza: '💄', servicios: '🛠️',
  software: '💻', educacion: '📚', notebooks: '💻', audio: '🎧', 'cursos-online': '🎓',
};

export const DELIVERY_LABELS = {
  pickup: 'Retiro en tienda', local_delivery: 'Entrega local', national_shipping: 'Envío nacional', supplier_shipping: 'Envío del proveedor',
};

export function media(item, alt = '') {
  if (item?.image) return `<div class="media"><img src="${esc(item.image)}" alt="${esc(alt || item.name || '')}" loading="lazy" decoding="async"></div>`;
  return `<div class="media"><span class="emoji" aria-hidden="true">${esc(item?.emoji || '🛍️')}</span></div>`;
}

export function stars(rating, { showCount = true } = {}) {
  if (!rating || !rating.count) return '<span class="stars"><span class="muted small">Sin reseñas</span></span>';
  const full = Math.round(rating.average);
  return `<span class="stars" aria-label="${rating.average} de 5 estrellas">${'★'.repeat(full)}${'☆'.repeat(5 - full)}${showCount ? ` <span class="muted small">${rating.average} (${rating.count})</span>` : ''}</span>`;
}

export function favButton(type, id) {
  const on = state.favorites.has(`${type}:${id}`) || state.favorites.has(id);
  return `<button class="icon-btn fav-btn" data-action="fav" data-type="${type}" data-id="${esc(id)}" aria-pressed="${on}" aria-label="${on ? 'Quitar de favoritos' : 'Guardar en favoritos'}">${icon('heart')}</button>`;
}

export function productCard(product, { compare = false } = {}) {
  const badges = [];
  if (product.discountPercent) badges.push(`<span class="badge sale">-${product.discountPercent}%</span>`);
  if (product.isNew) badges.push('<span class="badge new">Nuevo</span>');
  if (product.cta === 'external') badges.push('<span class="badge ext">Tienda externa</span>');
  if (!product.inStock && product.cta !== 'external') badges.push('<span class="badge warn">Agotado</span>');
  // Escasez solo con stock real: «últimas unidades» sale del inventario, no de un
  // contador de urgencia inventado.
  else if (product.lastUnits) badges.push('<span class="badge last">Últimas unidades</span>');
  const origin = product.seller?.name || (product.cta === 'external' ? product.merchantName : null) || 'Ndivepa';
  // Cómo llega y cuánta gente ya lo compró: las dos preguntas que el comprador
  // se hace en el listado y que hoy solo se respondían dentro de la ficha.
  const signals = [];
  for (const mode of (product.deliveryModes || []).slice(0, 2)) {
    signals.push(`<span class="chip tiny">${esc(DELIVERY_LABELS[mode] || mode)}</span>`);
  }
  if (product.unitsSold > 0) signals.push(`<span class="chip tiny sold">${product.unitsSold} vendido${product.unitsSold === 1 ? '' : 's'}</span>`);
  return `<article class="product-card" data-product="${esc(product.id)}">
    <div class="badges">${badges.join('')}</div>
    ${favButton('product', product.id)}
    <a class="cover" href="/producto/${esc(product.handle)}">
      ${media(product)}
      <div class="body">
        <span class="title">${esc(product.name)}</span>
        <span class="price">${money(product.price?.amount, product.price?.currency)}${product.price?.compareAt ? `<s>${money(product.price.compareAt, product.price.currency)}</s>` : ''}</span>
        <span class="meta">${esc(origin)}${product.locality ? ` · ${esc(product.locality)}` : ''}</span>
        ${product.rating?.count ? stars(product.rating) : ''}
        ${signals.length ? `<span class="signals">${signals.join('')}</span>` : ''}
      </div>
    </a>
    ${compare ? `<label class="check small" style="padding:0 12px 10px"><input type="checkbox" data-action="compare" data-id="${esc(product.id)}" ${state.compare.includes(product.id) ? 'checked' : ''}> Comparar</label>` : ''}
  </article>`;
}

export function initials(name) {
  return esc(String(name || '?').split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase());
}

export function avatar(store, cls = '') {
  return `<span class="avatar ${cls}">${store?.logoUrl ? `<img src="${esc(store.logoUrl)}" alt="">` : initials(store?.name)}</span>`;
}

const STORE_TYPES = { artisan: 'Artesano', entrepreneur: 'Emprendimiento', commerce: 'Comercio', services: 'Servicios', platform: 'Ndivepa' };
export const storeType = type => STORE_TYPES[type] || 'Comercio';

export function storeCard(store) {
  return `<a class="store-card" href="/tienda/${esc(store.code)}">
    ${avatar(store)}
    <span style="min-width:0">
      <span class="name">${esc(store.name)}</span>
      <span class="meta">${esc(storeType(store.type))}${store.area ? ` · ${esc(store.area)}` : ''}${store.isNew ? ' · <strong>Nueva</strong>' : ''}</span>
      ${stars(store.rating)}
    </span>
  </a>`;
}

export function rail(items, render) {
  if (!items?.length) return '';
  return `<div class="rail">${items.map(render).join('')}</div>`;
}

export function section(title, content, { link = null, linkLabel = 'Ver todo' } = {}) {
  if (!content) return '';
  return `<section class="section"><div class="section-head"><h2>${esc(title)}</h2>${link ? `<a href="${esc(link)}">${esc(linkLabel)}</a>` : ''}</div>${content}</section>`;
}

export function empty(message, { emoji = '🧺', action = '' } = {}) {
  return `<div class="empty"><div class="big" aria-hidden="true">${emoji}</div><p>${esc(message)}</p>${action}</div>`;
}

export function loading() {
  return '<div class="grid"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
}

const STATUS_TONES = {
  delivered: 'ok', paid: 'ok', active: 'ok', published: 'ok', approved: 'ok', resolved: 'ok', sent: 'info',
  preparing: 'info', ready_to_ship: 'info', shipped: 'info', in_transit: 'info', proposed: 'warn', pending: 'warn',
  payment_pending: 'warn', pending_review: 'warn', open: 'warn', draft: 'warn', reviewing: 'warn',
  cancelled: 'danger', rejected: 'danger', suspended: 'danger', returned: 'danger', hidden: 'danger', blocked: 'danger', flagged: 'danger',
};
export function statusBadge(status, label = null) {
  return `<span class="badge ${STATUS_TONES[status] || 'info'}">${esc(label || status)}</span>`;
}

/**
 * Pestañas accesibles: relaciona cada botón con su panel y permite moverse con las
 * flechas, como espera un lector de pantalla.
 */
export function mountTabs(root) {
  const tabs = [...root.querySelectorAll('[data-tab]')];
  if (!tabs.length) return;
  const panels = [...root.querySelectorAll('[data-panel]')];
  const activate = tab => {
    tabs.forEach(other => {
      other.setAttribute('aria-selected', String(other === tab));
      other.tabIndex = other === tab ? 0 : -1;
    });
    panels.forEach(panel => { panel.hidden = panel.dataset.panel !== tab.dataset.tab; });
    tab.focus();
  };
  tabs.forEach((tab, index) => {
    tab.id = tab.id || `tab-${tab.dataset.tab}`;
    tab.tabIndex = tab.getAttribute('aria-selected') === 'true' ? 0 : -1;
    const panel = panels.find(item => item.dataset.panel === tab.dataset.tab);
    if (panel) {
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      panel.tabIndex = 0;
    }
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', event => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      activate(tabs[(index + step + tabs.length) % tabs.length]);
    });
  });
}

export function field(label, control, hint = '') {
  return `<div class="field"><label>${esc(label)}${control}</label>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
}

export const formError = () => '<div class="error-box form-error" role="alert" hidden></div>';

export function kpi(label, value, note = '') {
  return `<div class="kpi"><span>${esc(label)}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ''}</div>`;
}

/** Aplana el árbol de categorías para selects: «Hogar › Textiles». */
export function flattenCategories(tree, prefix = '') {
  return tree.flatMap(node => [{ id: node.id, handle: node.handle, name: prefix ? `${prefix} › ${node.name}` : node.name, depth: prefix ? 1 : 0 }, ...flattenCategories(node.children || [], prefix ? `${prefix} › ${node.name}` : node.name)]);
}

export function categorySelect(categories, selected = '', name = 'categoryId') {
  return `<select name="${name}" required><option value="">Elige una categoría</option>${categories.map(category => `<option value="${esc(category.id)}" ${category.id === selected ? 'selected' : ''}>${esc(category.name)}</option>`).join('')}</select>`;
}

export function priceInput(name, value = null, { required = false, placeholder = '' } = {}) {
  return `<input type="text" inputmode="numeric" name="${name}" value="${value === null || value === undefined ? '' : esc(value)}" ${required ? 'required' : ''} placeholder="${esc(placeholder)}" autocomplete="off">`;
}
