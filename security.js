import { Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const dbPath = join(root, 'data', 'db.json');
const uploadDir = join(root, 'public', 'uploads');
const isProduction = process.env.NODE_ENV === 'production';
const configuredBaseUrl = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const attempts = new Map();

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const escapeXml = escapeHtml;
const slug = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'oferta';
const productPath = product => `/producto/${slug(product.name)}-${product.id}`;
const baseUrl = req => configuredBaseUrl || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host || 'localhost:4300'}`;

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; upgrade-insecure-requests");
}

function limited(req, windowMs, max) {
  const key = `${req.socket.remoteAddress || 'unknown'}:${req.url?.split('?')[0] || ''}`;
  const current = attempts.get(key);
  const now = Date.now();
  const active = current && now - current.startedAt < windowMs ? current : { startedAt: now, count: 0 };
  active.count += 1;
  attempts.set(key, active);
  if (attempts.size > 2000) for (const [entryKey, entry] of attempts) if (now - entry.startedAt > windowMs) attempts.delete(entryKey);
  return active.count > max;
}

async function readDatabase() {
  try { return JSON.parse(await readFile(dbPath, 'utf8')); } catch { return null; }
}

const cookieValue = (req, name) => (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
const imageSignatures = { 'image/png': bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/jpeg': bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff, 'image/webp': bytes => bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' };

async function uploadImage(req, res) {
  const data = await readDatabase();
  const token = cookieValue(req, 'ndivepa_session');
  const session = token && globalThis.ndivepaSessions?.get(token);
  const account = session && data?.users?.find(user => user.id === session.userId && user.role === 'admin');
  if (!account) { res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'Inicia sesión como administrador para continuar.' })); return; }
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) throw Error('Solicitud demasiado grande.'); }
  let input;
  try { input = JSON.parse(raw); } catch { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'El cuerpo debe ser JSON válido.' })); return; }
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(input.data || ''));
  if (!match) { res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'Solo se admiten imágenes PNG, JPEG o WebP codificadas correctamente.' })); return; }
  const [, mime, encoded] = match;
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > 700_000 || !imageSignatures[mime](bytes)) { res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'La imagen excede el límite de 700 KB o no coincide con su tipo declarado.' })); return; }
  const extension = mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length);
  const filename = `${randomUUID()}.${extension}`;
  await mkdir(uploadDir, { recursive: true });
  await writeFile(join(uploadDir, filename), bytes, { flag: 'wx' });
  res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ url: `/uploads/${filename}`, mime, bytes: bytes.length }));
}

async function redirectWithoutTracking(res, linkId) {
  const data = await readDatabase();
  const link = data?.affiliateLinks?.find(item => item.id === linkId);
  if (!link || link.status === 'invalid') { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Enlace no disponible.'); return; }
  res.writeHead(302, { Location: link.affiliateUrl });
  res.end();
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function productPage(product, data, canonical) {
  const merchant = data.merchants?.find(item => item.id === product.merchantId);
  const category = data.categories?.find(item => item.id === product.categoryId);
  const link = data.affiliateLinks?.find(item => item.productId === product.id);
  const currency = product.price?.currency || data.settings?.currency || 'USD';
  const amount = Number(product.price?.amount);
  const hasPrice = Number.isFinite(amount) && amount >= 0;
  const offer = hasPrice ? { '@type': 'Offer', price: amount, priceCurrency: currency, availability: 'https://schema.org/InStock', url: link?.affiliateUrl || canonical, seller: merchant ? { '@type': 'Organization', name: merchant.name } : undefined } : undefined;
  const structuredData = { '@context': 'https://schema.org', '@type': 'Product', name: product.name, description: product.description || undefined, category: category?.name || undefined, image: product.image?.startsWith('http') ? product.image : undefined, offers: offer };
  const disclosure = data.settings?.affiliateDisclosure || 'Algunos enlaces son enlaces de afiliado. Podemos recibir una comisión sin costo adicional para ti.';
  const price = hasPrice ? new Intl.NumberFormat('es-PY', { style: 'currency', currency }).format(amount) : 'Consultar precio';
  const button = link?.id && link.status !== 'invalid' ? `<a class="button" href="/go/${encodeURIComponent(link.id)}?placement=plc-product-page&source=organic" rel="sponsored nofollow noopener" target="_blank">Ver oferta en ${escapeHtml(merchant?.name || 'el proveedor')} ↗</a>` : '<span class="unavailable">Oferta no disponible temporalmente</span>';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(product.name)} | Ndivepa</title><meta name="description" content="${escapeHtml(product.description || `Recomendación de ${product.name} en Ndivepa`)}"><link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:type" content="product"><meta property="og:title" content="${escapeHtml(product.name)} | Ndivepa"><meta property="og:description" content="${escapeHtml(product.description || '')}"><meta property="og:url" content="${escapeHtml(canonical)}"><meta name="twitter:card" content="summary"><script type="application/ld+json">${JSON.stringify(structuredData).replace(/</g, '\\u003c')}</script><style>body{margin:0;background:#f6f8fc;color:#15213a;font:16px/1.55 Inter,system-ui,sans-serif}.wrap{width:min(930px,calc(100% - 40px));margin:auto}.nav{padding:24px 0}.brand{color:#15213a;text-decoration:none;font-size:1.5rem;font-weight:850;letter-spacing:-.05em}.brand i{color:#6457e9;font-style:normal}.crumb{font-size:.82rem;color:#62708a;text-decoration:none}.card{display:grid;grid-template-columns:260px 1fr;gap:38px;background:#fff;border:1px solid #e5e9f0;border-radius:22px;padding:32px;box-shadow:0 14px 34px #17233b12}.visual{min-height:250px;display:grid;place-items:center;border-radius:16px;background:linear-gradient(145deg,#ebe9ff,#e5f7f0);font-size:5rem}.eyebrow{color:#6457e9;font-size:.72rem;letter-spacing:.12em;font-weight:850}.tag{display:inline-block;margin-top:9px;padding:4px 8px;border-radius:99px;background:#e8eafe;color:#4538c1;font-size:.76rem;font-weight:800}h1{font-size:clamp(2rem,5vw,3.4rem);line-height:1.05;letter-spacing:-.06em;margin:10px 0 14px}.merchant{color:#62708a;margin:0}.price{font-size:1.8rem;font-weight:850;letter-spacing:-.05em;margin:25px 0 16px}.button{display:inline-block;background:#6457e9;color:#fff;text-decoration:none;border-radius:10px;padding:12px 16px;font-weight:800}.notice{margin:22px 0 0;padding:13px 15px;border-left:3px solid #6457e9;background:#f2f1ff;color:#4b5370;font-size:.84rem}.unavailable{font-weight:750;color:#a45f00}@media(max-width:680px){.card{grid-template-columns:1fr;padding:22px;gap:20px}.visual{min-height:150px}.wrap{width:min(100% - 28px,930px)}}</style></head><body><main class="wrap"><nav class="nav"><a class="brand" href="/">Ndi<i>vepa</i></a></nav><a class="crumb" href="/">← Volver a recomendaciones</a><article class="card"><div class="visual" aria-hidden="true">${escapeHtml(product.image || '🔗')}</div><div><span class="eyebrow">RECOMENDACIÓN NDIVEPA</span><div class="tag">${escapeHtml(category?.name || 'Recomendación')}</div><h1>${escapeHtml(product.name)}</h1><p class="merchant">Vendido y gestionado por ${escapeHtml(merchant?.name || 'el proveedor externo')}</p><p>${escapeHtml(product.description || '')}</p><div class="price">${escapeHtml(price)}</div>${button}<p class="notice"><strong>Divulgación afiliada:</strong> ${escapeHtml(disclosure)}</p></div></article></main></body></html>`;
}

async function serveSeoRoute(req, res, url) {
  const data = await readDatabase();
  if (!data) return false;
  const origin = baseUrl(req);
  if (url.pathname === '/sitemap.xml') {
    const urls = (data.affiliateProducts || []).filter(item => item.status === 'published').map(item => `<url><loc>${escapeXml(`${origin}${productPath(item)}`)}</loc><lastmod>${escapeXml(item.price?.updatedAt || item.createdAt || new Date().toISOString())}</lastmod></url>`).join('');
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${escapeXml(`${origin}/`)}</loc></url>${urls}</urlset>`);
    return true;
  }
  if (url.pathname === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${origin}/sitemap.xml\n`);
    return true;
  }
  if (url.pathname.startsWith('/campana/')) {
    const code = decodeURIComponent(url.pathname.slice('/campana/'.length));
    const campaign = (data.campaigns || []).find(item => item.status === 'active' && String(item.code || '').toLowerCase() === code.toLowerCase());
    if (!campaign) { sendHtml(res, 404, '<!doctype html><title>Campaña no encontrada | Ndivepa</title><main style="font-family:system-ui;max-width:600px;margin:80px auto;padding:20px"><h1>Campaña no encontrada</h1><a href="/">Volver a Ndivepa</a></main>'); return true; }
    const products = (data.affiliateProducts || []).filter(item => item.status === 'published' && item.campaignId === campaign.id);
    const cards = products.map(item => `<article><div class="icon">${escapeHtml(item.image || '🔗')}</div><span>${escapeHtml(data.categories?.find(category => category.id === item.categoryId)?.name || 'Recomendación')}</span><h2>${escapeHtml(item.name)}</h2><p>${escapeHtml(item.description || '')}</p><a href="${escapeHtml(productPath(item))}">Ver recomendación →</a></article>`).join('') || '<p>No hay recomendaciones publicadas para esta campaña.</p>';
    sendHtml(res, 200, `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(campaign.name)} | Ndivepa</title><meta name="description" content="Recomendaciones de la campaña ${escapeHtml(campaign.name)} en Ndivepa."><link rel="canonical" href="${escapeHtml(`${origin}${url.pathname}`)}"><style>body{margin:0;background:#f6f8fc;color:#15213a;font:16px/1.5 system-ui,sans-serif}.wrap{width:min(1120px,calc(100% - 40px));margin:auto}.brand{display:inline-block;padding:24px 0;color:#15213a;text-decoration:none;font-weight:850;font-size:1.45rem}.brand i{color:#6457e9;font-style:normal}.hero{padding:50px 0}.eyebrow{color:#6457e9;font-size:.72rem;letter-spacing:.12em;font-weight:850}h1{font-size:clamp(2.4rem,6vw,4.6rem);line-height:1.02;letter-spacing:-.06em;margin:9px 0}.hero p{color:#62708a;max-width:620px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px;padding-bottom:60px}article{background:#fff;border:1px solid #e5e9f0;border-radius:16px;padding:18px}.icon{height:145px;display:grid;place-items:center;background:linear-gradient(145deg,#ebe9ff,#e5f7f0);border-radius:11px;font-size:3.6rem}article span{display:inline-block;margin-top:15px;color:#6457e9;font-size:.72rem;font-weight:800}h2{font-size:1.15rem;letter-spacing:-.03em;margin:8px 0}article p{color:#62708a;font-size:.87rem;min-height:64px}article a{color:#6457e9;font-weight:800;text-decoration:none}</style></head><body><main class="wrap"><a class="brand" href="/">Ndi<i>vepa</i></a><section class="hero"><span class="eyebrow">CAMPAÑA ${escapeHtml(campaign.code || '')}</span><h1>${escapeHtml(campaign.name)}</h1><p>Recomendaciones seleccionadas para esta campaña. Las compras se realizan directamente con cada proveedor.</p></section><section class="grid">${cards}</section></main></body></html>`);
    return true;
  }
  if (!url.pathname.startsWith('/producto/')) return false;
  const route = decodeURIComponent(url.pathname.slice('/producto/'.length));
  const product = (data.affiliateProducts || []).find(item => item.status === 'published' && route === `${slug(item.name)}-${item.id}`);
  if (!product) { sendHtml(res, 404, '<!doctype html><title>Oferta no encontrada | Ndivepa</title><main style="font-family:system-ui;max-width:600px;margin:80px auto;padding:20px"><h1>Oferta no encontrada</h1><p>Es posible que ya no esté publicada.</p><a href="/">Volver a Ndivepa</a></main>'); return true; }
  sendHtml(res, 200, productPage(product, data, `${origin}${productPath(product)}`));
  return true;
}

const originalEmit = Server.prototype.emit;
Server.prototype.emit = function guardedEmit(event, ...args) {
  if (event !== 'request') return originalEmit.call(this, event, ...args);
  const [req, res] = args;
  securityHeaders(res);
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = (statusCode, headers = {}) => {
    const merged = { ...headers };
    const staticAsset = req.method === 'GET' && /\.(?:css|js|svg|png|jpe?g|webp|ico|woff2?)$/i.test((req.url || '').split('?')[0]);
    if (staticAsset && !merged['Cache-Control'] && !merged['cache-control']) merged['Cache-Control'] = 'public, max-age=3600, stale-while-revalidate=86400';
    const cookie = merged['Set-Cookie'] || merged['set-cookie'];
    if (isProduction && cookie) merged['Set-Cookie'] = Array.isArray(cookie) ? cookie.map(value => value.includes('Secure') ? value : `${value}; Secure`) : (cookie.includes('Secure') ? cookie : `${cookie}; Secure`);
    return originalWriteHead(statusCode, merged);
  };
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const tooLarge = Number(req.headers['content-length'] || 0) > 1_000_000;
  const login = req.method === 'POST' && url.pathname === '/api/auth/login';
  const tracking = req.method === 'POST' && url.pathname === '/api/events/view';
  const click = req.method === 'GET' && url.pathname.startsWith('/go/');
  if (tooLarge || (login && limited(req, 15 * 60_000, 10)) || (tracking && limited(req, 60_000, 120)) || (click && limited(req, 60_000, 60))) {
    res.writeHead(tooLarge ? 413 : 429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': tooLarge ? '0' : '60' });
    res.end(JSON.stringify({ error: tooLarge ? 'Solicitud demasiado grande.' : 'Demasiadas solicitudes; intenta de nuevo más tarde.' }));
    return false;
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/uploads') {
    uploadImage(req, res).catch(() => { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'No se pudo guardar la imagen.' })); });
    return true;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/go/') && url.searchParams.get('consent') !== '1') {
    redirectWithoutTracking(res, url.pathname.split('/').pop()).catch(() => { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('No se pudo abrir la oferta.'); });
    return true;
  }
  if (['/sitemap.xml', '/robots.txt'].includes(url.pathname) || url.pathname.startsWith('/producto/') || url.pathname.startsWith('/campana/')) {
    serveSeoRoute(req, res, url).then(served => { if (!served) originalEmit.call(this, event, ...args); }).catch(() => sendHtml(res, 500, '<!doctype html><title>Error</title><p>No se pudo generar la página.</p>'));
    return true;
  }
  return originalEmit.call(this, event, ...args);
};
