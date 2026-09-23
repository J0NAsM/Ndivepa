/**
 * Núcleo de la SPA del marketplace: API, estado, enrutador y utilidades.
 * Sin dependencias ni paso de compilación: módulos ES servidos tal cual.
 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ENTITIES[char]);

const DECIMALS = { PYG: 0, CLP: 0, JPY: 0 };
/** Importes en unidades mínimas (PYG no tiene decimales). */
export function money(amount, currency = 'PYG') {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return 'Consultar';
  const code = String(currency || 'PYG').toUpperCase();
  const decimals = DECIMALS[code] ?? 2;
  try {
    return new Intl.NumberFormat('es-PY', { style: 'currency', currency: code, maximumFractionDigits: decimals, minimumFractionDigits: decimals })
      .format(Number(amount) / 10 ** decimals);
  } catch {
    return `${code} ${(Number(amount) / 10 ** decimals).toLocaleString('es-PY')}`;
  }
}
/** Convierte lo que escribe una persona («150.000») en unidades mínimas. */
export function parseMoney(value, currency = 'PYG') {
  const decimals = DECIMALS[String(currency).toUpperCase()] ?? 2;
  const clean = String(value ?? '').replace(/[^\d,.-]/g, '');
  if (!clean) return null;
  if (decimals === 0) return Number(clean.replace(/[.,]/g, '')) || null;
  const normalized = clean.replace(/\./g, '').replace(',', '.');
  const number = Number(normalized);
  return Number.isFinite(number) ? Math.round(number * 10 ** decimals) : null;
}
export const date = value => (value ? new Date(value).toLocaleDateString('es-PY', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
export const dateTime = value => (value ? new Date(value).toLocaleString('es-PY', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
export function ago(value) {
  if (!value) return '';
  const seconds = (Date.now() - new Date(value).getTime()) / 1000;
  if (seconds < 60) return 'hace un momento';
  if (seconds < 3600) return `hace ${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `hace ${Math.floor(seconds / 3600)} h`;
  if (seconds < 86400 * 30) return `hace ${Math.floor(seconds / 86400)} d`;
  return date(value);
}

export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* modo privado */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* modo privado */ }
  },
};

function cookie(name) {
  const match = document.cookie.split('; ').find(row => row.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

const BASES = { store: '/api/v1/store', admin: '/api/v1/admin', root: '' };

/**
 * Llamada a la API. El token CSRF se lee de su cookie en cada escritura: las
 * sesiones de cliente y de personal lo exigen para toda mutación.
 */
export async function api(path, { method = 'GET', body, base = 'store', signal } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = cookie('ndivepa_csrf');
    if (csrf) headers['X-Ndivepa-Csrf'] = csrf;
  }
  let response;
  try {
    response = await fetch(`${BASES[base]}${path}`, {
      method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal || (AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined),
    });
  } catch (error) {
    throw new ApiError(error.name === 'TimeoutError' ? 'La solicitud tardó demasiado. Intenta nuevamente.' : 'No se pudo conectar. Revisa tu conexión.', 0);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!response.ok) {
    const error = data?.error || data || {};
    const issues = (error.details?.issues || error.issues || []).map(issue => issue.message ? `${issue.field ? `${issue.field}: ` : ''}${issue.message}` : String(issue));
    throw new ApiError(error.message || `No se pudo completar la operación (${response.status}).`, response.status, issues, error.code);
  }
  return data;
}

export class ApiError extends Error {
  constructor(message, status, issues = [], code = null) {
    const extra = issues.filter(issue => !String(message).includes(issue.split(': ').pop()));
    super(extra.length ? `${message} ${extra.join(' · ')}` : message);
    this.status = status;
    this.issues = issues;
    this.code = code;
  }
}

// --- Estado global y suscripciones ---------------------------------------------

export const state = {
  config: null,
  me: null,
  capabilities: [],
  stores: [],
  suppliers: [],
  unread: 0,
  staff: null,
  cart: null,
  cartId: storage.get('ndv-cart', null),
  // Ciudad de entrega elegida: permite estimar costes y plazos reales antes del
  // checkout, que es donde se pierden más carritos.
  locality: storage.get('ndv-locality', null),
  localities: null,
  consent: storage.get('ndv-consent', null),
  visitor: storage.get('ndv-visitor', null) || `v_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
  favorites: new Set(),
  following: new Set(),
  compare: storage.get('ndv-compare', []),
};
storage.set('ndv-visitor', state.visitor);

const listeners = new Map();
export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
}
export function emit(event, payload) {
  for (const handler of listeners.get(event) || []) handler(payload);
}

export async function refreshMe() {
  try {
    const me = await api('/marketplace/me');
    state.me = me.customer;
    state.capabilities = me.capabilities || [];
    state.stores = me.stores || [];
    state.suppliers = me.suppliers || [];
    state.unread = me.unread || 0;
    if (state.me) {
      const [favorites, following] = await Promise.all([api('/community/favorites'), api('/community/following')]);
      state.favorites = new Set(favorites.ids);
      state.following = new Set(following.ids);
    } else {
      state.favorites = new Set(storage.get('ndv-guest-favorites', []));
      state.following = new Set();
    }
  } catch {
    state.me = null;
  }
  emit('me');
}

// --- Carrito -------------------------------------------------------------------------

export async function loadCart() {
  if (!state.cartId) {
    state.cart = null;
    emit('cart');
    return null;
  }
  try {
    state.cart = await api(`/marketplace/carts/${state.cartId}`);
    if (['completed', 'expired'].includes(state.cart.status)) throw new Error('cerrado');
  } catch {
    state.cartId = null;
    state.cart = null;
    storage.remove('ndv-cart');
  }
  emit('cart');
  return state.cart;
}

/** Ciudades operativas, pedidas una sola vez por sesión. */
export async function localities() {
  if (!state.localities) {
    const response = await api('/marketplace/localities').catch(() => ({ tree: [] }));
    const flatten = nodes => (nodes || []).flatMap(node => [node, ...flatten(node.children)]);
    state.localities = flatten(response.tree).filter(row => row.type === 'city' && row.launchStatus === 'active');
  }
  return state.localities;
}

/** Guarda la ciudad de entrega y avisa a las vistas que muestran estimaciones. */
export function setLocality(localityId) {
  state.locality = localityId || null;
  if (localityId) storage.set('ndv-locality', localityId);
  else storage.remove('ndv-locality');
  emit('locality');
}

export async function ensureCart() {
  if (state.cartId && state.cart) return state.cart;
  await loadCart();
  if (state.cart) return state.cart;
  const created = await api('/carts', { method: 'POST', body: { currencyCode: state.config?.marketplace?.currencyCode || 'PYG' } });
  state.cartId = created.id;
  storage.set('ndv-cart', created.id);
  return loadCart();
}

export async function addToCart(variantId, quantity = 1) {
  await ensureCart();
  await api(`/carts/${state.cartId}/line-items`, { method: 'POST', body: { variantId, quantity } });
  await loadCart();
}

export const cartCount = () => (state.cart?.items || []).reduce((sum, item) => sum + item.quantity, 0);

// --- Enrutador -------------------------------------------------------------------------

const routes = [];
export function route(pattern, handler) {
  const keys = [];
  const regex = new RegExp(`^${pattern.replace(/\/:([A-Za-z]+)/g, (_, key) => { keys.push(key); return '/([^/]+)'; })}/?$`);
  routes.push({ regex, keys, handler });
}

export function match(pathname) {
  for (const entry of routes) {
    const found = entry.regex.exec(pathname);
    if (found) {
      const params = Object.fromEntries(entry.keys.map((key, index) => [key, decodeURIComponent(found[index + 1])]));
      return { handler: entry.handler, params };
    }
  }
  return null;
}

export function navigate(path, { replace = false } = {}) {
  if (path === location.pathname + location.search) {
    emit('route');
    return;
  }
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  emit('route', { scroll: !replace });
}

export const query = () => Object.fromEntries(new URLSearchParams(location.search));

export function setQuery(values) {
  const params = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === '' || value === false) params.delete(key);
    else params.set(key, value);
  }
  const search = params.toString();
  navigate(`${location.pathname}${search ? `?${search}` : ''}`);
}

// --- Avisos y modales --------------------------------------------------------------------

let toastTimer;
export function toast(message) {
  const element = $('#toast');
  element.textContent = String(message || '');
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 3600);
}

export function modal(html, { onMount } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop" data-close><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = event => { if (event.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  root.querySelector('.modal-backdrop').addEventListener('click', event => {
    if (event.target.matches('[data-close]') || event.target.closest('[data-close-btn]')) close();
  });
  root.querySelector('.modal').querySelector('input,select,textarea,button')?.focus();
  onMount?.(root.querySelector('.modal'), close);
  return close;
}

/** Envuelve un formulario: deshabilita el botón, muestra errores y ejecuta `handler(datos)`. */
export function bindForm(form, handler) {
  if (!form) return;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    const errorBox = form.querySelector('.form-error');
    if (errorBox) { errorBox.hidden = true; errorBox.textContent = ''; }
    if (button) button.disabled = true;
    try {
      await handler(formData(form), form);
    } catch (error) {
      if (errorBox) {
        errorBox.textContent = error.message;
        errorBox.hidden = false;
      } else {
        toast(error.message);
      }
    } finally {
      if (button) button.disabled = false;
    }
  });
}

export function formData(form) {
  const output = {};
  for (const element of form.elements) {
    if (!element.name || element.disabled) continue;
    if (element.type === 'checkbox') {
      if (element.dataset.multi !== undefined) {
        output[element.name] = output[element.name] || [];
        if (element.checked) output[element.name].push(element.value);
      } else {
        output[element.name] = element.checked;
      }
    } else if (element.type === 'radio') {
      if (element.checked) output[element.name] = element.value;
    } else {
      output[element.name] = element.value.trim();
    }
  }
  return output;
}

/** Quita claves vacías (no se envían campos en blanco a la API). */
export function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== '' && value !== null && value !== undefined));
}

/**
 * Prepara una foto para subirla: la reduce a un tamaño razonable y la recomprime.
 * Una foto de celular pesa varios megas; subirla entera gasta datos de quien vende
 * y la rechaza el límite del servidor. Si algo falla, se envía el archivo original.
 */
export async function prepareImage(file, { maxSide = 1400, quality = 0.82 } = {}) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    // WebP conserva transparencia y pesa menos; si el navegador no lo soporta, JPEG.
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality))
      || await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob || (blob.size >= file.size && file.size <= 700_000)) return readFileAsDataUrl(file);
    return await readFileAsDataUrl(blob);
  } catch {
    return readFileAsDataUrl(file);
  }
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.readAsDataURL(file);
  });
}

export function setTitle(title) {
  const brand = state.config?.marketplace?.name || 'Ndivepa';
  document.title = title ? `${title} | ${brand}` : `${brand} · ${state.config?.marketplace?.tagline || 'Comercio local'}`;
}

/** Vista de producto con consentimiento de analítica (sin consentimiento no se registra). */
export function trackView(productId) {
  if (state.consent !== 'granted') return;
  const key = `ndv-view-${productId}`;
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch { /* sin sessionStorage */ }
  api('/events/view', { method: 'POST', body: { productId, sessionId: state.visitor, source: 'marketplace', page: location.pathname, consent: true } }).catch(() => {});
}

export function rememberViewed(productId) {
  const list = storage.get('ndv-viewed', []).filter(id => id !== productId);
  list.unshift(productId);
  storage.set('ndv-viewed', list.slice(0, 16));
}

export function requireLogin(message = 'Inicia sesión para continuar.') {
  if (state.me) return true;
  toast(message);
  navigate(`/ingresar?volver=${encodeURIComponent(location.pathname + location.search)}`);
  return false;
}
