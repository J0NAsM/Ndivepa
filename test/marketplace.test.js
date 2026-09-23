/**
 * Marketplace de extremo a extremo (v4), contra el servidor real.
 *
 * Recorre el flujo completo que exige el criterio de finalización:
 *   crear vendedor -> crear tienda -> revisión -> producto publicado -> el
 *   cliente lo encuentra (con errores de tipeo) -> carrito multivendedor ->
 *   compra -> subpedidos -> la tienda prepara, envía y entrega -> el cliente
 *   valora (compra verificada) -> estadísticas -> comisión en el libro.
 * Y las reglas de seguridad: autorización por recurso, precios del backend,
 * reseñas sin compra, productos afiliados fuera del carrito, CSRF y permisos.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 4398;
const origin = `http://127.0.0.1:${port}`;
const store = `${origin}/api/v1/store`;
const admin = `${origin}/api/v1/admin`;
const POSTBACK_SECRET = 'secreto-de-prueba-postback';
let server;
let dataDir;

async function waitForServer() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await fetch(`${origin}/api/ready`)).ok) return;
    } catch { /* aún arrancando */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('El servidor de prueba no inició.');
}

/** Cliente HTTP con cookies y CSRF, como un navegador. */
function client() {
  const jar = new Map();
  const cookieHeader = () => [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
  const call = async (method, url, body) => {
    const headers = { cookie: cookieHeader() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (jar.has('ndivepa_csrf') && method !== 'GET') headers['X-Ndivepa-Csrf'] = jar.get('ndivepa_csrf');
    const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const [key, ...rest] = pair.split('=');
      const value = rest.join('=');
      if (value) jar.set(key.trim(), value);
      else jar.delete(key.trim());
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
  };
  return {
    get: url => call('GET', url),
    post: (url, body = {}) => call('POST', url, body),
    patch: (url, body = {}) => call('PATCH', url, body),
    del: url => call('DELETE', url),
    jar,
  };
}

async function customer(email, firstName = 'Prueba', lastName = 'Cliente') {
  const http = client();
  const password = 'Contrasena-Larga-2026';
  const registered = await http.post(`${store}/customers/register`, { email, password, firstName, lastName });
  assert.equal(registered.status, 201, JSON.stringify(registered.data));
  const logged = await http.post(`${store}/customers/login`, { email, password });
  assert.equal(logged.status, 200);
  return http;
}

async function staff() {
  const http = client();
  const logged = await http.post(`${origin}/api/auth/login`, { email: 'admin@ndivepa.local', password: 'Ndivepa2026!' });
  assert.equal(logged.status, 200);
  return http;
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ndivepa-mp-'));
  server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_BASE_URL: origin,
      DATA_DIR: dataDir,
      SNAPSHOT_DIR: join(dataDir, 'snapshots'),
      JOBS_ENABLED: 'false',
      // La suite hace muchas escrituras desde una sola IP en pocos segundos.
      RATE_WRITE_MAX: '2000',
      AFFILIATE_POSTBACK_SECRET: POSTBACK_SECRET,
    },
    stdio: 'ignore',
  });
  await waitForServer();
});

after(async () => {
  server?.kill();
  await new Promise(resolve => setTimeout(resolve, 200));
  await rm(dataDir, { recursive: true, force: true });
});

const shared = {};

test('flujo completo: vendedor, tienda, producto, compra, entrega, reseña, estadísticas y comisión', async () => {
  const anon = client();
  const config = await anon.get(`${store}/marketplace/config`);
  assert.equal(config.status, 200);
  assert.equal(config.data.commerceMode, 'HYBRID');
  assert.equal(config.data.marketplace.currencyCode, 'PYG');
  const categories = await anon.get(`${store}/marketplace/categories`);
  const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children || [])]);
  const poyvi = flatten(categories.data.tree).find(node => node.handle === 'poyvi');
  assert.ok(poyvi, 'la categoría poyvi existe');

  // --- Crear vendedor y tienda ------------------------------------------------
  const seller = await customer('vendedora@prueba.local', 'Ana', 'Duarte');
  const created = await seller.post(`${store}/marketplace/seller/stores`, { name: 'Tejidos Ana', categoryIds: [poyvi.id], localityId: 'loc_carapegua' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const sellerId = created.data.id;
  assert.equal(created.data.status, 'pending');
  assert.equal(created.data.checklist.complete, false);

  // Sin tienda aprobada no se publica.
  const early = await seller.post(`${store}/marketplace/seller/stores/${sellerId}/products`, { name: 'Hamaca temprana', categoryId: poyvi.id, price: 100000, status: 'published' });
  assert.equal(early.status, 409);

  // Enviar incompleta: se informa lo que falta.
  const incomplete = await seller.post(`${store}/marketplace/seller/stores/${sellerId}/submit`, { acceptTerms: true });
  assert.equal(incomplete.status, 422);

  const profile = await seller.patch(`${store}/marketplace/seller/stores/${sellerId}`, {
    description: 'Tejemos hamacas de poyvi en Carapeguá desde hace veinte años, con telar tradicional.',
    location: { area: 'Centro', public: false, address: 'Calle privada 123' },
    contactPhone: '+595 981 000000',
    deliveryModes: ['pickup', 'local_delivery'],
  });
  assert.equal(profile.status, 200, JSON.stringify(profile.data));
  assert.equal(profile.data.checklist.complete, true);
  const submitted = await seller.post(`${store}/marketplace/seller/stores/${sellerId}/submit`, { acceptTerms: true });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  assert.equal(submitted.data.application.status, 'pending');

  // --- Revisión administrativa -------------------------------------------------
  const staffHttp = await staff();
  const inbox = await staffHttp.get(`${admin}/marketplace/inbox`);
  assert.ok(inbox.data.data.some(item => item.type === 'seller_application'));
  const decision = await staffHttp.post(`${admin}/marketplace/seller-applications/${submitted.data.application.id}/decision`, { decision: 'approve' });
  assert.equal(decision.status, 200, JSON.stringify(decision.data));
  assert.equal(decision.data.status, 'active');

  // --- Crear y publicar producto ----------------------------------------------
  const product = await seller.post(`${store}/marketplace/seller/stores/${sellerId}/products`, {
    name: 'Hamaca de poyvi matrimonial Ana',
    description: 'Hamaca grande tejida a mano.',
    categoryId: poyvi.id,
    price: 400000,
    stock: 3,
    tags: ['hamaca', 'poyvi'],
    status: 'published',
  });
  assert.equal(product.status, 201, JSON.stringify(product.data));
  assert.equal(product.data.status, 'published');
  assert.equal(product.data.commercialModel, 'LOCAL');
  assert.equal(product.data.variants[0].stock, 3);
  shared.productId = product.data.id;
  shared.productHandle = product.data.handle;
  shared.categoryId = poyvi.id;
  shared.sellerId = sellerId;

  // La tienda pública no expone datos privados.
  const publicStore = await anon.get(`${store}/marketplace/stores/${created.data.code}`);
  assert.equal(publicStore.status, 200);
  const serialized = JSON.stringify(publicStore.data);
  assert.ok(!serialized.includes('Calle privada'), 'la dirección exacta es privada');
  assert.ok(!serialized.includes('981 000000'), 'el teléfono de contacto es privado');
  assert.equal(publicStore.data.store.publicLocation, null);
  assert.equal(publicStore.data.reputation.rating.average, null, 'sin reseñas no hay valoración inventada');

  // --- El cliente lo encuentra, incluso con errores -----------------------------
  const found = await anon.get(`${store}/marketplace/search?q=${encodeURIComponent('amaca poyvii matrimonial')}`);
  assert.equal(found.status, 200);
  assert.ok(found.data.data.some(item => item.id === shared.productId), 'búsqueda tolerante a errores');
  assert.ok(found.data.corrected?.length);
  const detail = await anon.get(`${store}/marketplace/products/${product.data.handle}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.cta, 'cart');
  assert.equal(detail.data.store.code, created.data.code);
  const ssr = await fetch(`${origin}/producto/${product.data.handle}`);
  const html = await ssr.text();
  assert.equal(ssr.status, 200);
  assert.match(html, /application\/ld\+json/);
  assert.match(html, /rel="canonical"/);
  const storeHtml = await (await fetch(`${origin}/tienda/${created.data.code}`)).text();
  assert.match(storeHtml, /"@type":"Store"/);

  // --- Carrito multivendedor y compra ------------------------------------------
  const buyer = await customer('comprador@prueba.local', 'Luis', 'Pérez');
  const cart = await buyer.post(`${store}/carts`, { currencyCode: 'PYG' });
  assert.equal(cart.status, 201);
  const cartId = cart.data.id;
  const add = await buyer.post(`${store}/carts/${cartId}/line-items`, { variantId: detail.data.variants[0].id, quantity: 2 });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  // Un segundo vendedor (demo) en el mismo carrito.
  const other = (await anon.get(`${store}/marketplace/search?q=chipa`)).data.data[0];
  const otherDetail = await anon.get(`${store}/marketplace/products/${other.handle}`);
  await buyer.post(`${store}/carts/${cartId}/line-items`, { variantId: otherDetail.data.variants[0].id, quantity: 1 });

  const grouped = await buyer.get(`${store}/marketplace/carts/${cartId}`);
  assert.equal(grouped.data.groups.length, 2, 'el carrito agrupa por tienda');
  assert.equal(grouped.data.subtotal, 400000 * 2 + other.price.amount, 'el total lo calcula el backend');

  await buyer.post(`${store}/carts/${cartId}/addresses`, {
    email: 'comprador@prueba.local',
    shippingAddress: { firstName: 'Luis', lastName: 'Pérez', address1: 'Av. Principal 100', city: 'Carapeguá', countryCode: 'py', phone: '+595 971 111111' },
  });
  const options = await buyer.get(`${store}/carts/${cartId}/shipping-options`);
  const pickup = options.data.data.find(option => option.code === 'py-retiro');
  assert.ok(pickup, 'retiro en tienda disponible');
  await buyer.post(`${store}/carts/${cartId}/shipping-method`, { shippingOptionId: pickup.id });
  const methods = await buyer.get(`${store}/carts/${cartId}/payment-methods`);
  const cod = methods.data.data.find(method => method.provider === 'cash_on_delivery');
  const completed = await buyer.post(`${store}/carts/${cartId}/complete`, { paymentMethodId: cod.id, idempotencyKey: 'prueba-mp-1' });
  assert.equal(completed.status, 201, JSON.stringify(completed.data));
  const orderId = completed.data.order.id;

  const myOrder = await buyer.get(`${store}/marketplace/me/orders/${orderId}`);
  assert.equal(myOrder.status, 200);
  assert.equal(myOrder.data.vendorOrders.length, 2, 'un subpedido por tienda');
  assert.ok(myOrder.data.vendorOrders.every(row => row.status === 'payment_pending'));
  assert.ok(!JSON.stringify(myOrder.data).includes('commission'), 'el comprador no ve comisiones');

  // --- La tienda recibe y procesa el pedido --------------------------------------
  const sellerOrders = await seller.get(`${store}/marketplace/seller/stores/${sellerId}/orders`);
  assert.equal(sellerOrders.data.count, 1, 'la tienda solo ve su subpedido');
  const vendorOrder = sellerOrders.data.data[0];
  assert.equal(vendorOrder.total, 800000);
  assert.equal(vendorOrder.commissionTotal, 80000, '10 % por la regla global configurable');
  assert.equal(vendorOrder.sellerPayout, 720000);
  assert.equal(vendorOrder.buyer.address, null, 'en retiro no se comparte la dirección');
  const notifications = await seller.get(`${store}/marketplace/me/notifications`);
  assert.ok(notifications.data.data.some(item => item.type === 'new_order'));

  const statusUrl = `${store}/marketplace/seller/stores/${sellerId}/orders/${vendorOrder.id}/status`;
  const forbidden = await seller.post(statusUrl, { status: 'returned' });
  assert.equal(forbidden.status, 409);
  for (const status of ['preparing', 'ready_to_ship', 'delivered']) {
    const moved = await seller.post(statusUrl, { status });
    assert.equal(moved.status, 200, `${status}: ${JSON.stringify(moved.data)}`);
    assert.equal(moved.data.status, status);
  }
  const stockAfter = await seller.get(`${store}/marketplace/seller/stores/${sellerId}/products/${shared.productId}`);
  assert.equal(stockAfter.data.variants[0].stock, 1, 'la entrega consumió el stock reservado');

  // --- El cliente valora (compra verificada) -------------------------------------
  const reviewable = await buyer.get(`${store}/community/me/reviewable`);
  assert.ok(reviewable.data.data.some(row => row.productId === shared.productId));
  const review = await buyer.post(`${store}/community/reviews`, { productId: shared.productId, rating: 5, comment: 'Excelente trabajo, muy cómoda.' });
  assert.equal(review.status, 201, JSON.stringify(review.data));
  assert.equal(review.data.verifiedPurchase, true);
  const unverified = await buyer.post(`${store}/community/reviews`, { productId: otherDetail.data.id, rating: 1 });
  assert.equal(unverified.status, 409, 'no se valora lo que no se recibió');

  const reply = await seller.post(`${store}/community/seller/${sellerId}/reviews/${review.data.id}/reply`, { body: '¡Gracias por tu compra!' });
  assert.equal(reply.status, 200);

  // --- Estadísticas y comisión ---------------------------------------------------
  const dashboard = await seller.get(`${store}/marketplace/seller/stores/${sellerId}/dashboard`);
  assert.equal(dashboard.data.sales.orders, 1);
  assert.equal(dashboard.data.sales.gross, 800000);
  assert.equal(dashboard.data.reputation.salesCount, 1);
  assert.equal(dashboard.data.reputation.rating.average, 5);
  assert.equal(dashboard.data.reputation.fulfillmentRate, 100);
  assert.equal(dashboard.data.income.available, 720000);

  const adminDashboard = await staffHttp.get(`${admin}/marketplace/dashboard`);
  assert.equal(adminDashboard.status, 200);
  assert.ok(adminDashboard.data.marketplaceSales.confirmed >= 800000, 'GMV confirmado');
  assert.ok(adminDashboard.data.platformRevenue.commissions.confirmed >= 80000, 'ingreso por comisión separado');
  assert.ok('affiliateRevenue' in adminDashboard.data && 'dropshipping' in adminDashboard.data);
  const ledger = await staffHttp.get(`${admin}/ledger?filter[vendorOrderId]=${vendorOrder.id}`);
  assert.ok(ledger.data.data.some(row => row.type === 'commission' && row.amount === 80000 && row.status === 'confirmed'));

  shared.buyer = buyer;
  shared.seller = seller;
  shared.staff = staffHttp;
  shared.orderId = orderId;
});

test('autorización por recurso: otra tienda no ve ni toca productos ajenos', async () => {
  const intruder = await customer('intrusa@prueba.local');
  const own = await intruder.post(`${store}/marketplace/seller/stores`, { name: 'Tienda intrusa' });
  assert.equal(own.status, 201);
  const foreign = await intruder.get(`${store}/marketplace/seller/stores/${shared.sellerId}`);
  assert.equal(foreign.status, 404);
  const patch = await intruder.patch(`${store}/marketplace/seller/stores/${own.data.id}/products/${shared.productId}`, { price: 1 });
  assert.equal(patch.status, 404);
  const anon = client();
  assert.equal((await anon.get(`${store}/marketplace/seller/stores/${shared.sellerId}/orders`)).status, 401);
  assert.equal((await anon.get(`${admin}/marketplace/dashboard`)).status, 401);
});

test('precios y totales del backend: no se aceptan importes del cliente', async () => {
  const buyer = await customer('precio@prueba.local');
  const cart = await buyer.post(`${store}/carts`, { currencyCode: 'PYG' });
  const detail = (await buyer.get(`${store}/marketplace/search?q=hamaca`)).data.data[0];
  const variant = (await buyer.get(`${store}/marketplace/products/${detail.handle}`)).data.variants[0];
  const tampered = await buyer.post(`${store}/carts/${cart.data.id}/line-items`, { variantId: variant.id, quantity: 1, unitPrice: 1 });
  assert.equal(tampered.status, 422, 'campo de precio rechazado');
  const ok = await buyer.post(`${store}/carts/${cart.data.id}/line-items`, { variantId: variant.id, quantity: 1 });
  assert.equal(ok.data.items[0].unitPrice, variant.price);
});

test('CSRF obligatorio para acciones con sesión de cliente', async () => {
  const buyer = await customer('csrf@prueba.local');
  const response = await fetch(`${store}/community/favorites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: [...buyer.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') },
    body: JSON.stringify({ targetType: 'product', targetId: shared.productId }),
  });
  assert.equal(response.status, 403);
  const withToken = await buyer.post(`${store}/community/favorites`, { targetType: 'product', targetId: shared.productId });
  assert.equal(withToken.status, 200);
  assert.equal(withToken.data.favorited, true);
});

test('productos afiliados: en el catálogo con CTA externo y fuera del carrito', async () => {
  const anon = client();
  const results = await anon.get(`${store}/marketplace/search?model=AFILIADO`);
  assert.ok(results.data.count > 0);
  const affiliate = results.data.data[0];
  assert.equal(affiliate.cta, 'external');
  const detail = await anon.get(`${store}/marketplace/products/${affiliate.handle}`);
  assert.ok(detail.data.externalOffer?.path.startsWith('/go/'));
  assert.match(detail.data.externalOffer.notice, /redirigido/);
  // Si el afiliado tiene variante (datos migrados de la v0.1), el carrito la rechaza.
  const variant = detail.data.variants[0];
  if (variant) {
    const buyer = await customer('afiliado@prueba.local');
    const cart = await buyer.post(`${store}/carts`, { currencyCode: 'PYG' });
    const blocked = await buyer.post(`${store}/carts/${cart.data.id}/line-items`, { variantId: variant.id, quantity: 1 });
    assert.equal(blocked.status, 409);
  }
  // La ficha del marketplace de un afiliado apunta como canónica a la ficha editorial.
  const html = await (await fetch(`${origin}/producto/${affiliate.handle}`)).text();
  assert.match(html, new RegExp(`rel="canonical" href="[^"]*-${affiliate.id}"`));
});

test('postback de afiliación: sin firma válida no hay conversión; con firma queda pendiente', async () => {
  const body = JSON.stringify({ conversionId: 'NET-TEST-1', saleAmount: 10000, commission: 800, currency: 'USD' });
  const unsigned = await fetch(`${store}/affiliate/postbacks/net-amazon`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(unsigned.status, 422);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', POSTBACK_SECRET).update(`${timestamp}.${body}`).digest('hex');
  const signed = await fetch(`${store}/affiliate/postbacks/net-amazon`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ndivepa-Timestamp': timestamp, 'X-Ndivepa-Signature': signature }, body,
  });
  assert.equal(signed.status, 200);
  const data = await signed.json();
  assert.equal(data.status, 'pending', 'la conversión no se da por aprobada');
});

test('comunidad: preguntas, respuestas, seguidores, feed y reportes a moderación', async () => {
  const { buyer, seller, staff: staffHttp } = shared;
  const question = await buyer.post(`${store}/community/questions`, { productId: shared.productId, body: '¿Viene con soga para colgar?' });
  assert.equal(question.status, 201);
  const answer = await seller.post(`${store}/community/seller/${shared.sellerId}/questions/${question.data.id}/answer`, { body: 'Sí, incluye dos sogas.' });
  assert.equal(answer.status, 200);
  const follow = await buyer.post(`${store}/community/follows`, { targetType: 'seller', targetId: shared.sellerId });
  assert.equal(follow.data.following, true);
  const post = await seller.post(`${store}/community/seller/${shared.sellerId}/posts`, { body: 'Nuevos colores esta semana.' });
  assert.equal(post.status, 201);
  const feed = await buyer.get(`${store}/community/feed?scope=following`);
  assert.ok(feed.data.data.some(item => item.type === 'seller_post'));
  const report = await buyer.post(`${store}/community/reports`, { targetType: 'post', targetId: post.data.id, reason: 'spam' });
  assert.equal(report.status, 201);
  const queue = await staffHttp.get(`${admin}/community/moderation`);
  assert.ok(queue.data.reports.some(row => row.id === report.data.id));
  const resolved = await staffHttp.post(`${admin}/community/reports/${report.data.id}/resolve`, { status: 'resolved', action: 'hidden' });
  assert.equal(resolved.status, 200);
  const hiddenFeed = await buyer.get(`${store}/community/feed?scope=following`);
  assert.ok(!hiddenFeed.data.data.some(item => item.post?.id === post.data.id), 'la publicación ocultada sale del feed');
});

test('chat comprador-tienda con antispam', async () => {
  const { buyer, seller } = shared;
  const started = await buyer.post(`${store}/community/conversations`, { sellerId: shared.sellerId, productId: shared.productId, body: 'Hola, ¿tienen en color rojo?' });
  assert.equal(started.status, 201);
  const duplicate = await buyer.post(`${store}/community/conversations/${started.data.id}/messages`, { body: 'Hola, ¿tienen en color rojo?' });
  assert.equal(duplicate.status, 409, 'mensaje duplicado bloqueado');
  const flagged = await buyer.post(`${store}/community/conversations/${started.data.id}/messages`, { body: 'mira http://a.test http://b.test http://c.test' });
  assert.equal(flagged.data.held, true, 'muchos enlaces: retenido para moderación');
  const inbox = await seller.get(`${store}/community/seller/${shared.sellerId}/conversations`);
  assert.equal(inbox.data.count, 1);
  const thread = await seller.get(`${store}/community/seller/${shared.sellerId}/conversations/${started.data.id}/messages`);
  assert.ok(!thread.data.messages.some(message => message.body.includes('http://a.test')), 'la tienda no ve el mensaje retenido');
});

test('dropshipping: el pedido genera el pedido al proveedor y su margen', async () => {
  const buyer = await customer('drop@prueba.local');
  const results = await buyer.get(`${store}/marketplace/search?model=DROPSHIPPING`);
  assert.ok(results.data.count > 0);
  const detail = await buyer.get(`${store}/marketplace/products/${results.data.data[0].handle}`);
  const cart = await buyer.post(`${store}/carts`, { currencyCode: 'PYG' });
  await buyer.post(`${store}/carts/${cart.data.id}/line-items`, { variantId: detail.data.variants[0].id, quantity: 1 });
  await buyer.post(`${store}/carts/${cart.data.id}/addresses`, { email: 'drop@prueba.local', shippingAddress: { firstName: 'D', lastName: 'P', address1: 'Calle 1', city: 'Carapeguá', countryCode: 'py' } });
  const options = await buyer.get(`${store}/carts/${cart.data.id}/shipping-options`);
  await buyer.post(`${store}/carts/${cart.data.id}/shipping-method`, { shippingOptionId: options.data.data[0].id });
  const methods = await buyer.get(`${store}/carts/${cart.data.id}/payment-methods`);
  const done = await buyer.post(`${store}/carts/${cart.data.id}/complete`, { paymentMethodId: methods.data.data.find(m => m.provider === 'cash_on_delivery').id });
  assert.equal(done.status, 201, JSON.stringify(done.data));
  const staffHttp = shared.staff;
  const supplierOrders = await staffHttp.get(`${admin}/supplier-orders?filter[orderId]=${done.data.order.id}`);
  assert.equal(supplierOrders.data.count, 1);
  const summary = await staffHttp.get(`${admin}/dropshipping/summary`);
  const row = summary.data.data.find(item => item.orders > 0);
  assert.equal(row.margin, row.sales - row.cost, 'margen = venta - costo');
  // Registrar despacho del proveedor con seguimiento lo refleja en el subpedido.
  const shipped = await staffHttp.post(`${admin}/dropshipping/supplier-orders/${supplierOrders.data.data[0].id}/send`, {});
  assert.equal(shipped.status, 200, JSON.stringify(shipped.data));
  const moved = await staffHttp.post(`${admin}/dropshipping/supplier-orders/${supplierOrders.data.data[0].id}/status`, { status: 'shipped', tracking: { carrier: 'Transportadora', trackingNumber: 'TRK-1' } });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  const order = await buyer.get(`${store}/marketplace/me/orders/${done.data.order.id}`);
  assert.equal(order.data.vendorOrders[0].status, 'shipped');
  assert.equal(order.data.vendorOrders[0].tracking.trackingNumber, 'TRK-1');
});

test('publicidad separada del ranking orgánico y siempre etiquetada', async () => {
  const { seller, staff: staffHttp } = shared;
  const start = new Date(Date.now() - 3_600_000).toISOString();
  const end = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const ad = await seller.post(`${store}/marketplace/seller/stores/${shared.sellerId}/ads`, {
    type: 'featured_product', placement: 'search', productId: shared.productId, title: 'Hamaca destacada', keywords: ['hamaca'],
    startsAt: start, endsAt: end, pricingModel: 'flat', rate: 50000,
  });
  assert.equal(ad.status, 201, JSON.stringify(ad.data));
  const notServed = await client().get(`${store}/marketplace/sponsored?placement=search&q=hamaca`);
  assert.equal(notServed.data.count, 0, 'sin revisión ni cobro no se sirve');
  await staffHttp.post(`${admin}/ad-campaigns/${ad.data.id}/review`, { decision: 'approve' });
  await staffHttp.post(`${admin}/ad-campaigns/${ad.data.id}/payment`, { amount: 50000 });
  const served = await client().get(`${store}/marketplace/sponsored?placement=search&q=hamaca`);
  assert.equal(served.data.count, 1);
  assert.equal(served.data.data[0].label, 'Patrocinado');
  const organic = await client().get(`${store}/marketplace/search?q=hamaca`);
  assert.ok(organic.data.data.every(item => !item.sponsored), 'los resultados orgánicos no llevan anuncios');
  const dashboard = await staffHttp.get(`${admin}/marketplace/dashboard`);
  assert.equal(dashboard.data.platformRevenue.advertising.confirmed, 50000);
});

test('envío por tienda: cada subpedido con su propia entrega y su tarifa', async () => {
  const buyer = await customer('envios@prueba.local');
  const cart = await buyer.post(`${store}/carts`, { currencyCode: 'PYG' });
  const cartId = cart.data.id;
  const anon = client();
  // Dos tiendas distintas en el mismo carrito.
  for (const term of ['hamaca', 'chipa']) {
    const found = (await anon.get(`${store}/marketplace/search?q=${term}`)).data.data[0];
    const detail = await anon.get(`${store}/marketplace/products/${found.handle}`);
    await buyer.post(`${store}/carts/${cartId}/line-items`, { variantId: detail.data.variants[0].id, quantity: 1 });
  }
  await buyer.post(`${store}/carts/${cartId}/addresses`, {
    email: 'envios@prueba.local',
    shippingAddress: { firstName: 'Eva', lastName: 'López', address1: 'Ruta 1 km 3', city: 'Carapeguá', countryCode: 'py', phone: '+595 984 555666' },
  });

  const groups = await buyer.get(`${store}/marketplace/carts/${cartId}/shipping-options`);
  assert.equal(groups.status, 200, JSON.stringify(groups.data));
  assert.equal(groups.data.count, 2, 'una entrega por tienda');
  assert.ok(groups.data.data.every(group => group.options.length), 'cada tienda ofrece al menos una opción');

  const incomplete = await buyer.post(`${store}/marketplace/carts/${cartId}/shipping-methods`, {
    selections: [{ group: groups.data.data[0].key, shippingOptionId: groups.data.data[0].options[0].id }],
  });
  assert.equal(incomplete.status, 409, 'no se puede dejar una tienda sin entrega');

  const selections = groups.data.data.map(group => {
    const pickup = group.options.find(option => option.mode === 'pickup');
    return { group: group.key, shippingOptionId: (pickup || group.options[0]).id, amount: (pickup || group.options[0]).amount };
  });
  const foreign = await buyer.post(`${store}/marketplace/carts/${cartId}/shipping-methods`, {
    selections: [{ group: selections[0].group, shippingOptionId: selections[1].shippingOptionId }, selections[1]],
  });
  assert.ok([409, 422].includes(foreign.status), 'una opción de otra tienda no se acepta');

  const applied = await buyer.post(`${store}/marketplace/carts/${cartId}/shipping-methods`, { selections: selections.map(({ group, shippingOptionId }) => ({ group, shippingOptionId })) });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  const expectedShipping = selections.reduce((sum, selection) => sum + selection.amount, 0);
  assert.equal(applied.data.shippingTotal, expectedShipping, 'el envío total es la suma de cada tienda');

  const methods = await buyer.get(`${store}/carts/${cartId}/payment-methods`);
  const done = await buyer.post(`${store}/carts/${cartId}/complete`, { paymentMethodId: methods.data.data.find(method => method.provider === 'cash_on_delivery').id });
  assert.equal(done.status, 201, JSON.stringify(done.data));
  const staffHttp = shared.staff;
  const vendorOrders = (await staffHttp.get(`${admin}/vendor-orders?filter[orderId]=${done.data.order.id}`)).data.data;
  assert.equal(vendorOrders.length, 2);
  for (const selection of selections) {
    const vendorOrder = vendorOrders.find(row => row.groupKey === selection.group);
    assert.ok(vendorOrder, 'el subpedido conserva su grupo');
    assert.equal(vendorOrder.shippingShare, selection.amount, 'cada tienda cobra su propio envío');
  }
});

test('devolución: solicitud, aprobación, recepción, reembolso y reverso contable', async () => {
  const { buyer, staff: staffHttp, orderId, sellerId } = shared;
  const detail = await buyer.get(`${store}/marketplace/me/orders/${orderId}`);
  const vendorOrder = detail.data.vendorOrders.find(row => row.seller?.id === sellerId);
  assert.equal(vendorOrder.status, 'delivered');
  const line = detail.data.returnable.find(item => vendorOrder.items.some(entry => entry.lineItemId === item.lineItemId));
  assert.ok(line, 'hay líneas devolvibles');

  const requested = await buyer.post(`${store}/returns/request`, {
    orderId, items: [{ lineItemId: line.lineItemId, quantity: line.quantity }], note: 'Llegó con un hilo suelto.',
  });
  assert.equal(requested.status, 201, JSON.stringify(requested.data));

  const sellerView = await shared.seller.get(`${store}/marketplace/seller/stores/${sellerId}/returns`);
  assert.equal(sellerView.data.count, 1, 'la tienda ve la devolución de su subpedido');
  const notified = await shared.seller.get(`${store}/marketplace/me/notifications`);
  assert.ok(notified.data.data.some(item => item.type === 'return_requested'));

  const stockBefore = (await shared.seller.get(`${store}/marketplace/seller/stores/${sellerId}/products/${shared.productId}`)).data.variants[0].stock;
  assert.equal((await staffHttp.post(`${admin}/returns/${requested.data.id}/approve`, {})).status, 200);
  const received = await staffHttp.post(`${admin}/returns/${requested.data.id}/receive`, {
    items: [{ lineItemId: line.lineItemId, receivedQuantity: line.quantity, condition: 'new', restock: true }],
    refund: true,
  });
  assert.equal(received.status, 200, JSON.stringify(received.data));
  assert.ok(received.data.refundAmount > 0, 'se calcula el importe a reembolsar');

  const stockAfter = (await shared.seller.get(`${store}/marketplace/seller/stores/${sellerId}/products/${shared.productId}`)).data.variants[0].stock;
  assert.equal(stockAfter, stockBefore + line.quantity, 'el stock vuelve al inventario de la tienda que vendió');

  const afterReturn = (await staffHttp.get(`${admin}/vendor-orders/${vendorOrder.id}`)).data;
  assert.equal(afterReturn.status, 'returned', 'el subpedido queda devuelto');
  const ledger = await staffHttp.get(`${admin}/ledger?filter[vendorOrderId]=${vendorOrder.id}&limit=50`);
  assert.ok(ledger.data.data.filter(row => row.status === 'reversed').length >= 2, 'los asientos se revierten');
  assert.ok(!ledger.data.data.some(row => row.type === 'seller_payable' && row.status === 'confirmed'), 'no queda importe a pagar por una venta devuelta');

  const refunds = await staffHttp.get(`${admin}/refunds?filter[orderId]=${orderId}`);
  assert.equal(refunds.data.count, 1, 'queda el reembolso registrado para procesarlo');
  const buyerView = await buyer.get(`${store}/marketplace/me/orders/${orderId}`);
  assert.equal(buyerView.data.returns[0].status, 'received');
});

test('sinónimos administrables: una palabra nueva cambia la búsqueda sin tocar código', async () => {
  const anon = client();
  const before = await anon.get(`${store}/marketplace/search?q=${encodeURIComponent('columpio')}`);
  assert.equal(before.data.count, 0, 'la palabra no encuentra nada todavía');

  const staffHttp = shared.staff;
  const tuning = await staffHttp.get(`${admin}/marketplace/search-tuning`);
  assert.equal(tuning.status, 200);
  assert.ok(tuning.data.synonyms.length > 0, 'la semilla deja sinónimos editables');
  assert.ok(tuning.data.emptySearches.some(row => row.term === 'columpio'), 'la búsqueda fallida queda registrada');

  const created = await staffHttp.post(`${admin}/search-synonyms`, { term: 'columpio', equivalents: ['hamaca'], notes: 'Sinónimo regional de hamaca.' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const after = await anon.get(`${store}/marketplace/search?q=${encodeURIComponent('columpio')}`);
  assert.ok(after.data.count > 0, 'ahora encuentra los productos equivalentes');

  await staffHttp.patch(`${admin}/search-synonyms/${created.data.id}`, { active: false });
  const disabled = await anon.get(`${store}/marketplace/search?q=${encodeURIComponent('columpio')}`);
  assert.equal(disabled.data.count, 0, 'desactivarlo lo saca del buscador');
});

test('exportaciones CSV para contabilidad y operación', async () => {
  const staffHttp = shared.staff;
  const response = await fetch(`${origin}/api/v1/admin/marketplace/exports/pedidos`, { headers: { cookie: [...staffHttp.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/csv/);
  assert.match(response.headers.get('content-disposition'), /attachment; filename="ndivepa-pedidos-/);
  const [header, ...rows] = (await response.text()).trim().split('\r\n');
  assert.equal(header, 'subpedido,pedido,fecha,tipo,tienda,estado,moneda,subtotal,envio,total,comision,pago_tienda,costo_proveedor,margen');
  assert.ok(rows.length > 0, 'exporta los subpedidos existentes');
  const anon = client();
  assert.equal((await anon.get(`${admin}/marketplace/exports/contabilidad`)).status, 401, 'la exportación exige sesión de personal');
});

test('lecturas públicas cacheadas: responden 304 sin cuerpo', async () => {
  const first = await fetch(`${origin}/api/v1/store/marketplace/home`);
  const etag = first.headers.get('etag');
  assert.ok(etag, 'la portada expone ETag');
  const second = await fetch(`${origin}/api/v1/store/marketplace/home`, { headers: { 'If-None-Match': etag } });
  assert.equal(second.status, 304);
  assert.equal((await second.text()).length, 0);
});

test('escala geográfica y mapa sin ubicaciones privadas', async () => {
  const anon = client();
  const localities = await anon.get(`${store}/marketplace/localities`);
  const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children || [])]);
  const all = flatten(localities.data.tree);
  assert.equal(all.find(row => row.code === 'carapegua').launchStatus, 'active');
  assert.equal(all.find(row => row.code === 'paraguari').launchStatus, 'coming_soon');
  const map = await anon.get(`${store}/marketplace/explore?locality=carapegua`);
  assert.equal(map.status, 200);
  assert.ok(map.data.points.every(point => Number.isFinite(point.lat)));
  const privateStore = map.data.areas.flatMap(area => area.stores).find(row => row.id === shared.sellerId);
  assert.ok(privateStore && privateStore.publicLocation === null, 'la tienda sin ubicación pública solo aparece por zona');
  const sitemap = await (await fetch(`${origin}/sitemap.xml`)).text();
  assert.match(sitemap, /\/tienda\//);
  assert.match(sitemap, /\/categoria\//);
});

test('la ficha dice cuánto cuesta y cuándo llega antes de agregar al carrito', async () => {
  const anon = client();
  const detail = await anon.get(`${store}/marketplace/products/${shared.productHandle}?locality=loc_carapegua`);
  assert.equal(detail.status, 200);
  const delivery = detail.data.delivery;
  assert.ok(delivery?.available, 'hay al menos una opción de entrega estimada');
  assert.equal(delivery.localityName, 'Carapeguá');
  const pickup = delivery.options.find(option => option.mode === 'pickup');
  assert.ok(pickup, 'el retiro en tienda aparece como opción');
  assert.equal(pickup.amount, 0, 'el retiro no cuesta nada');
  assert.ok(delivery.options.every(option => option.estimatedDaysMax !== null), 'cada opción informa su plazo');
  // Las mismas opciones que después se cobran en el checkout.
  assert.ok(delivery.options.every(option => typeof option.id === 'string' && option.id.startsWith('sopt_')));
  assert.equal(detail.data.guarantees.returnWindowDays, 30);
  assert.equal(detail.data.guarantees.storedCardData, false);

  const config = await anon.get(`${store}/marketplace/config`);
  assert.ok(config.data.trust.paymentMethods.length > 0, 'la portada puede decir cómo se paga');
  assert.ok(config.data.trust.paymentMethods.every(method => method.name && method.code));
});

test('el carrito estima el envío por tienda antes de tener dirección', async () => {
  const buyer = await customer('estimacion@prueba.local', 'Eva', 'Ruiz');
  const detail = await buyer.get(`${store}/marketplace/products/${shared.productHandle}`);
  const cart = await buyer.post(`${store}/carts`, { currencyCode: 'PYG' });
  await buyer.post(`${store}/carts/${cart.data.id}/line-items`, { variantId: detail.data.variants[0].id, quantity: 1 });

  const sinCiudad = await buyer.get(`${store}/marketplace/carts/${cart.data.id}/shipping-options`);
  assert.equal(sinCiudad.status, 200);
  const conCiudad = await buyer.get(`${store}/marketplace/carts/${cart.data.id}/shipping-options?locality=loc_carapegua`);
  assert.equal(conCiudad.status, 200);
  const group = conCiudad.data.data[0];
  assert.ok(group.options.length > 0, 'con la ciudad ya se puede mostrar el envío en el carrito');
  assert.ok(group.options.every(option => typeof option.amount === 'number'));
  assert.ok(sinCiudad.data.data[0].options.length <= group.options.length);
});

test('carrito abandonado: el enlace del recordatorio devuelve la selección', async () => {
  const buyer = await customer('rescate@prueba.local', 'Rosa', 'Cabral');
  const detail = await buyer.get(`${store}/marketplace/products/${shared.productHandle}`);
  const cart = await buyer.post(`${store}/carts`, { currencyCode: 'PYG' });
  const cartId = cart.data.id;
  await buyer.post(`${store}/carts/${cartId}/line-items`, { variantId: detail.data.variants[0].id, quantity: 1 });

  // El token vive en el registro interno; la tienda pública nunca lo expone.
  const publicCart = await buyer.get(`${store}/carts/${cartId}`);
  assert.equal(publicCart.data.recoveryToken, undefined, 'el token no sale en la vista pública');
  const record = await shared.staff.get(`${admin}/carts/${cartId}`);
  const signature = createHmac('sha256', record.data.recoveryToken).update(cartId).digest('hex').slice(0, 32);

  const falso = await buyer.post(`${store}/carts/recover`, { cart: cartId, token: 'a'.repeat(32) });
  assert.equal(falso.status, 404, 'una firma inválida no devuelve el carrito');

  const recovered = await buyer.post(`${store}/carts/recover`, { cart: cartId, token: signature });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
  assert.equal(recovered.data.status, 'active');
  assert.equal(recovered.data.items.length, 1, 'vuelve con lo que había dejado');
});

test('recordatorio de carrito abandonado: se envía una sola vez con su enlace', async () => {
  const buyer = await customer('recordatorio@prueba.local', 'Nidia', 'Ayala');
  const detail = await buyer.get(`${store}/marketplace/products/${shared.productHandle}`);
  const cart = await buyer.post(`${store}/carts`, { currencyCode: 'PYG' });
  const cartId = cart.data.id;
  await buyer.post(`${store}/carts/${cartId}/line-items`, { variantId: detail.data.variants[0].id, quantity: 1 });
  await buyer.post(`${store}/carts/${cartId}/addresses`, {
    email: 'recordatorio@prueba.local',
    shippingAddress: { firstName: 'Nidia', lastName: 'Ayala', address1: 'Calle 8', city: 'Carapeguá', countryCode: 'py' },
  });

  const staffHttp = shared.staff;
  const abandoned = await staffHttp.patch(`${admin}/carts/${cartId}`, { status: 'abandoned' });
  assert.equal(abandoned.status, 200, JSON.stringify(abandoned.data));

  await staffHttp.post(`${admin}/jobs/cart.recovery-reminder/enqueue`, {});
  const run = await staffHttp.post(`${admin}/jobs/run`, { limit: 20 });
  assert.equal(run.status, 200, JSON.stringify(run.data));

  const avisos = await staffHttp.get(`${admin}/notifications?template=cart.abandoned`);
  assert.equal(avisos.status, 200);
  assert.ok(avisos.data.data.some(row => row.entityId === cartId), 'quedó registrado el aviso de ese carrito');
  const afterFirst = await staffHttp.get(`${admin}/carts/${cartId}`);
  assert.ok(afterFirst.data.recoveryRemindedAt, 'se anota cuándo se recordó');

  // Segunda pasada: no se vuelve a insistir a la misma persona.
  const before = avisos.data.data.filter(row => row.entityId === cartId).length;
  await staffHttp.post(`${admin}/jobs/cart.recovery-reminder/enqueue`, {});
  await staffHttp.post(`${admin}/jobs/run`, { limit: 20 });
  const otraVez = await staffHttp.get(`${admin}/notifications?template=cart.abandoned`);
  assert.equal(otraVez.data.data.filter(row => row.entityId === cartId).length, before, 'un solo recordatorio por carrito');
});

test('agotado: el comprador pide aviso y se le notifica cuando vuelve el stock', async () => {
  const seller = shared.seller;
  const sellerId = shared.sellerId;
  const anon = client();

  // Un producto nuevo de la tienda, publicado y sin stock.
  const creado = await seller.post(`${store}/marketplace/seller/stores/${sellerId}/products`, {
    name: 'Manta de lana tejida a mano',
    description: 'Manta liviana, tejida en telar.',
    categoryId: shared.categoryId,
    price: 250000,
    stock: 0,
    status: 'published',
  });
  assert.equal(creado.status, 201, JSON.stringify(creado.data));
  const ficha = await anon.get(`${store}/marketplace/products/${creado.data.handle}`);
  assert.equal(ficha.data.inStock, false, 'la ficha lo muestra agotado');

  const aviso = await anon.post(`${store}/marketplace/stock-alerts`, {
    productId: creado.data.id,
    variantId: ficha.data.variants[0].id,
    email: 'espera@prueba.local',
  });
  assert.equal(aviso.status, 201, JSON.stringify(aviso.data));
  assert.equal(aviso.data.status, 'pending');
  // Pedirlo dos veces no duplica el aviso.
  const repetido = await anon.post(`${store}/marketplace/stock-alerts`, {
    productId: creado.data.id, variantId: ficha.data.variants[0].id, email: 'espera@prueba.local',
  });
  assert.equal(repetido.data.id, aviso.data.id, 'no se duplica el pedido de aviso');

  // La tienda repone.
  const repuesto = await seller.patch(`${store}/marketplace/seller/stores/${sellerId}/products/${creado.data.id}`, { stock: 4 });
  assert.equal(repuesto.status, 200, JSON.stringify(repuesto.data));

  const avisos = await shared.staff.get(`${admin}/notifications?template=stock.back`);
  assert.ok(avisos.data.data.some(row => row.entityId === creado.data.id), 'salió el aviso de reposición');
  const registro = await shared.staff.get(`${admin}/stock-alerts/${aviso.data.id}`);
  assert.equal(registro.data.status, 'notified');
  assert.ok(registro.data.notifiedAt, 'queda cuándo se avisó');
});

test('compartir y vender fuera: vista previa del enlace y catálogo para Facebook', async () => {
  // Open Graph de la ficha: es lo que Facebook y WhatsApp muestran al pegar el enlace.
  const html = await (await fetch(`${origin}/producto/${shared.productHandle}`)).text();
  assert.match(html, /<meta property="og:type" content="product">/);
  assert.match(html, /<meta property="product:price:amount" content="400000">/);
  assert.match(html, /<meta property="product:price:currency" content="PYG">/);
  assert.match(html, /<meta property="product:availability" content="(in|out of) stock">/);
  assert.match(html, /<meta property="og:site_name"/);
  assert.match(html, /<meta property="og:locale" content="es_PY">/);

  // Catálogo para tiendas de Facebook/Instagram y Google Merchant.
  const csv = await fetch(`${origin}/feeds/catalogo.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const [header, ...rows] = (await csv.text()).trim().split('\r\n');
  assert.equal(header, 'id,title,description,availability,condition,price,sale_price,link,image_link,brand,google_product_category,product_type');
  assert.ok(rows.length > 0, 'el feed lleva los productos publicados');
  assert.ok(rows.every(row => /(in stock|out of stock)/.test(row)), 'cada fila declara disponibilidad real');
  assert.ok(rows.every(row => row.includes('/producto/')), 'cada fila enlaza a su ficha');

  const xml = await fetch(`${origin}/feeds/catalogo.xml`);
  assert.equal(xml.status, 200);
  const body = await xml.text();
  assert.match(body, /xmlns:g="http:\/\/base\.google\.com\/ns\/1\.0"/);
  assert.match(body, /<g:price>400000 PYG<\/g:price>/);
  // Los afiliados se compran en otro sitio: no se anuncian como catálogo propio.
  const afiliado = (await client().get(`${store}/marketplace/search?q=auriculares&model=AFILIADO`)).data.data[0];
  if (afiliado) assert.ok(!body.includes(`<g:id>${afiliado.id}</g:id>`), 'el feed no incluye productos afiliados');
});

test('el panel de la tienda avisa qué publicaciones se pueden mejorar', async () => {
  const seller = shared.seller;
  const sellerId = shared.sellerId;
  // Publicación pobre a propósito: sin foto, descripción corta y sin entrega.
  const floja = await seller.post(`${store}/marketplace/seller/stores/${sellerId}/products`, {
    name: 'Bolso simple',
    description: 'Bolso.',
    categoryId: shared.categoryId,
    price: 90000,
    stock: 2,
    status: 'published',
  });
  assert.equal(floja.status, 201, JSON.stringify(floja.data));

  const panel = await seller.get(`${store}/marketplace/seller/stores/${sellerId}/dashboard?days=30`);
  assert.equal(panel.status, 200);
  const quality = panel.data.quality;
  assert.ok(quality.reviewed > 0, 'revisa las publicaciones activas');
  assert.ok(quality.counts.sinDescripcion >= 1, 'detecta la descripción demasiado corta');
  assert.ok(quality.counts.sinFoto >= 1, 'detecta la publicación sin foto');
  assert.ok(
    quality.issues.sinDescripcion.some(item => item.id === floja.data.id),
    'nombra el producto concreto que hay que arreglar',
  );
  assert.equal(quality.pending, Object.values(quality.counts).reduce((sum, count) => sum + count, 0));

  // El catálogo de esa tienda, para publicarlo en su página de Facebook.
  const code = (await seller.get(`${store}/marketplace/seller/stores/${sellerId}`)).data.code;
  const feed = await fetch(`${origin}/feeds/catalogo.csv?tienda=${encodeURIComponent(code)}`);
  assert.equal(feed.status, 200);
  const filas = (await feed.text()).trim().split('\r\n').slice(1);
  assert.ok(filas.length > 0, 'la tienda tiene su propio catálogo');
  assert.ok(filas.some(row => row.includes(floja.data.handle)), 'incluye sus productos publicados');
  assert.equal((await fetch(`${origin}/feeds/catalogo.csv?tienda=no-existe`)).status, 404);
});
