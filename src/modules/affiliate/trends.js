import { createHash } from 'node:crypto';

import { NdivepaError, ValidationError } from '../../framework/errors.js';

const GOOGLE_TRENDS_RSS = 'https://trends.google.com/trending/rss';
const MAX_RSS_BYTES = 2_000_000;
const MAX_ITEMS = 100;

const PRODUCT_TERMS = [
  'air fryer', 'alexa', 'amazon', 'auricular', 'camera', 'cámara', 'cafetera',
  'celular', 'comprar', 'consola', 'curso', 'electrodomestico', 'electrodoméstico',
  'freidora', 'gaming', 'headphone', 'iphone', 'kindle', 'laptop', 'lavadora',
  'monitor', 'notebook', 'oferta', 'perfume', 'playstation', 'precio', 'producto',
  'reloj', 'robot aspirador', 'samsung', 'smartphone', 'smartwatch', 'software',
  'tablet', 'televisor', 'tv ', 'udemy', 'xbox', 'zapatilla',
];

const NON_PRODUCT_TERMS = [
  'clima', 'elecciones', 'falleció', 'futbol', 'fútbol', 'gol', 'partido',
  'pronóstico', 'resultado', 'terremoto', 'tormenta', 'vs ',
];

function decodeXml(value = '') {
  return String(value)
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/i, '$1')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, encoded) => {
      const code = encoded[0].toLowerCase() === 'x'
        ? Number.parseInt(encoded.slice(1), 16)
        : Number.parseInt(encoded, 10);
      return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function tag(block, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i').exec(block);
  return decodeXml(match?.[1] || '');
}

export function parseApproxTraffic(value) {
  const normalized = String(value || '').trim().toUpperCase().replace(/[,+\s]/g, '');
  const match = /^(\d+(?:\.\d+)?)([KMB])?$/.exec(normalized);
  if (!match) return null;
  const multipliers = { K: 1_000, M: 1_000_000, B: 1_000_000_000 };
  const amount = Number(match[1]) * (multipliers[match[2]] || 1);
  return Number.isSafeInteger(amount) ? amount : Math.round(amount);
}

export function productLikelihood(query) {
  const normalized = ` ${String(query || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()} `;
  let score = PRODUCT_TERMS.reduce((total, term) => total + (normalized.includes(term.normalize('NFD').replace(/[\u0300-\u036f]/g, '')) ? 2 : 0), 0);
  score -= NON_PRODUCT_TERMS.reduce((total, term) => total + (normalized.includes(term.normalize('NFD').replace(/[\u0300-\u036f]/g, '')) ? 3 : 0), 0);
  return Math.max(0, Math.min(10, score));
}

export function parseGoogleTrendsRss(xml, { geo = 'PY', limit = 50 } = {}) {
  const source = String(xml || '');
  if (!source.includes('<rss') || !source.includes('<item>')) {
    throw ValidationError.single('feed', 'Google Trends devolvió un RSS no reconocido.');
  }
  if (Buffer.byteLength(source) > MAX_RSS_BYTES) {
    throw ValidationError.single('feed', 'El RSS de tendencias supera el tamaño permitido.');
  }

  const items = [];
  for (const match of source.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const query = tag(block, 'title').slice(0, 200);
    if (!query) continue;
    const approximateTraffic = tag(block, 'ht:approx_traffic').slice(0, 40);
    const publishedText = tag(block, 'pubDate');
    const publishedDate = new Date(publishedText);
    const newsTitles = [...block.matchAll(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/gi)]
      .map(entry => decodeXml(entry[1]).slice(0, 300))
      .filter(Boolean)
      .slice(0, 3);
    items.push({
      id: `trend_${createHash('sha256').update(`${geo}:${query}:${publishedText}`).digest('hex').slice(0, 16)}`,
      query,
      approximateTraffic,
      traffic: parseApproxTraffic(approximateTraffic),
      publishedAt: Number.isNaN(publishedDate.getTime()) ? null : publishedDate.toISOString(),
      productLikelihood: productLikelihood(query),
      newsTitles,
      source: 'google-trends-rss',
    });
    if (items.length >= Math.min(MAX_ITEMS, Math.max(1, Number(limit) || 50))) break;
  }
  return items;
}

export class TrendsDiscoveryService {
  constructor({ config, logger = null, fetchImpl = globalThis.fetch }) {
    this.config = config;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.cache = new Map();
  }

  assertEnabled() {
    if (this.config.features.trendDiscovery) return;
    throw new NdivepaError('El descubrimiento por tendencias está desactivado.', {
      code: 'trend_discovery_disabled',
      status: 409,
    });
  }

  async trends({ geo = this.config.discovery.googleTrendsGeo, limit = 50, refresh = false } = {}) {
    this.assertEnabled();
    const region = String(geo || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(region)) throw ValidationError.single('geo', 'Debe ser un código de país ISO de dos letras.');
    const safeLimit = Math.min(MAX_ITEMS, Math.max(1, Number(limit) || 50));
    const cached = this.cache.get(region);
    const cacheAge = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY;
    const withinCacheTtl = cacheAge < this.config.discovery.cacheTtlMs;
    const refreshThrottled = refresh && cacheAge < 60_000;
    if (cached && withinCacheTtl && (!refresh || refreshThrottled)) {
      return { ...cached.value, items: cached.value.items.slice(0, safeLimit), cached: true };
    }

    const endpoint = new URL(GOOGLE_TRENDS_RSS);
    endpoint.searchParams.set('geo', region);
    let response;
    try {
      response = await this.fetchImpl(endpoint, {
        headers: { accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.discovery.timeoutMs),
      });
    } catch (cause) {
      this.logger?.warn?.('No se pudo consultar Google Trends', { geo: region, error: cause.message });
      throw new NdivepaError('No se pudo consultar Google Trends en este momento.', {
        code: 'trend_provider_unavailable',
        status: 502,
        cause,
      });
    }
    if (!response.ok) {
      throw new NdivepaError(`Google Trends respondió con estado ${response.status}.`, {
        code: 'trend_provider_error',
        status: 502,
      });
    }
    const declaredBytes = Number(response.headers.get('content-length') || 0);
    if (declaredBytes > MAX_RSS_BYTES) {
      throw new NdivepaError('La respuesta de Google Trends supera el tamaño permitido.', {
        code: 'trend_provider_response_too_large',
        status: 502,
      });
    }
    const xml = await response.text();
    if (Buffer.byteLength(xml) > MAX_RSS_BYTES) {
      throw new NdivepaError('La respuesta de Google Trends supera el tamaño permitido.', {
        code: 'trend_provider_response_too_large',
        status: 502,
      });
    }
    const items = parseGoogleTrendsRss(xml, { geo: region, limit: MAX_ITEMS });
    const value = {
      geo: region,
      fetchedAt: new Date().toISOString(),
      attribution: 'Datos de tendencias: Google Trends',
      sourceUrl: endpoint.toString(),
      items,
    };
    this.cache.set(region, { fetchedAt: Date.now(), value });
    return { ...value, items: items.slice(0, safeLimit), cached: false };
  }

  async find(query, { geo } = {}) {
    const result = await this.trends({ geo, limit: MAX_ITEMS });
    const normalized = String(query || '').trim().toLocaleLowerCase('es');
    return result.items.find(item => item.query.toLocaleLowerCase('es') === normalized) || null;
  }
}
