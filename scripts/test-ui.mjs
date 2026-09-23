/**
 * Pruebas de interfaz sobre un navegador real (M-1031).
 *
 * Arrancan el servidor con su propio `DATA_DIR` temporal, abren un navegador sin
 * ventana con emulación de celular y recorren los caminos que un usuario hace de
 * verdad: buscar con errores de tipeo, comprar, abrir una tienda y usar la app sin
 * conexión. Conducen el navegador por CDP; no hay dependencias nuevas.
 *
 * Se **omiten** (sin fallar) si no hay navegador instalado o si el runtime no trae
 * `WebSocket` global: una máquina sin navegador no debe romper la integración.
 *
 * Uso: `npm run test:ui` · `BROWSER_PATH=/ruta/al/navegador npm run test:ui`
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const PORT = Number(process.env.UI_TEST_PORT || 4402);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = join(process.cwd(), 'exports', 'ui');

const BROWSERS = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findBrowser() {
  return BROWSERS.find(path => existsSync(path)) || null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Conexión mínima al protocolo de depuración del navegador. */
async function connect(browserPath, profileDir) {
  const port = 9200 + Math.floor(Math.random() * 600);
  const process_ = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let attempt = 0; attempt < 160 && !target; attempt += 1) {
    await sleep(250);
    try {
      target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    } catch { /* el navegador sigue arrancando */ }
  }
  if (!target) throw new Error('El navegador no expuso su protocolo de depuración.');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', () => reject(new Error('No se pudo conectar al navegador.')));
  });

  let sequence = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    }
  });

  const send = (method, params = {}) => new Promise(resolve => {
    const id = sequence += 1;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });

  return {
    errors,
    send,
    async close() {
      socket.close();
      process_.kill();
    },
  };
}

/** Utilidades de página: evaluar, esperar, escribir y hacer clic. */
function page(session) {
  const evaluate = async expression => {
    const result = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) {
      throw new Error(result.result.exceptionDetails.exception?.description || 'Error al evaluar en la página.');
    }
    return result.result.result?.value;
  };
  const waitFor = async (selector, timeout = 12_000) => {
    for (let waited = 0; waited < timeout; waited += 200) {
      if (await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) return true;
      await sleep(200);
    }
    const seen = await evaluate('location.pathname + " :: " + (document.querySelector("main")?.innerText || "").slice(0, 200)');
    throw new Error(`No apareció "${selector}". Estado: ${seen}`);
  };
  const waitUntil = async (expression, message, timeout = 12_000) => {
    for (let waited = 0; waited < timeout; waited += 200) {
      if (await evaluate(expression)) return true;
      await sleep(200);
    }
    throw new Error(message);
  };
  return {
    evaluate,
    waitFor,
    waitUntil,
    goto: async path => {
      await session.send('Page.navigate', { url: `${BASE}${path}` });
      await sleep(400);
    },
    click: selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`),
    fill: (selector, value) => evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    ),
    submit: selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`),
    text: selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText || ''`),
    async screenshot(name) {
      const shot = await session.send('Page.captureScreenshot', { format: 'png' });
      await mkdir(SHOTS, { recursive: true });
      const file = join(SHOTS, `${name}.png`);
      await writeFile(file, Buffer.from(shot.result.data, 'base64'));
      return file;
    },
  };
}

async function startServer(dataDir) {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      PUBLIC_BASE_URL: BASE,
      DATA_DIR: dataDir,
      SNAPSHOT_DIR: join(dataDir, 'snapshots'),
      JOBS_ENABLED: 'false',
      RATE_WRITE_MAX: '2000',
      LOG_LEVEL: 'error',
    },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await sleep(150);
    try {
      if ((await fetch(`${BASE}/api/ready`)).ok) return server;
    } catch { /* sigue arrancando */ }
  }
  server.kill();
  throw new Error('El servidor de prueba no inició.');
}

const results = [];
async function step(name, run) {
  const startedAt = Date.now();
  await run();
  results.push({ name, ms: Date.now() - startedAt });
  console.log(`  ✔ ${name} (${Date.now() - startedAt} ms)`);
}

async function run() {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.log('Sin navegador instalado: se omiten las pruebas de interfaz (define BROWSER_PATH para forzarlo).');
    return 0;
  }
  if (typeof WebSocket === 'undefined') {
    console.log(`Node ${process.versions.node} no trae WebSocket global: se omiten las pruebas de interfaz (requiere Node 22+).`);
    return 0;
  }

  const dataDir = await mkdtemp(join(tmpdir(), 'ndivepa-ui-'));
  const profileDir = await mkdtemp(join(tmpdir(), 'ndivepa-profile-'));
  console.log(`Navegador: ${browserPath}`);
  const server = await startServer(dataDir);
  const session = await connect(browserPath, profileDir);
  const view = page(session);
  let failure = null;

  try {
    await session.send('Runtime.enable');
    await session.send('Page.enable');
    await session.send('Network.enable');
    await session.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "try { localStorage.setItem('ndv-consent', '\"granted\"'); } catch { /* modo privado */ }",
    });

    await step('la portada carga con categorías y tiendas', async () => {
      await view.goto('/');
      await view.waitFor('.hero form input');
      assert.ok((await view.text('main')).includes('Categorías'), 'la portada muestra categorías');
      assert.equal(await view.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true,
        'no hay desplazamiento horizontal en pantalla de celular');
    });

    await step('la búsqueda tolera errores de tipeo', async () => {
      await view.fill('.hero form input[name=q]', 'hamcaa poyvii');
      await view.submit('.hero form');
      await view.waitFor('.search-layout .product-card');
      assert.match(await view.text('.notice'), /Mostramos resultados para/);
    });

    await step('la ficha dice cuánto cuesta y cuándo llega antes de comprar', async () => {
      await view.click('.search-layout .product-card a.cover');
      await view.waitFor('.buybox .card');
      const buybox = await view.text('.buybox');
      assert.ok(/Entrega a/.test(buybox), 'la ficha no muestra la entrega estimada');
      assert.ok(/día|hoy/.test(buybox), 'la entrega no informa el plazo');
      assert.ok(/protegida/.test(buybox), 'la ficha no muestra las garantías de la compra');
      assert.ok(/Devoluci.n|devolver/.test(buybox), 'no se ve la política de devolución');
    });

    await step('la ficha permite agregar al carrito', async () => {
      await view.waitFor('[data-action="add-to-cart"]');
      await view.click('[data-action="add-to-cart"]');
      await view.waitUntil("document.querySelector('#toast').innerText.includes('carrito')", 'el aviso de carrito no apareció');
    });

    await step('el carrito agrupa por tienda y muestra el envío antes del checkout', async () => {
      await view.goto('/carrito');
      await view.waitFor('.line');
      const layout = await view.text('.cart-layout');
      assert.ok(layout.length > 0);
      assert.ok(/Retiro en tienda|Entrega local|Envío/.test(layout), 'el carrito no informa la entrega de cada tienda');
      assert.ok(!/Se calcula en el checkout/.test(layout), 'el envío sigue sin estimarse en el carrito');
    });

    await step('el checkout pide datos, entrega por tienda y pago', async () => {
      await view.goto('/checkout');
      await view.waitFor('[data-address]');
      const datos = { firstName: 'Ana', lastName: 'Gómez', email: 'prueba.ui@ndivepa.local', phone: '+595 981 000111', address1: 'Calle 1 casi 2' };
      for (const [name, value] of Object.entries(datos)) await view.fill(`[data-address] [name=${name}]`, value);
      await view.submit('[data-address]');
      await view.waitFor('[data-shipping] fieldset');
      await view.evaluate(`[...document.querySelectorAll('[data-shipping] fieldset')].forEach(set => {
        const input = set.querySelector('input');
        if (input) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); }
      })`);
      await view.waitFor('[data-payment]');
      await view.evaluate(`(() => {
        const input = [...document.querySelectorAll('[data-payment] input')].find(el => el.closest('label').innerText.includes('entrega'));
        if (input) input.checked = true;
      })()`);
      await view.submit('[data-payment]');
      await view.waitUntil("location.pathname === '/checkout/confirmado'", 'el checkout no llegó a la confirmación');
      assert.match(await view.text('main'), /Gracias por tu compra/);
    });

    await step('la página de una tienda muestra su reputación', async () => {
      await view.goto('/tiendas');
      await view.waitFor('.store-card');
      await view.click('.store-card');
      await view.waitFor('.store-hero');
      assert.match(await view.text('.store-hero'), /ventas entregadas/);
    });

    await step('la aplicación funciona sin conexión', async () => {
      await view.goto('/');
      await view.waitFor('.hero');
      await view.waitUntil('(async () => (await navigator.serviceWorker.getRegistrations()).length > 0)()', 'el service worker no se registró');
      await sleep(1500);
      await session.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
      await view.goto('/');
      await sleep(2000);
      assert.match(await view.text('main'), /Categorías|Ndivepa/, 'la portada no se sirvió desde la caché');
      await session.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    });

    assert.deepEqual(session.errors, [], `errores de JavaScript en la consola: ${session.errors.join(' | ')}`);
  } catch (error) {
    failure = error;
    const shot = await view.screenshot(`fallo-${Date.now()}`).catch(() => null);
    console.error(`  ✖ ${error.message}`);
    if (shot) console.error(`  Captura: ${shot}`);
  } finally {
    await session.close();
    server.kill();
    await sleep(300);
    await rm(dataDir, { recursive: true, force: true });
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${results.length} recorrido(s) verificado(s)${failure ? ', 1 con fallo' : ', sin fallos'}.`);
  return failure ? 1 : 0;
}

process.exitCode = await run();
