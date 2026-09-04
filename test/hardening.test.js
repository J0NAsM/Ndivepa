import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { loadConfig } from '../src/framework/config.js';
import { FileService, LocalFileProvider } from '../src/framework/files.js';
import { parseCookies, parseQuery, readJsonBody } from '../src/framework/http/context.js';
import { applyCors, securityHeaders, serveStatic } from '../src/framework/http/middlewares.js';
import { cookie, clearCookie, json, text, xml } from '../src/framework/http/respond.js';
import { Router } from '../src/framework/http/router.js';
import { Repository, project } from '../src/framework/repository.js';
import { Store } from '../src/framework/store.js';
import { csvCell, parseCsv, truncate, uniqueSlug } from '../src/framework/strings.js';
import { rule, validate } from '../src/framework/validate.js';
import { totp } from '../src/modules/access/index.js';
import { AffiliateLinkService, ProgramService } from '../src/modules/affiliate/index.js';
import { hostMatchesDomain, validateAffiliateLink } from '../src/modules/affiliate/link-validation.js';
import { parseApproxTraffic, parseGoogleTrendsRss, productLikelihood, TrendsDiscoveryService } from '../src/modules/affiliate/trends.js';
import { ProductService } from '../src/modules/catalog/index.js';

async function withTempDir(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ndivepa-hardening-'));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

class Response extends Writable {
  constructor(method = 'GET') {
    super();
    this.req = { method };
    this.headers = {};
    this.chunks = [];
  }
  _write(chunk, _encoding, done) { this.chunks.push(Buffer.from(chunk)); done(); }
  setHeader(name, value) { this.headers[name] = value; }
  getHeader(name) { return this.headers[name]; }
  writeHead(status, headers = {}) { this.statusCode = status; Object.assign(this.headers, headers); return this; }
  get body() { return Buffer.concat(this.chunks).toString('utf8'); }
}

function request(body, headers = {}) {
  const req = Readable.from(body === null ? [] : [Buffer.from(body)]);
  req.method = 'POST';
  req.headers = headers;
  return req;
}

test('la configuración rechaza typos en números y booleanos', () => {
  assert.throws(() => loadConfig({ PORT: 'cuatro-mil' }), /PORT/);
  assert.throws(() => loadConfig({ FEATURE_GRAPHQL: 'treu' }), /booleanas/);
  assert.throws(() => loadConfig({ JOBS_ENABLED: 'quizá' }), /booleanas/);
});

test('la configuración valida modo, zona horaria, cookies y tiempos', () => {
  assert.throws(() => loadConfig({ COMMERCE_MODE: 'marketplace' }), /COMMERCE_MODE/);
  assert.throws(() => loadConfig({ TZ_DISPLAY: 'Marte/Base' }), /TZ_DISPLAY/);
  assert.throws(() => loadConfig({ SESSION_COOKIE: 'mala cookie' }), /SESSION_COOKIE/);
  assert.throws(() => loadConfig({ SESSION_TTL_MS: '120000', SESSION_ABSOLUTE_TTL_MS: '60000' }), /no puede ser menor/);
  assert.throws(() => loadConfig({ HEADERS_TIMEOUT_MS: '40000', REQUEST_TIMEOUT_MS: '30000' }), /no puede superar/);
  assert.throws(() => loadConfig({ GOOGLE_TRENDS_GEO: 'PAR' }), /GOOGLE_TRENDS_GEO/);
});

test('la URL pública no admite credenciales, consulta ni fragmento', () => {
  assert.throws(() => loadConfig({ PUBLIC_BASE_URL: 'https://user:pass@example.com' }), /credenciales/);
  assert.throws(() => loadConfig({ PUBLIC_BASE_URL: 'https://example.com/?preview=1' }), /consulta/);
});

test('el validador convierte enteros completos, no prefijos parciales', () => {
  const schema = { amount: { type: 'integer', coerce: true, required: true } };
  assert.deepEqual(validate({ amount: '12' }, schema), { amount: 12 });
  for (const amount of ['12px', '1.9']) {
    assert.throws(() => validate({ amount }, schema), error => (
      error.issues?.some(issue => /tipo integer/.test(issue.message))
    ));
  }
});

test('el validador normaliza moneda y comprueba fechas reales', () => {
  assert.deepEqual(validate({ currency: 'pyg' }, { currency: rule.currency() }), { currency: 'PYG' });
  assert.doesNotThrow(() => validate({ date: '2028-02-29' }, { date: rule.date() }));
  assert.throws(() => validate({ date: '2026-02-30' }, { date: rule.date() }), error => (
    error.issues?.some(issue => /fecha ISO-8601 real/.test(issue.message))
  ));
  assert.throws(() => validate({ id: '__proto__.x' }, { id: rule.id() }), error => (
    error.issues?.some(issue => /identificador válido/.test(issue.message))
  ));
});

test('los valores por defecto mutables no se comparten entre validaciones', () => {
  const schema = { tags: rule.list(rule.text(), { default: [] }) };
  const first = validate({}, schema);
  first.tags.push('uno');
  assert.deepEqual(validate({}, schema), { tags: [] });
});

test('los objetos extensibles conservan metadatos sin admitir claves de prototipo', () => {
  const schema = { metadata: rule.metadata() };
  assert.deepEqual(
    validate({ metadata: { discovery: { source: 'google-trends-rss', traffic: 5000 } } }, schema),
    { metadata: { discovery: { source: 'google-trends-rss', traffic: 5000 } } },
  );
  const dangerous = JSON.parse('{"metadata":{"nested":{"__proto__":{"polluted":true}}}}');
  assert.throws(() => validate(dangerous, schema), error => (
    error.issues?.some(issue => /Clave de objeto no permitida/.test(issue.message))
  ));
  assert.equal({}.polluted, undefined);
});

test('el cuerpo JSON exige tipo, objeto y codificación identity', async () => {
  await assert.rejects(readJsonBody(request('{"ok":true}', {})), /contenido no soportado/i);
  await assert.rejects(readJsonBody(request('[]', { 'content-type': 'application/json' })), /debe ser un objeto/);
  await assert.rejects(readJsonBody(request('{}', { 'content-type': 'application/json', 'content-encoding': 'gzip' })), /contenido no soportado/i);
  await assert.rejects(readJsonBody(request('{}', { 'content-type': 'application/json', 'content-length': '-1' })), /Content-Length/);
  assert.deepEqual(await readJsonBody(request('{"ok":true}', { 'content-type': 'application/problem+json' })), { ok: true });
});

test('cookies y query se normalizan con límites y duplicados seguros', () => {
  assert.deepEqual(parseCookies('token=a%20b; token=otro; sin-igual'), { token: 'a b' });
  const query = parseQuery(new URLSearchParams('tag=a&tag=b&filter[status]=one&filter[status]=two'));
  assert.deepEqual(query.tag, ['a', 'b']);
  assert.deepEqual(query.filter.status, ['one', 'two']);
  assert.throws(() => parseQuery(new URLSearchParams('a=1&b=2'), { maxParams: 1 }), /máximo/);
});

test('el router rechaza rutas ambiguas, duplicadas y parámetros mal codificados', () => {
  const router = new Router();
  router.get('/items/:id', () => ({}), { permission: null });
  assert.throws(() => router.get('/items/:id', () => ({}), { permission: null }), /duplicada/);
  assert.throws(() => router.get('/files/*/tail', () => ({}), { permission: null }), /comodín/);
  assert.throws(() => router.resolve('GET', '/items/%E0%A4%A'), /codificado/);
  assert.throws(() => router.resolve('GET', '/items/a%2Fb'), /codificado/);
});

test('la proyección bloquea prototype pollution', () => {
  assert.throws(() => project({ id: 'a' }, ['__proto__.polluted']), /no permitido/);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(project({ id: 'a', nested: { name: 'N' } }, ['nested.name']), { nested: { name: 'N' }, id: 'a' });
});

test('un cursor inexistente falla en vez de repetir la primera página', () => {
  const state = { updatedAt: '1', items: [{ id: 'a', createdAt: '2026-01-01' }] };
  const repository = new Repository({ store: { read: () => state }, collection: 'items', prefix: 'item' });
  assert.throws(() => repository.list({ after: 'no-existe' }), /cursor no existe/);
});

test('restaurar un borrado lógico vuelve a comprobar unicidad', () => {
  const state = { updatedAt: '1', items: [
    { id: 'a', email: 'same@example.com', deletedAt: '2026-01-01' },
    { id: 'b', email: 'same@example.com', deletedAt: null },
  ] };
  const repository = new Repository({ store: { read: () => state }, collection: 'items', prefix: 'item', unique: ['email'] });
  assert.throws(() => repository.restore(state, 'a'), /Ya existe/);
  assert.throws(() => repository.restore(state, 'b'), /no está borrado/);
});

test('el CSV admite BOM, comas, comillas y saltos dentro de celdas', () => {
  const rows = parseCsv('\uFEFFname,description\r\n"Uno","línea 1\n línea 2"\r\n"Dos, más","dijo ""hola"""');
  assert.deepEqual(rows, [
    ['name', 'description'],
    ['Uno', 'línea 1\n línea 2'],
    ['Dos, más', 'dijo "hola"'],
  ]);
  assert.throws(() => parseCsv('a\n"sin cierre'), /termina dentro/);
});

test('la exportación CSV neutraliza fórmulas sin alterar números negativos', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell(-15), '-15');
});

test('slugs y truncado respetan el máximo incluso en extremos', () => {
  assert.ok(uniqueSlug('un nombre muy largo', ['un-nombre'], { maxLength: 12 }).length <= 12);
  assert.equal(truncate('abcdef', 1), '…');
  assert.equal(truncate('abcdef', 0), '');
});

const linkContext = {
  merchants: [{ id: 'm1', domains: ['shop.example.com'], status: 'active' }],
  networks: [{ id: 'n1', allowedTracking: { redirect: true, utm: true } }],
  programs: [{ id: 'p1', merchantId: 'm1', networkId: 'n1', status: 'active', requiredTrackingKey: 'tag', trackingId: 'mine' }],
};

test('los dominios se comparan por etiqueta completa y normalizada', () => {
  assert.equal(hostMatchesDomain('WWW.SHOP.EXAMPLE.COM.', '.shop.example.com.'), true);
  assert.equal(hostMatchesDomain('evilshop.example.com', 'shop.example.com'), false);
  assert.equal(hostMatchesDomain('shop.example.com.evil.test', 'shop.example.com'), false);
});

test('los enlaces afiliados bloquean credenciales, dominio y tracking ambiguo', () => {
  assert.equal(validateAffiliateLink(linkContext, { affiliateUrl: 'https://u:p@shop.example.com/?tag=mine', merchantId: 'm1', programId: 'p1' }).status, 'invalid');
  assert.equal(validateAffiliateLink(linkContext, { affiliateUrl: 'https://evil.example/?tag=mine', merchantId: 'm1', programId: 'p1' }).status, 'invalid');
  assert.equal(validateAffiliateLink(linkContext, { affiliateUrl: 'https://shop.example.com/?tag=mine&tag=other', merchantId: 'm1', programId: 'p1' }).status, 'invalid');
});

test('la URL normal también debe pertenecer al comercio', () => {
  const result = validateAffiliateLink(linkContext, {
    affiliateUrl: 'https://shop.example.com/?tag=mine',
    productUrl: 'https://phishing.example/product',
    merchantId: 'm1',
    programId: 'p1',
  });
  assert.equal(result.status, 'invalid');
});

test('el estado de un enlace se recalcula y no se puede falsificar por PATCH', async () => {
  const collections = { ...linkContext, products: [{ id: 'prod', merchantId: 'm1', programId: 'p1' }] };
  const service = new AffiliateLinkService({
    store: { collection: name => collections[name] || [] },
    events: null,
    alert: { raise: async () => {} },
    settings: {},
  });
  const base = { productId: 'prod', merchantId: 'm1', programId: 'p1', productUrl: null };
  await assert.rejects(
    () => service.beforeUpdate({ ...base, affiliateUrl: 'https://evil.example/?tag=mine', status: 'invalid' }, { status: 'valid' }),
    /no es válido/,
  );
  const result = await service.beforeUpdate(
    { ...base, affiliateUrl: 'https://shop.example.com/?tag=mine', status: 'valid' },
    { status: 'invalid' },
  );
  assert.equal(result.status, 'valid');
  assert.equal(result.validation.status, 'valid');
});

test('un producto publicado exige un enlace del mismo comercio y programa', () => {
  const links = [{ productId: 'prod', merchantId: 'm2', programId: 'p2', status: 'valid', deletedAt: null }];
  const service = {
    variants: { forProduct: () => [] },
    settings: { get: () => true },
    store: { collection: () => links },
  };
  const product = { id: 'prod', monetizationType: 'AFFILIATE', merchantId: 'm1', programId: 'p1' };
  assert.throws(() => ProductService.prototype.assertPublishable.call(service, product), error => (
    error.issues?.some(issue => /enlace del mismo comercio/.test(issue.message))
  ));
  links.push({ productId: 'prod', merchantId: 'm1', programId: 'p1', status: 'valid', deletedAt: null });
  assert.doesNotThrow(() => ProductService.prototype.assertPublishable.call(service, product));
});

test('el volumen y la probabilidad de producto se derivan sin presentar tendencias generales como productos', () => {
  assert.equal(parseApproxTraffic('50K+'), 50_000);
  assert.equal(parseApproxTraffic('1.5M+'), 1_500_000);
  assert.ok(productLikelihood('precio iphone 18') > productLikelihood('clima asunción'));
});

test('Google Trends RSS se limita, decodifica y usa caché', async () => {
  const rss = `<?xml version="1.0"?><rss><channel>
    <item><title>iphone &amp; accesorios</title><ht:approx_traffic>50K+</ht:approx_traffic>
    <pubDate>Fri, 4 Sep 2026 03:10:00 -0700</pubDate>
    <ht:news_item_title>Nuevo teléfono</ht:news_item_title></item>
    <item><title>clima</title><ht:approx_traffic>100+</ht:approx_traffic></item>
  </channel></rss>`;
  const parsed = parseGoogleTrendsRss(rss, { geo: 'PY', limit: 1 });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].query, 'iphone & accesorios');
  assert.equal(parsed[0].traffic, 50_000);
  assert.deepEqual(parsed[0].newsTitles, ['Nuevo teléfono']);

  let requests = 0;
  const config = loadConfig({});
  const service = new TrendsDiscoveryService({
    config,
    fetchImpl: async url => {
      requests += 1;
      assert.equal(url.hostname, 'trends.google.com');
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => rss };
    },
  });
  assert.equal((await service.trends({ geo: 'PY' })).cached, false);
  assert.equal((await service.trends({ geo: 'PY' })).cached, true);
  assert.equal((await service.trends({ geo: 'PY', refresh: true })).cached, true);
  assert.equal(requests, 1);
  await assert.rejects(() => service.trends({ geo: 'Paraguay' }), /código de país/);
  const disabled = new TrendsDiscoveryService({ config: loadConfig({ FEATURE_TREND_DISCOVERY: 'false' }), fetchImpl: async () => null });
  await assert.rejects(() => disabled.trends(), /desactivado/);
});

test('solo programas aprobados y verificados quedan habilitados para descubrimiento', () => {
  const collections = {
    merchants: [{ id: 'm1', name: 'Tienda', status: 'active' }],
    networks: [{ id: 'n1', name: 'Red', status: 'active' }],
  };
  const service = new ProgramService({ store: { collection: name => collections[name] || [] }, events: null });
  const program = {
    merchantId: 'm1', networkId: 'n1', status: 'active', approvalStatus: 'approved',
    credentialsVerifiedAt: '2026-09-04', autoDiscovery: true, trackingId: 'real-id', requiredTrackingKey: 'tag',
  };
  assert.equal(service.discoveryReadiness(program).eligible, true);
  assert.equal(service.discoveryReadiness({ ...program, credentialsVerifiedAt: null }).eligible, false);
  assert.equal(service.discoveryReadiness({ ...program, approvalStatus: 'pending' }).eligible, false);
});

test('TOTP usa Base32 y coincide con el vector RFC-6238', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totp.code(secret, 1), '287082');
  assert.match(totp.secret(), /^[A-Z2-7]{32}$/);
  assert.equal(totp.code('no-es-base32', 1), null);
  assert.equal(totp.verify(secret, '123'), false);
});

test('las cookies codifican valores y se eliminan también por Expires', () => {
  assert.match(cookie('session', 'a b;c', { sameSite: 'Strict' }), /^session=a%20b%3Bc;/);
  assert.match(clearCookie('session'), /Expires=Thu, 01 Jan 1970/);
  assert.throws(() => cookie('bad name', 'x'), /inválido/);
});

test('HEAD conserva Content-Length pero no escribe cuerpos de respuesta', () => {
  for (const send of [
    res => json(res, 200, { ok: true }),
    res => text(res, 200, 'hola'),
    res => xml(res, 200, '<ok/>'),
  ]) {
    const response = new Response('HEAD');
    send(response);
    assert.equal(response.body, '');
    assert.ok(Number(response.headers['Content-Length']) > 0);
  }
});

test('CORS conserva Vary y nunca combina comodín con credenciales', () => {
  const specific = new Response();
  specific.setHeader('Vary', 'Accept-Encoding');
  applyCors({ headers: { origin: 'https://app.example' } }, specific, { origins: ['https://app.example'] });
  assert.equal(specific.headers.Vary, 'Accept-Encoding, Origin');
  assert.equal(specific.headers['Access-Control-Allow-Credentials'], 'true');

  const wildcard = new Response();
  applyCors({ headers: { origin: 'https://any.example' } }, wildcard, { origins: ['*'] });
  assert.equal(wildcard.headers['Access-Control-Allow-Origin'], '*');
  assert.equal(wildcard.headers['Access-Control-Allow-Credentials'], undefined);
});

test('CSP solo fuerza upgrade de recursos en producción', () => {
  const development = new Response();
  securityHeaders(development, { isProduction: false });
  assert.doesNotMatch(development.headers['Content-Security-Policy'], /upgrade-insecure/);
  const production = new Response();
  securityHeaders(production, { isProduction: true });
  assert.match(production.headers['Content-Security-Policy'], /upgrade-insecure/);
  assert.ok(production.headers['Strict-Transport-Security']);
});

test('estáticos rechaza rangos mal formados y respeta If-Range', async () => {
  await withTempDir(async directory => {
    await writeFile(join(directory, 'data.txt'), '0123456789');
    const malformed = new Response();
    await serveStatic({ method: 'GET', headers: { range: 'bytes=1-2,5-6' } }, malformed, { pathname: '/data.txt', root: directory });
    assert.equal(malformed.statusCode, 416);

    const changed = new Response();
    await serveStatic({ method: 'GET', headers: { range: 'bytes=2-4', 'if-range': 'W/"otro"' } }, changed, { pathname: '/data.txt', root: directory });
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.body, '0123456789');
  });
});

test('If-None-Match distinto tiene precedencia sobre If-Modified-Since', async () => {
  await withTempDir(async directory => {
    await writeFile(join(directory, 'data.txt'), 'actual');
    const response = new Response();
    await serveStatic({ method: 'GET', headers: { 'if-none-match': 'W/"anterior"', 'if-modified-since': new Date(Date.now() + 86_400_000).toUTCString() } }, response, { pathname: '/data.txt', root: directory });
    assert.equal(response.statusCode, 200);
  });
});

test('el proveedor local bloquea nombres que salen de su directorio', async () => {
  await withTempDir(async directory => {
    const provider = new LocalFileProvider({ directory });
    await assert.rejects(provider.save('../escape.txt', Buffer.from('x')), /no permitido/);
    await assert.rejects(provider.read('../escape.txt'), /no permitido/);
  });
});

test('la carga rechaza PDF, base64 no canónico y estrategias desconocidas', async () => {
  await withTempDir(async directory => {
    const service = new FileService({ provider: new LocalFileProvider({ directory }), allowed: ['image/png'] });
    assert.throws(() => service.decodeDataUri('data:application/pdf;base64,JVBERi0='), /no admitido/);
    assert.throws(() => service.decodeDataUri('data:image/png;base64,abc==='), /mal formado/);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]).toString('base64');
    await assert.rejects(service.store(`data:image/png;base64,${png}`, { naming: 'desconocida' }), /no reconocida/);
  });
});

test('un documento corrupto sin snapshot detiene el arranque y conserva copia', async () => {
  await withTempDir(async directory => {
    const file = join(directory, 'db.json');
    await writeFile(file, '{roto');
    const store = new Store({ file, snapshotDir: join(directory, 'snapshots') });
    await assert.rejects(store.load(), /no existe un snapshot válido/);
    assert.equal(await readFile(`${file}.corrupto`, 'utf8'), '{roto');
  });
});

test('migraciones con huecos o documentos futuros se rechazan', async () => {
  await withTempDir(async directory => {
    const gap = new Store({ file: join(directory, 'gap.json') });
    gap.migration({ from: 1, to: 2, description: 'hueco', up: state => state });
    await assert.rejects(gap.load(), /Falta la migración/);

    const futureFile = join(directory, 'future.json');
    await writeFile(futureFile, JSON.stringify({ schemaVersion: 9 }));
    const future = new Store({ file: futureFile });
    await assert.rejects(future.load(), /más nuevo/);
  });
});

test('las migraciones asíncronas se esperan antes de persistir', async () => {
  await withTempDir(async directory => {
    const file = join(directory, 'db.json');
    const store = new Store({ file });
    store.migration({ from: 0, to: 1, description: 'async', up: async state => { await Promise.resolve(); state.ready = true; } });
    await store.load();
    assert.equal(JSON.parse(await readFile(file, 'utf8')).ready, true);
  });
});
