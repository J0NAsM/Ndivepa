import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 4397;
const origin = `http://127.0.0.1:${port}`;
let server;
let adminSession;

// La suite arranca con su propio `DATA_DIR` en una carpeta temporal.
//
// Antes leía y restauraba `data/db.json` del repositorio: en una instalación
// nueva ese fichero no existe y el `before` fallaba, tumbando las veinte
// pruebas; y cuando existía, la suite escribía sobre los datos reales de quien
// estuviera desarrollando. Con una carpeta propia el arranque en frío es parte
// de lo que se prueba: migraciones, semilla y catálogo de demostración incluidos.
let dataDir;

async function waitForServer() {
  let lastError;
  // El arranque en frío inicializa módulos, migraciones y la semilla. En equipos
  // lentos puede tardar más de tres segundos, así que el contrato de prueba da
  // margen suficiente sin ocultar un bloqueo real.
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/products`);
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw lastError || new Error('El servidor de prueba no inició.');
}

function sessionCookie(response, csrfToken) {
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  const match = setCookies.join('; ').match(/ndivepa_session=([^;]+)/);
  assert.ok(match, 'el inicio de sesión debe emitir la cookie de sesión');
  return `ndivepa_session=${match[1]}; ndivepa_csrf=${csrfToken}`;
}

async function login() {
  if (adminSession) return adminSession;
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@ndivepa.local', password: 'Ndivepa2026!' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.csrfToken);
  adminSession = {
    csrfToken: body.csrfToken,
    cookie: sessionCookie(response, body.csrfToken),
    headers: { 'Content-Type': 'application/json', cookie: sessionCookie(response, body.csrfToken), 'X-Ndivepa-Csrf': body.csrfToken },
  };
  return adminSession;
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ndivepa-test-'));
  server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_BASE_URL: origin,
      DATA_DIR: dataDir,
      SNAPSHOT_DIR: join(dataDir, 'snapshots'),
      // Los trabajos periódicos no aportan nada a las pruebas HTTP y su tick
      // introduce escrituras que no controla ninguna prueba.
      JOBS_ENABLED: 'false',
    },
    stdio: 'ignore',
  });
  await waitForServer();
});

after(async () => {
  if (server && !server.killed) server.kill();
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

test('expone catálogo público con cabeceras de seguridad', async () => {
  const response = await fetch(`${origin}/api/products`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy') || '', /default-src/);
  assert.ok((await response.json()).length > 0);
});

test('aplica una caché prudente a los recursos estáticos', async () => {
  const response = await fetch(`${origin}/analytics.css`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /max-age=3600/);
});

test('expone salud y métricas Prometheus sin autenticar el panel', async () => {
  const health = await fetch(`${origin}/healthz`);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const metrics = await fetch(`${origin}/metrics`);
  assert.match(metrics.headers.get('content-type') || '', /text\/plain/);
  assert.match(await metrics.text(), /ndivepa_http_requests_total/);
});

test('expone catálogo mediante GraphQL con validación del esquema', async () => {
  const response = await fetch(`${origin}/api/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '{ products(limit: 1) { count data { id name } } }' }) });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.ok(result.data.products.count > 0);
  assert.ok(result.data.products.data[0].id);
});

test('protege el resumen GraphQL administrativo', async () => {
  const anonymous = await fetch(`${origin}/api/v1/admin/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '{ adminSummary { products } }' }) });
  assert.equal(anonymous.status, 401);
  const session = await login();
  const response = await fetch(`${origin}/api/v1/admin/graphql`, { method: 'POST', headers: session.headers, body: JSON.stringify({ query: '{ adminSummary { products orders customers } }' }) });
  const result = await response.json();
  assert.ok(result.data.adminSummary.products > 0);
});

test('muestra el estado de conectores sin exponer secretos', async () => {
  const session = await login();
  const response = await fetch(`${origin}/api/v1/admin/integrations`, { headers: { cookie: session.cookie } });
  const integrations = await response.json();
  assert.equal(response.status, 200);
  assert.equal(integrations.payment.configured, false);
  assert.equal('apiKey' in integrations.payment, false);
});

test('protege el descubrimiento de oportunidades como función administrativa', async () => {
  const response = await fetch(`${origin}/api/v1/admin/affiliate-opportunities`);
  assert.equal(response.status, 401);
  const session = await login();
  const invalidGeo = await fetch(`${origin}/api/v1/admin/affiliate-opportunities?geo=Paraguay`, { headers: { cookie: session.cookie } });
  assert.equal(invalidGeo.status, 422);
  const invalidLimit = await fetch(`${origin}/api/v1/admin/affiliate-opportunities?limit=101`, { headers: { cookie: session.cookie } });
  assert.equal(invalidLimit.status, 422);
});

test('protege los eventos administrativos y permite al administrador autenticado', async () => {
  const blocked = await fetch(`${origin}/api/admin/events`);
  assert.equal(blocked.status, 401);
  const session = await login();
  const events = await fetch(`${origin}/api/admin/events`, { headers: { cookie: session.cookie } });
  assert.equal(events.status, 200);
  assert.ok(Array.isArray(await events.json()));
});

test('genera una ficha indexable, sitemap y robots dinámicos', async () => {
  const product = await (await fetch(`${origin}/api/products`)).json().then(items => items[0]);
  const slug = `${product.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${product.id}`;
  const page = await fetch(`${origin}/producto/${slug}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /application\/ld\+json/);
  assert.match(html, /rel="canonical"/);
  const sitemap = await (await fetch(`${origin}/sitemap.xml`)).text();
  assert.match(sitemap, new RegExp(product.id));
  const robots = await (await fetch(`${origin}/robots.txt`)).text();
  assert.match(robots, /Sitemap:/);
});

test('presenta campañas activas sin alterar el destino de los productos', async () => {
  const response = await fetch(`${origin}/campana/TEC-2026`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Tecnología para trabajar mejor/);
  assert.match(html, /\/producto\//);
});

test('valida enlaces afiliados sin modificar datos ni aceptar destinos inseguros', async () => {
  const session = await login();
  const validation = await fetch(`${origin}/api/admin/links/validate`, { method: 'POST', headers: session.headers, body: JSON.stringify({ affiliateUrl: 'http://localhost/private', merchantId: 'mer-amazon', programId: 'prog-amazon' }) });
  assert.equal(validation.status, 200);
  const result = await validation.json();
  assert.equal(result.status, 'invalid');
  assert.equal(result.policy, 'invalid');
});

test('protege la carga de imágenes y rechaza contenido que no es una imagen real', async () => {
  const anonymous = await fetch(`${origin}/api/admin/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'data:image/png;base64,AA==' }) });
  assert.equal(anonymous.status, 401);
  const session = await login();
  const invalid = await fetch(`${origin}/api/admin/uploads`, { method: 'POST', headers: session.headers, body: JSON.stringify({ data: 'data:image/png;base64,AA==' }) });
  assert.equal(invalid.status, 422);
});

test('registra y redirige un enlace afiliado válido sin alterar el destino configurado', async () => {
  const session = await login();
  const links = await (await fetch(`${origin}/api/admin/links`, { headers: { cookie: session.cookie } })).json();
  const link = links.find(item => item.status === 'valid');
  assert.ok(link);
  const response = await fetch(`${origin}/go/${link.id}?sid=test-redirect&source=test`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), link.affiliateUrl);
});

test('redirige sin registrar eventos cuando el visitante rechaza la analítica', async () => {
  const session = await login();
  const links = await (await fetch(`${origin}/api/admin/links`, { headers: { cookie: session.cookie } })).json();
  const link = links.find(item => item.status === 'valid');
  const before = (await (await fetch(`${origin}/api/admin/events`, { headers: { cookie: session.cookie } })).json()).length;
  const response = await fetch(`${origin}/go/${link.id}?consent=0`, { redirect: 'manual' });
  const after = (await (await fetch(`${origin}/api/admin/events`, { headers: { cookie: session.cookie } })).json()).length;
  assert.equal(response.status, 302);
  assert.equal(after, before);
});

test('ofrece el aviso técnico de privacidad sin indexarlo', async () => {
  const response = await fetch(`${origin}/privacidad.html`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /name="robots" content="noindex,nofollow"/);
  assert.match(html, /Revisión antes de publicar/);
});

test('usa sesiones opacas de cliente y no acepta un ID de cliente como cookie', async () => {
  const email = `cliente-${Date.now()}@example.test`;
  const registered = await fetch(`${origin}/api/v1/store/customers/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'UnaClaveSegura2026!', firstName: 'Cliente' }),
  });
  assert.equal(registered.status, 201);

  const loginResponse = await fetch(`${origin}/api/v1/store/customers/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'UnaClaveSegura2026!' }),
  });
  assert.equal(loginResponse.status, 200);
  const loginBody = await loginResponse.json();
  assert.ok(loginBody.csrfToken);
  const cookies = (typeof loginResponse.headers.getSetCookie === 'function'
    ? loginResponse.headers.getSetCookie()
    : [loginResponse.headers.get('set-cookie') || '']).join('; ');
  const token = /ndivepa_customer=([^;]+)/.exec(cookies)?.[1];
  assert.ok(token);
  assert.notEqual(token, loginBody.customer.id);

  const profile = await fetch(`${origin}/api/v1/store/customers/me`, { headers: { cookie: `ndivepa_customer=${token}` } });
  assert.equal((await profile.json()).customer.id, loginBody.customer.id);
  const forged = await fetch(`${origin}/api/v1/store/customers/me`, { headers: { cookie: `ndivepa_customer=${loginBody.customer.id}` } });
  assert.equal((await forged.json()).customer, null);
});

test('crea una organización B2B y asigna al cliente creador como propietario', async () => {
  const email = `empresa-${Date.now()}@example.test`;
  await fetch(`${origin}/api/v1/store/customers/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'UnaClaveSegura2026!', firstName: 'Comprador' }),
  });
  const loginResponse = await fetch(`${origin}/api/v1/store/customers/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'UnaClaveSegura2026!' }),
  });
  const login = await loginResponse.json();
  const cookies = (typeof loginResponse.headers.getSetCookie === 'function' ? loginResponse.headers.getSetCookie() : [loginResponse.headers.get('set-cookie') || '']).join('; ');
  const customerToken = /ndivepa_customer=([^;]+)/.exec(cookies)?.[1];
  const cookie = `ndivepa_customer=${customerToken}; ndivepa_csrf=${login.csrfToken}`;
  const headers = { 'Content-Type': 'application/json', cookie, 'X-Ndivepa-Csrf': login.csrfToken };
  const created = await fetch(`${origin}/api/v1/store/b2b/companies`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'Empresa de prueba', handle: `empresa-${Date.now()}`, currencyCode: 'USD', approvalThreshold: 10000 }),
  });
  assert.equal(created.status, 201);
  const company = await created.json();
  const memberships = await fetch(`${origin}/api/v1/store/b2b/me`, { headers: { cookie } });
  const data = (await memberships.json()).data;
  assert.equal(data.find(member => member.companyId === company.id)?.role, 'owner');
});

test('exige CSRF para mutaciones autenticadas y rechaza campos desconocidos', async () => {
  const session = await login();
  const missingToken = await fetch(`${origin}/api/admin/links/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: session.cookie },
    body: JSON.stringify({ affiliateUrl: 'https://example.com', merchantId: 'mer-amazon', programId: 'prog-amazon' }),
  });
  assert.equal(missingToken.status, 403);

  const products = await (await fetch(`${origin}/api/admin/products`, { headers: { cookie: session.cookie } })).json();
  const rejectedField = await fetch(`${origin}/api/admin/products/${products[0].id}`, {
    method: 'PATCH',
    headers: session.headers,
    body: JSON.stringify({ unexpected: true }),
  });
  assert.equal(rejectedField.status, 422);
});

test('expone OPTIONS y 405 con los métodos permitidos', async () => {
  const preflight = await fetch(`${origin}/api/products`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('allow') || '', /GET/);

  const invalidMethod = await fetch(`${origin}/api/products`, { method: 'PUT' });
  assert.equal(invalidMethod.status, 405);
  assert.match(invalidMethod.headers.get('allow') || '', /GET/);
});

test('limita intentos repetidos de inicio de sesión', async () => {
  for (let attempt = 0; attempt < 9; attempt += 1) await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@ndivepa.local', password: 'incorrecta' }) });
  const limited = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@ndivepa.local', password: 'incorrecta' }) });
  assert.equal(limited.status, 429);
});

test('rechaza de forma segura enlaces de redirección desconocidos', async () => {
  const response = await fetch(`${origin}/go/enlace-inexistente`, { redirect: 'manual' });
  assert.equal(response.status, 404);
});

test('el catálogo de demostración cumple las reglas de publicación afiliada', async () => {
  const session = await login();
  const products = await (await fetch(`${origin}/api/products`)).json();
  assert.ok(products.length >= 4, 'la demo publica varios productos');

  const links = await (await fetch(`${origin}/api/admin/links`, { headers: { cookie: session.cookie } })).json();
  assert.equal(links.filter(link => link.status === 'invalid').length, 0, 'ningún enlace sembrado es inválido');

  // La regla del dominio: un producto afiliado publicado necesita un enlace usable.
  for (const product of products) {
    const own = links.filter(link => link.productId === product.id);
    assert.ok(own.length, `${product.name} se publicó sin ningún enlace`);
    assert.ok(own.some(link => link.status === 'valid' || link.status === 'warning'), `${product.name} solo tiene enlaces inválidos`);
  }
});

test('el resumen separa la venta atribuida de la comisión y de lo cobrado', async () => {
  const session = await login();
  const summary = await (await fetch(`${origin}/api/affiliate-summary`, { headers: { cookie: session.cookie } })).json();

  assert.ok(summary.productViews > 0, 'la demo registra vistas');
  assert.ok(summary.affiliateClicks > 0, 'la demo registra clics');
  assert.ok(summary.ctr > 0, 'con vistas y clics el CTR no puede ser cero');
  // La regla de negocio del proyecto: una venta atribuida no es ingreso propio.
  assert.ok('attributedSales' in summary.revenueSeparation);
  assert.ok('ownIncomeConfirmed' in summary.revenueSeparation);
  assert.ok('pendingNotIncome' in summary.revenueSeparation);
  assert.notEqual(summary.revenueSeparation.attributedSales, summary.revenueSeparation.ownIncomeConfirmed);
});

test('una comisión aprobada lleva importe estimado, no cero', async () => {
  const session = await login();
  const commissions = await (await fetch(`${origin}/api/admin/commissions`, { headers: { cookie: session.cookie } })).json();
  assert.ok(commissions.length, 'la demo aprueba al menos una conversión');
  // Regresión: `approve()` usaba `conversion.commission || 0` y nadie rellenaba
  // ese campo, así que toda comisión nacía con importe cero.
  assert.ok(commissions.every(commission => Number(commission.amount) > 0));
});

test('no devuelve un identificador de correlación inseguro propuesto por el cliente', async () => {
  // Valor legal como cabecera HTTP pero inaceptable como identificador: si se
  // devolviera tal cual, un valor con caracteres de control sería inyección.
  const injected = 'valor con espacios y <etiquetas>';
  const response = await fetch(`${origin}/api/products`, { headers: { 'X-Request-Id': 'valido-123' } });
  assert.equal(response.headers.get('x-request-id'), 'valido-123');

  const rejected = await fetch(`${origin}/api/products`, { headers: { 'X-Request-Id': injected } });
  const returned = rejected.headers.get('x-request-id') || '';
  assert.notEqual(returned, injected);
  assert.match(returned, /^[A-Za-z0-9._-]+$/);
});
