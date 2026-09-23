/** Punto de entrada de la SPA del marketplace. */
import {
  $, api, cartCount, emit, esc, loadCart, match, modal, navigate, on, refreshMe, route, setTitle, state, storage, toast,
} from './core.js';
import { icon } from './ui.js';
import * as pub from './views/public.js';
import * as shop from './views/shop.js';
import * as account from './views/account.js';
import * as seller from './views/seller.js';
import { adminRoute } from './views/admin.js';

// --- Rutas -----------------------------------------------------------------------------------
route('/', pub.home);
route('/buscar', () => pub.search());
route('/categoria/:handle', ({ handle }) => pub.search({ category: handle }));
route('/producto/:handle', pub.product);
route('/tienda/:code', pub.storePage);
route('/tiendas', pub.stores);
route('/ofertas', pub.offers);
route('/comparar', pub.compare);
route('/explorar', pub.explore);
route('/comunidad', pub.community);
route('/comunidad/perfil/:id', pub.profile);
route('/carrito', shop.cart);
route('/carrito/recuperar', shop.recoverCart);
route('/checkout', shop.checkout);
route('/checkout/confirmado', shop.confirmation);
route('/ingresar', account.login);
route('/cuenta', account.overview);
route('/cuenta/pedidos', account.orders);
route('/cuenta/pedidos/:id', account.orderDetail);
route('/cuenta/favoritos', account.favorites);
route('/cuenta/siguiendo', account.following);
route('/cuenta/avisos', account.notifications);
route('/cuenta/mensajes', () => account.messages());
route('/cuenta/mensajes/:id', account.messages);
route('/cuenta/resenas', account.reviews);
route('/cuenta/proveedor/:id', account.supplierPortal);
route('/vender', seller.sell);
route('/mi-tienda', seller.sellerHome);
route('/mi-tienda/:sellerId', seller.dashboard);
route('/mi-tienda/:sellerId/pedidos', seller.orders);
route('/mi-tienda/:sellerId/pedidos/:orderId', seller.orderDetail);
route('/mi-tienda/:sellerId/devoluciones', seller.returns);
route('/mi-tienda/:sellerId/productos', seller.products);
route('/mi-tienda/:sellerId/productos/nuevo', ({ sellerId }) => seller.productForm({ sellerId }));
route('/mi-tienda/:sellerId/productos/importar', seller.importProducts);
route('/mi-tienda/:sellerId/productos/:productId', seller.productForm);
route('/mi-tienda/:sellerId/promociones', seller.promotions);
route('/mi-tienda/:sellerId/resenas', seller.reviews);
route('/mi-tienda/:sellerId/preguntas', seller.questions);
route('/mi-tienda/:sellerId/mensajes', ({ sellerId }) => seller.messages({ sellerId }));
route('/mi-tienda/:sellerId/mensajes/:conversationId', seller.messages);
route('/mi-tienda/:sellerId/publicaciones', seller.posts);
route('/mi-tienda/:sellerId/publicidad', seller.ads);
route('/mi-tienda/:sellerId/clientes', seller.customers);
route('/mi-tienda/:sellerId/configuracion', seller.settings);
route('/admin', () => adminRoute({ section: '' }));
route('/admin/:section', ({ section }) => adminRoute({ section }));

// --- Estructura ------------------------------------------------------------------------------------

const app = $('#app');

function header() {
  const count = cartCount();
  const q = new URLSearchParams(location.search).get('q') || '';
  const path = location.pathname;
  const current = prefix => (prefix === '/' ? path === '/' : path.startsWith(prefix)) ? 'aria-current="page"' : '';
  return `<header class="header"><div class="wrap">
    <div class="header-row">
      <a class="brand" href="/" aria-label="${esc(state.config?.marketplace?.name || 'Ndivepa')}, inicio">Ndi<em>vepa</em></a>
      <form class="header-search" role="search" data-search-form>
        <input type="search" name="q" value="${esc(q)}" placeholder="Buscar productos y tiendas" aria-label="Buscar" autocomplete="off" data-suggest-input>
        <div class="suggest" data-suggest aria-label="Sugerencias de búsqueda"></div>
      </form>
      <div class="header-actions">
        <a class="icon-btn" href="${state.me ? '/cuenta/avisos' : '/ingresar'}" aria-label="Avisos">${icon('bell')}${state.unread ? `<span class="dot">${state.unread}</span>` : ''}</a>
        <a class="icon-btn" href="/carrito" aria-label="Carrito, ${count} artículos">${icon('cart')}${count ? `<span class="dot">${count}</span>` : ''}</a>
        <a class="icon-btn" href="${state.me ? '/cuenta' : '/ingresar'}" aria-label="${state.me ? 'Mi cuenta' : 'Ingresar'}">${icon('user')}</a>
      </div>
    </div>
    <nav class="desktop-nav" aria-label="Principal">
      <a href="/" ${current('/')}>Inicio</a><a href="/buscar" ${current('/buscar')}>Productos</a><a href="/ofertas" ${current('/ofertas')}>Ofertas</a>
      <a href="/tiendas" ${current('/tiendas')}>Tiendas</a><a href="/explorar" ${current('/explorar')}>Explorar</a><a href="/comunidad" ${current('/comunidad')}>Comunidad</a>
      ${state.stores.length ? `<a href="/mi-tienda" ${current('/mi-tienda')}>Mi tienda</a>` : `<a href="/vender" ${current('/vender')}>Quiero vender</a>`}
    </nav>
  </div></header>`;
}

function tabbar() {
  const path = location.pathname;
  const tab = (href, label, name, extra = '') => `<a href="${href}" ${(href === '/' ? path === '/' : path.startsWith(href)) ? 'aria-current="page"' : ''}>${icon(name)}<span>${label}</span>${extra}</a>`;
  const count = cartCount();
  return `<nav class="tabbar" aria-label="Navegación inferior">
    ${tab('/', 'Inicio', 'home')}${tab('/buscar', 'Buscar', 'search')}${tab('/comunidad', 'Comunidad', 'people')}
    ${tab('/carrito', 'Carrito', 'cart', count ? `<span class="dot" style="right:22%">${count}</span>` : '')}
    ${state.stores.length ? tab('/mi-tienda', 'Mi tienda', 'store') : tab(state.me ? '/cuenta' : '/ingresar', 'Cuenta', 'user')}
  </nav>`;
}

/**
 * Cinta de confianza: cómo se paga, cuántos días hay para devolver y con quién
 * hablar. Sale de la configuración real; si algo no está configurado, no se
 * inventa una promesa.
 */
function trustBar() {
  const trust = state.config?.trust;
  if (!trust) return '';
  const items = [];
  if (trust.paymentMethods?.length) {
    items.push(`<span>${icon('shield')} Pagá con ${trust.paymentMethods.map(method => esc(method.name)).join(', ')}</span>`);
  }
  if (trust.returnWindowDays) items.push(`<span>${icon('truck')} ${trust.returnWindowDays} días para devolver</span>`);
  items.push('<span>No guardamos datos de tarjetas</span>');
  if (trust.contactPhone || trust.contactEmail) {
    items.push(`<span>${icon('chat')} ${esc(trust.contactPhone || trust.contactEmail)}</span>`);
  }
  return `<div class="wrap trust-bar">${items.join('')}</div>`;
}

function footer() {
  return `<footer class="footer"><div class="wrap footer-grid">
    <div><strong>${esc(state.config?.marketplace?.name || 'Ndivepa')}</strong><p>${esc(state.config?.marketplace?.tagline || '')}</p></div>
    <div><a href="/tiendas">Tiendas</a><a href="/ofertas">Ofertas</a><a href="/explorar">Mapa</a><a href="/comunidad">Comunidad</a></div>
    <div><a href="/vender">Vender en Ndivepa</a><a href="/mi-tienda">Mi tienda</a><a href="/guias.html">Guías</a></div>
    <div><a href="/privacidad.html">Privacidad</a><button class="linkish small" data-action="consent-manage">Preferencias de analítica</button><p class="small">Algunos productos se venden en comercios externos: siempre lo indicamos antes de salir.</p></div>
  </div>${trustBar()}</footer>`;
}

function consentBanner() {
  if (state.consent) return '';
  return `<div class="consent" role="dialog" aria-label="Preferencias de privacidad"><p class="small" style="margin-bottom:10px"><strong>¿Nos ayudás a mejorar?</strong> Con tu permiso registramos visitas y búsquedas de forma agregada para saber qué funciona. Sin permiso, todo funciona igual.</p>
    <div class="btn-row"><button class="btn small" data-consent="granted">Aceptar</button><button class="btn ghost small" data-consent="denied">No, gracias</button><a class="small" href="/privacidad.html" style="align-self:center">Más información</a></div></div>`;
}

let renderToken = 0;

async function render() {
  const token = ++renderToken;
  const found = match(location.pathname);
  let view;
  try {
    view = found ? await found.handler(found.params) : notFound();
  } catch (error) {
    view = error.status === 404 ? notFound() : { title: 'Error', html: `<div class="wrap page"><div class="error-box" role="alert"><strong>No se pudo cargar esta página.</strong><br>${esc(error.message)}</div><button class="btn" data-action="retry">Reintentar</button></div>` };
  }
  if (token !== renderToken) return;
  // La cabecera se arma después de la vista: la vista puede haber cambiado el carrito o la sesión.
  app.innerHTML = `${header()}<main id="main" tabindex="-1">${view.html}</main>${footer()}${tabbar()}${consentBanner()}`;
  app.removeAttribute('aria-busy');
  if (view.title !== undefined) setTitle(view.title);
  view.mount?.(app);
  bindSuggest();
}

function notFound() {
  return { title: 'No encontrado', html: `<div class="wrap page"><div class="empty"><div class="big">🧭</div><h1>No encontramos esta página</h1><p>Puede que ya no esté publicada.</p><a class="btn" href="/">Volver al inicio</a></div></div>` };
}

// --- Búsqueda con sugerencias ---------------------------------------------------------------------

let suggestTimer;
function bindSuggest() {
  const input = $('[data-suggest-input]');
  const box = $('[data-suggest]');
  if (!input || !box) return;
  input.addEventListener('input', () => {
    clearTimeout(suggestTimer);
    const value = input.value.trim();
    if (value.length < 2) { box.classList.remove('open'); return; }
    suggestTimer = setTimeout(async () => {
      const data = await api(`/marketplace/suggest?q=${encodeURIComponent(value)}`).catch(() => null);
      if (!data || input.value.trim() !== value) return;
      const blocks = [];
      if (data.products.length) blocks.push(`<div class="label">Productos</div>${data.products.map(item => `<a href="/producto/${esc(item.handle)}">${esc(item.name)}</a>`).join('')}`);
      if (data.stores.length) blocks.push(`<div class="label">Tiendas</div>${data.stores.map(item => `<a href="/tienda/${esc(item.code)}">${esc(item.name)}</a>`).join('')}`);
      if (data.categories.length) blocks.push(`<div class="label">Categorías</div>${data.categories.map(item => `<a href="/categoria/${esc(item.handle)}">${esc(item.name)}</a>`).join('')}`);
      box.innerHTML = blocks.join('') || `<a href="/buscar?q=${encodeURIComponent(value)}">Buscar «${esc(value)}»</a>`;
      box.classList.add('open');
    }, 180);
  });
  input.addEventListener('blur', () => setTimeout(() => box.classList.remove('open'), 180));
}

// --- Acciones globales por delegación ----------------------------------------------------------------

document.addEventListener('submit', event => {
  const form = event.target.closest('[data-search-form]');
  if (!form) return;
  event.preventDefault();
  const q = new FormData(form).get('q')?.toString().trim();
  navigate(q ? `/buscar?q=${encodeURIComponent(q)}` : '/buscar');
});

document.addEventListener('click', async event => {
  const link = event.target.closest('a[href]');
  if (link && !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
    const href = link.getAttribute('href');
    const internal = href.startsWith('/') && !href.startsWith('//') && !link.target && link.dataset.external === undefined
      && !/^\/(go|api|uploads|panel\.html|guias\.html|privacidad\.html|campana|contenido)/.test(href) && !href.startsWith('/?');
    if (internal) {
      event.preventDefault();
      navigate(href);
      return;
    }
  }
  const actionElement = event.target.closest('[data-action],[data-consent]');
  if (!actionElement) return;
  const { action } = actionElement.dataset;
  if (actionElement.dataset.consent) {
    state.consent = actionElement.dataset.consent;
    storage.set('ndv-consent', state.consent);
    document.querySelector('.consent')?.remove();
    return;
  }
  try {
    switch (action) {
      case 'fav': return await toggleFavorite(actionElement);
      case 'follow': return await toggleFollow(actionElement, 'seller');
      case 'follow-person': return await toggleFollow(actionElement, 'customer');
      case 'like': {
        if (!state.me) return navigate(`/ingresar?volver=${encodeURIComponent(location.pathname)}`);
        await api('/community/likes', { method: 'POST', body: { targetType: actionElement.dataset.type, targetId: actionElement.dataset.id } });
        return emit('route');
      }
      case 'share': return await share(actionElement.dataset.title);
      case 'report': return pub.openReport(actionElement.dataset.type, actionElement.dataset.id);
      case 'contact': return pub.openContact(actionElement.dataset.seller, actionElement.dataset.product || null);
      case 'compare': return toggleCompare(actionElement);
      case 'compare-clear':
        state.compare = [];
        storage.set('ndv-compare', []);
        return emit('route');
      case 'toggle-filters': return document.querySelector('#filters')?.classList.toggle('open');
      case 'logout': return await account.logout();
      case 'retry': return emit('route');
      case 'consent-manage':
        state.consent = null;
        storage.remove('ndv-consent');
        return emit('route');
      default: return null;
    }
  } catch (error) {
    toast(error.message);
    return null;
  }
});

async function toggleFavorite(button) {
  const key = `${button.dataset.type}:${button.dataset.id}`;
  if (!state.me) {
    // Sin cuenta se guarda en el dispositivo; al iniciar sesión se pueden volver a marcar.
    if (state.favorites.has(key)) state.favorites.delete(key); else state.favorites.add(key);
    storage.set('ndv-guest-favorites', [...state.favorites]);
    button.setAttribute('aria-pressed', String(state.favorites.has(key)));
    toast(state.favorites.has(key) ? 'Guardado en este dispositivo. Ingresá para sincronizarlo.' : 'Quitado de favoritos');
    return;
  }
  const result = await api('/community/favorites', { method: 'POST', body: { targetType: button.dataset.type, targetId: button.dataset.id } });
  if (result.favorited) state.favorites.add(key); else state.favorites.delete(key);
  document.querySelectorAll(`[data-action="fav"][data-id="${CSS.escape(button.dataset.id)}"]`).forEach(element => element.setAttribute('aria-pressed', String(result.favorited)));
  toast(result.favorited ? 'Guardado en favoritos' : 'Quitado de favoritos');
}

async function toggleFollow(button, targetType) {
  if (!state.me) return navigate(`/ingresar?volver=${encodeURIComponent(location.pathname)}`);
  const result = await api('/community/follows', { method: 'POST', body: { targetType, targetId: button.dataset.id } });
  const key = `${targetType}:${button.dataset.id}`;
  if (result.following) state.following.add(key); else state.following.delete(key);
  toast(result.following ? 'Ahora seguís sus novedades en la comunidad' : 'Dejaste de seguir');
  return emit('route');
}

/**
 * Compartir. En el móvil se usa el menú del sistema; en el escritorio se ofrecen
 * WhatsApp y Facebook, que es por donde circula el comercio local, además de
 * copiar el enlace. La vista previa del enlace la arma el servidor (Open Graph),
 * así que muestra foto, precio y disponibilidad.
 */
async function share(title) {
  const url = location.href.split('?')[0];
  if (navigator.share) {
    await navigator.share({ title, url }).catch(() => {});
    return;
  }
  const text = `${title} · ${url}`;
  modal(`<h2>Compartir</h2>
    <div class="btn-row" style="margin-top:10px;flex-wrap:wrap">
      <a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text)}">WhatsApp</a>
      <a class="btn ghost" target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}">Facebook</a>
      <button class="btn ghost" data-copy-link>Copiar enlace</button>
    </div>`, {
    onMount(root) {
      root.querySelector('[data-copy-link]')?.addEventListener('click', async () => {
        await navigator.clipboard?.writeText(url).catch(() => {});
        toast('Enlace copiado');
      });
    },
  });
}

function toggleCompare(input) {
  const id = input.dataset.id;
  if (input.checked) {
    if (state.compare.length >= 4) {
      input.checked = false;
      toast('Podés comparar hasta 4 productos.');
      return;
    }
    state.compare = [...new Set([...state.compare, id])];
  } else {
    state.compare = state.compare.filter(entry => entry !== id);
  }
  storage.set('ndv-compare', state.compare);
  emit('route');
}

// --- Arranque ----------------------------------------------------------------------------------------

// Navegar sube al inicio; refrescar tras una acción conserva la posición.
on('route', payload => {
  render().then(() => {
    if (payload?.scroll) {
      window.scrollTo({ top: 0 });
      document.querySelector('#main')?.focus({ preventScroll: true });
    }
  });
});
on('cart', () => {
  const button = document.querySelector('.header a[href="/carrito"]');
  if (button) button.outerHTML = `<a class="icon-btn" href="/carrito" aria-label="Carrito, ${cartCount()} artículos">${icon('cart')}${cartCount() ? `<span class="dot">${cartCount()}</span>` : ''}</a>`;
});
window.addEventListener('popstate', () => render());

// Instalable y utilizable con conexión intermitente: el service worker guarda los
// archivos de la aplicación y las páginas públicas ya vistas. Nada privado se cachea.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
window.addEventListener('offline', () => toast('Estás sin conexión: podés seguir viendo lo ya cargado.'));
window.addEventListener('online', () => toast('Conexión restablecida.'));

(async () => {
  app.setAttribute('aria-busy', 'true');
  try {
    state.config = await api('/marketplace/config');
  } catch {
    state.config = { marketplace: { name: 'Ndivepa', currencyCode: 'PYG' } };
  }
  await Promise.all([refreshMe(), loadCart()]);
  await render();
})();
