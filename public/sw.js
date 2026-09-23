/**
 * Service worker de Ndivepa.
 *
 * Objetivo: que el marketplace siga siendo usable con conexión intermitente, que
 * es la realidad de buena parte del público. Reglas:
 *
 *  - Nunca se cachea nada de `/api/`, `/go/` ni de las vistas privadas (cuenta,
 *    mi tienda, administración, carrito, checkout): son datos de una sesión.
 *  - Los archivos de la aplicación se sirven desde caché y se actualizan detrás.
 *  - Las páginas públicas se piden a la red primero; si falla, se muestra la
 *    última copia vista y, si no hay, la portada guardada.
 */
const VERSION = 'ndivepa-v4-1';
const SHELL = `${VERSION}-shell`;
const PAGES = `${VERSION}-pages`;

const APP_FILES = [
  '/mp/styles.css',
  '/mp/core.js',
  '/mp/ui.js',
  '/mp/app.js',
  '/mp/views/public.js',
  '/mp/views/shop.js',
  '/mp/views/account.js',
  '/mp/views/seller.js',
  '/mp/views/admin.js',
  '/favicon.svg',
  '/site.webmanifest',
];

// Vistas con datos de sesión: siempre de la red, nunca guardadas.
// `/feeds/` va aquí también: un catálogo viejo servido desde caché se publicaría
// en Facebook con precios que ya no son.
const PRIVATE = /^\/(api|go|feeds|carrito|checkout|cuenta|mi-tienda|admin|ingresar)(\/|$)/;
const APP_ASSET = /^\/(mp\/|uploads\/|favicon\.svg|site\.webmanifest)/;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll([...APP_FILES, '/']);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => !name.startsWith(VERSION)).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(request);
  const network = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || network || fetch(request);
}

async function networkFirst(request) {
  const cache = await caches.open(PAGES);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request) || await caches.match('/');
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (PRIVATE.test(url.pathname)) return;
  if (APP_ASSET.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  if (request.mode === 'navigate') event.respondWith(networkFirst(request));
});
