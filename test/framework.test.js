/**
 * Pruebas de las piezas del framework que se corrigieron y que no se pueden
 * observar desde HTTP sin montar todo el servidor.
 *
 * Cada bloque protege un defecto concreto que existió: si alguien revierte la
 * corrección, falla aquí y no en producción.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { Store } from '../src/framework/store.js';
import { loadConfig } from '../src/framework/config.js';
import { assertCsrf, serveStatic } from '../src/framework/http/middlewares.js';
import { safeRequestId } from '../src/framework/http/context.js';

/** Carpeta temporal por prueba: ninguna toca el documento del repositorio. */
async function withTempDir(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ndivepa-unit-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Respuesta HTTP mínima sobre un `Writable` de verdad.
 *
 * Tiene que ser un flujo real: `serveStatic` envía el fichero con
 * `stream.pipeline`, que espera los eventos de un `Writable`. Un doble con
 * métodos sueltos deja la promesa sin resolver y la prueba colgada.
 */
class FakeResponse extends Writable {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = {};
    this.headersSent = false;
    this.chunks = [];
  }

  _write(chunk, _encoding, done) {
    this.chunks.push(Buffer.from(chunk));
    done();
  }

  writeHead(status, headers = {}) {
    this.statusCode = status;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
    return this;
  }

  setHeader(name, value) { this.headers[name] = value; }

  get body() { return Buffer.concat(this.chunks).toString('utf8'); }
}

const fakeResponse = () => new FakeResponse();

// --- Store ------------------------------------------------------------------

test('el documento se guarda de forma atómica y sin dejar temporales', async () => {
  await withTempDir(async directory => {
    const store = new Store({ file: join(directory, 'db.json'), snapshotDir: join(directory, 'snapshots') });
    store.declare('items');
    await store.load();
    await store.transaction(state => state.items.push({ id: 'a' }));

    const written = JSON.parse(await readFile(join(directory, 'db.json'), 'utf8'));
    assert.deepEqual(written.items, [{ id: 'a' }]);
    // El temporal lleva el PID y debe desaparecer con el `rename`.
    await assert.rejects(readFile(store.tempFile, 'utf8'));
  });
});

test('el temporal es propio del proceso, para no pisar otra instancia', async () => {
  await withTempDir(async directory => {
    const store = new Store({ file: join(directory, 'db.json') });
    assert.match(store.tempFile, new RegExp(`db\\.json\\.${process.pid}\\.[0-9a-f-]{36}\\.tmp$`));
  });
});

test('en producción el documento se guarda compacto', async () => {
  await withTempDir(async directory => {
    const compact = new Store({ file: join(directory, 'db.json'), pretty: false });
    compact.declare('items');
    await compact.load();
    await compact.transaction(state => state.items.push({ id: 'a' }));
    const raw = await readFile(join(directory, 'db.json'), 'utf8');
    assert.ok(!raw.includes('\n  "'), 'el documento compacto no debe llevar sangría');

    const pretty = new Store({ file: join(directory, 'pretty.json'), pretty: true });
    pretty.declare('items');
    await pretty.load();
    await pretty.transaction(state => state.items.push({ id: 'a' }));
    assert.match(await readFile(join(directory, 'pretty.json'), 'utf8'), /\n {2}"/);
  });
});

test('una transacción que falla no deja nada escrito', async () => {
  await withTempDir(async directory => {
    const store = new Store({ file: join(directory, 'db.json') });
    store.declare('items');
    await store.load();
    await store.transaction(state => state.items.push({ id: 'a' }));

    await assert.rejects(store.transaction(state => {
      state.items.push({ id: 'b' });
      throw new Error('fallo de dominio');
    }), /fallo de dominio/);

    assert.deepEqual(store.read().items, [{ id: 'a' }]);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'db.json'), 'utf8')).items, [{ id: 'a' }]);
  });
});

test('un documento corrupto se recupera desde el snapshot con checksum válido', async () => {
  await withTempDir(async directory => {
    const file = join(directory, 'db.json');
    const snapshotDir = join(directory, 'snapshots');
    const first = new Store({ file, snapshotDir, logger: null });
    first.declare('items');
    await first.load();
    await first.transaction(state => state.items.push({ id: 'importante' }));
    await first.snapshot('manual');

    await writeFile(file, '{ esto no es json');

    const recovered = new Store({ file, snapshotDir, logger: null });
    recovered.declare('items');
    await recovered.load();
    assert.deepEqual(recovered.read().items, [{ id: 'importante' }]);
  });
});

// --- Configuración -----------------------------------------------------------

test('el catálogo de demostración no se siembra en producción', () => {
  assert.equal(loadConfig({ NODE_ENV: 'development' }).seed.demo, true);
  assert.equal(loadConfig({ NODE_ENV: 'production', INITIAL_ADMIN_PASSWORD: 'ContrasenaLargaDePrueba' }).seed.demo, false);
  // Una instalación puede pedirlo a propósito, por ejemplo para una demostración.
  assert.equal(loadConfig({ NODE_ENV: 'production', SEED_DEMO: 'true', INITIAL_ADMIN_PASSWORD: 'ContrasenaLargaDePrueba' }).seed.demo, true);
});

test('los interruptores de funcionalidad tienen un valor por defecto usable', () => {
  const config = loadConfig({});
  assert.equal(config.features.graphql, true, 'GraphQL está documentado como disponible');
  assert.equal(loadConfig({ FEATURE_GRAPHQL: 'false' }).features.graphql, false);
});

test('una configuración inválida detiene el arranque en vez de degradarse', () => {
  assert.throws(() => loadConfig({ PORT: '70000' }), /Configuración inválida/);
  assert.throws(() => loadConfig({ PUBLIC_BASE_URL: 'ftp://x' }), /Configuración inválida/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://x.com', INITIAL_ADMIN_PASSWORD: 'ContrasenaLargaDePrueba' }), /HTTPS/);
  assert.throws(() => loadConfig({ INITIAL_ADMIN_PASSWORD: 'corta' }), /al menos 12/);
});

// --- CSRF --------------------------------------------------------------------

function csrfContext({ cookies = {}, header = null, session = null, apiKey = null, method = 'POST' }) {
  const config = loadConfig({});
  return {
    method,
    cookies,
    session,
    apiKey,
    body: {},
    config,
    req: { headers: header ? { [config.security.csrfHeader]: header } : {} },
  };
}

test('una sesión de cookie sin token CSRF se rechaza aunque falte la cookie del token', () => {
  const config = loadConfig({});
  // El defecto corregido: con sesión válida y sin cookie CSRF, la comprobación
  // salía por la puerta de atrás y la mutación se aceptaba sin token.
  assert.throws(
    () => assertCsrf(csrfContext({ cookies: { [config.session.cookieName]: 'sesion' }, session: { id: 's1' } })),
    /CSRF/,
  );
  // También para la sesión de cliente de tienda, que no pasa por `ctx.session`.
  assert.throws(
    () => assertCsrf(csrfContext({ cookies: { [config.session.customerCookieName]: 'token' } })),
    /CSRF/,
  );
});

test('el token CSRF válido pasa y el que no coincide se rechaza', () => {
  const config = loadConfig({});
  const cookies = { [config.session.cookieName]: 'sesion', [config.security.csrfCookie]: 'token-correcto' };
  assert.doesNotThrow(() => assertCsrf(csrfContext({ cookies, header: 'token-correcto', session: { id: 's1' } })));
  assert.throws(() => assertCsrf(csrfContext({ cookies, header: 'otro-token', session: { id: 's1' } })), /CSRF/);
});

test('sin credenciales de cookie no se exige CSRF, y con clave de API tampoco', () => {
  assert.doesNotThrow(() => assertCsrf(csrfContext({})));
  assert.doesNotThrow(() => assertCsrf(csrfContext({ cookies: { ndivepa_csrf: 'x' }, apiKey: { id: 'k1' } })));
  assert.doesNotThrow(() => assertCsrf(csrfContext({ method: 'GET', cookies: { ndivepa_session: 's' }, session: { id: 's1' } })));
});

// --- Identificador de correlación -------------------------------------------

test('el identificador de correlación del cliente se acepta solo si es seguro', () => {
  assert.equal(safeRequestId('req_abc-123.4'), 'req_abc-123.4');
  assert.equal(safeRequestId('con espacio'), null);
  // Un salto de línea en una cabecera de respuesta es inyección de cabeceras.
  assert.equal(safeRequestId('abc\r\nX-Inyectada: 1'), null);
  assert.equal(safeRequestId(''), null);
  assert.equal(safeRequestId(undefined), null);
  assert.equal(safeRequestId('a'.repeat(200)).length, 80);
});

// --- Estáticos ---------------------------------------------------------------

test('el servidor de estáticos bloquea el recorrido de directorios', async () => {
  await withTempDir(async directory => {
    await writeFile(join(directory, 'ok.txt'), 'contenido');
    const res = fakeResponse();
    const served = await serveStatic({ method: 'GET', headers: {} }, res, {
      pathname: '/../../secreto.txt',
      root: directory,
    });
    assert.equal(served, true);
    assert.equal(res.statusCode, 403);
  });
});

test('una ruta mal codificada devuelve 400, no un error interno', async () => {
  await withTempDir(async directory => {
    const res = fakeResponse();
    const served = await serveStatic({ method: 'GET', headers: {} }, res, { pathname: '/%E0%A4%A', root: directory });
    assert.equal(served, true);
    assert.equal(res.statusCode, 400);
  });
});

test('un byte nulo en la ruta se rechaza antes de tocar el disco', async () => {
  await withTempDir(async directory => {
    const res = fakeResponse();
    const served = await serveStatic({ method: 'GET', headers: {} }, res, { pathname: '/ok.txt%00.png', root: directory });
    assert.equal(served, true);
    assert.equal(res.statusCode, 400);
  });
});

test('el servidor de estáticos responde el fichero, el 304 y el rango pedido', async () => {
  await withTempDir(async directory => {
    await writeFile(join(directory, 'datos.txt'), '0123456789');

    const full = fakeResponse();
    assert.equal(await serveStatic({ method: 'GET', headers: {} }, full, { pathname: '/datos.txt', root: directory }), true);
    assert.equal(full.statusCode, 200);
    assert.equal(full.headers['Content-Length'], '10');
    assert.equal(full.body, '0123456789');

    const conditional = fakeResponse();
    await serveStatic({ method: 'GET', headers: { 'if-none-match': full.headers.ETag } }, conditional, {
      pathname: '/datos.txt', root: directory,
    });
    assert.equal(conditional.statusCode, 304);

    const partial = fakeResponse();
    await serveStatic({ method: 'GET', headers: { range: 'bytes=2-5' } }, partial, {
      pathname: '/datos.txt', root: directory,
    });
    assert.equal(partial.statusCode, 206);
    assert.equal(partial.headers['Content-Range'], 'bytes 2-5/10');
    assert.equal(partial.body, '2345');

    // Rango por sufijo: los últimos bytes, no los primeros.
    const suffix = fakeResponse();
    await serveStatic({ method: 'GET', headers: { range: 'bytes=-3' } }, suffix, {
      pathname: '/datos.txt', root: directory,
    });
    assert.equal(suffix.statusCode, 206);
    assert.equal(suffix.headers['Content-Range'], 'bytes 7-9/10');
    assert.equal(suffix.body, '789');

    // Sufijo mayor que el fichero: se devuelve el fichero completo.
    const wholeBySuffix = fakeResponse();
    await serveStatic({ method: 'GET', headers: { range: 'bytes=-99' } }, wholeBySuffix, {
      pathname: '/datos.txt', root: directory,
    });
    assert.equal(wholeBySuffix.body, '0123456789');

    const unsatisfiable = fakeResponse();
    await serveStatic({ method: 'GET', headers: { range: 'bytes=99-' } }, unsatisfiable, {
      pathname: '/datos.txt', root: directory,
    });
    assert.equal(unsatisfiable.statusCode, 416);

    const head = fakeResponse();
    await serveStatic({ method: 'HEAD', headers: {} }, head, { pathname: '/datos.txt', root: directory });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '', 'HEAD no lleva cuerpo');
  });
});

test('un fichero inexistente deja pasar la petición al siguiente manejador', async () => {
  await withTempDir(async directory => {
    const res = fakeResponse();
    assert.equal(await serveStatic({ method: 'GET', headers: {} }, res, { pathname: '/no-existe.txt', root: directory }), false);
    assert.equal(res.headersSent, false);
  });
});
