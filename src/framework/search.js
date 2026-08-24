/**
 * Índice de búsqueda invertido (M-0105 … M-0109, M-0381 … M-0395).
 *
 * Equivalente funcional a `search-local` de Medusa y a `search.service` de Vendure,
 * pero sin motor externo: un índice invertido en memoria, reconstruible desde el
 * documento en cualquier momento. Suficiente para decenas de miles de fichas y sin
 * una dependencia más que mantener.
 */
import { normalizeForSearch } from './strings.js';

const STOP_WORDS = new Set([
  'de', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'o', 'para', 'con', 'en', 'por', 'del', 'al',
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'in', 'of', 'to',
]);

export function tokenize(text) {
  return normalizeForSearch(text)
    .split(/[\s-]+/)
    .filter(token => token.length > 1 && !STOP_WORDS.has(token));
}

export class SearchIndex {
  /**
   * @param {object} options
   * @param {Record<string, number>} options.weights peso por campo indexado
   */
  constructor({ weights = { name: 5, sku: 4, brand: 3, subtitle: 2, description: 1 }, logger } = {}) {
    this.weights = weights;
    this.logger = logger;
    this.documents = new Map();
    this.inverted = new Map();
    this.synonyms = new Map();
    this.emptyTerms = new Map();
    this.stats = { indexed: 0, searches: 0 };
  }

  /** Sinónimos por idioma (M-0108, M-0388): `notebook` -> `laptop`, `portatil`. */
  addSynonyms(term, equivalents) {
    const key = normalizeForSearch(term);
    const current = this.synonyms.get(key) || new Set();
    for (const item of equivalents) current.add(normalizeForSearch(item));
    this.synonyms.set(key, current);
    return this;
  }

  expand(tokens) {
    const expanded = new Set(tokens);
    for (const token of tokens) {
      for (const synonym of this.synonyms.get(token) || []) expanded.add(synonym);
      for (const [key, values] of this.synonyms) if (values.has(token)) expanded.add(key);
    }
    return [...expanded];
  }

  /**
   * Añade o reemplaza un documento (M-0109: reindexado incremental).
   * @param {{id:string, fields:object, facets?:object, filters?:object}} document
   */
  put(document) {
    this.remove(document.id);
    const terms = new Map();
    for (const [field, weight] of Object.entries(this.weights)) {
      const value = document.fields?.[field];
      if (!value) continue;
      for (const token of tokenize(Array.isArray(value) ? value.join(' ') : value)) {
        terms.set(token, (terms.get(token) || 0) + weight);
      }
    }
    for (const values of Object.values(document.facets || {})) {
      for (const token of tokenize(Array.isArray(values) ? values.join(' ') : values)) {
        terms.set(token, (terms.get(token) || 0) + 1);
      }
    }
    this.documents.set(document.id, { ...document, terms });
    for (const [term, weight] of terms) {
      if (!this.inverted.has(term)) this.inverted.set(term, new Map());
      this.inverted.get(term).set(document.id, weight);
    }
    this.stats.indexed += 1;
    return document.id;
  }

  remove(documentId) {
    const existing = this.documents.get(documentId);
    if (!existing) return false;
    for (const term of existing.terms.keys()) {
      const bucket = this.inverted.get(term);
      bucket?.delete(documentId);
      if (bucket && !bucket.size) this.inverted.delete(term);
    }
    this.documents.delete(documentId);
    return true;
  }

  clear() {
    this.documents.clear();
    this.inverted.clear();
  }

  /** Coincidencia por prefijo, para autocompletar y tolerar palabras a medias (M-0106). */
  candidatesFor(token) {
    const exact = this.inverted.get(token);
    if (exact) return [exact];
    const buckets = [];
    for (const [term, bucket] of this.inverted) {
      if (term.startsWith(token)) buckets.push(bucket);
    }
    return buckets;
  }

  /** Distancia de edición acotada, para corregir un error tipográfico (M-0387). */
  static editDistanceWithin(a, b, max = 1) {
    if (Math.abs(a.length - b.length) > max) return false;
    let edits = 0;
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        i += 1;
        j += 1;
        continue;
      }
      edits += 1;
      if (edits > max) return false;
      if (a.length > b.length) i += 1;
      else if (a.length < b.length) j += 1;
      else {
        i += 1;
        j += 1;
      }
    }
    return edits + (a.length - i) + (b.length - j) <= max;
  }

  fuzzyCandidates(token) {
    const buckets = [];
    for (const [term, bucket] of this.inverted) {
      if (SearchIndex.editDistanceWithin(token, term, 1)) buckets.push(bucket);
    }
    return buckets;
  }

  /**
   * Busca y devuelve documentos puntuados, con recuento de facetas del resultado.
   * @param {{query?:string, filters?:object, facetFilters?:object, fuzzy?:boolean,
   *          limit?:number, offset?:number, sort?:string}} params
   */
  search({ query = '', filters = {}, facetFilters = {}, fuzzy = true, limit = 24, offset = 0, sort = 'relevance' } = {}) {
    this.stats.searches += 1;
    const tokens = this.expand(tokenize(query));
    let scored = [];

    if (!tokens.length) {
      scored = [...this.documents.values()].map(document => ({ document, score: 0 }));
    } else {
      const scores = new Map();
      for (const token of tokens) {
        let buckets = this.candidatesFor(token);
        if (!buckets.length && fuzzy) buckets = this.fuzzyCandidates(token);
        for (const bucket of buckets) {
          for (const [documentId, weight] of bucket) {
            scores.set(documentId, (scores.get(documentId) || 0) + weight);
          }
        }
      }
      scored = [...scores.entries()]
        .map(([documentId, score]) => ({ document: this.documents.get(documentId), score }))
        .filter(entry => entry.document);
    }

    scored = scored.filter(entry => matchesFilters(entry.document, filters) && matchesFacets(entry.document, facetFilters));

    // Términos sin resultado: material para mejorar el catálogo (M-0389).
    if (query && !scored.length) {
      const key = normalizeForSearch(query);
      this.emptyTerms.set(key, (this.emptyTerms.get(key) || 0) + 1);
    }

    const facets = countFacets(scored.map(entry => entry.document));
    const sorted = sortResults(scored, sort);
    const page = sorted.slice(offset, offset + limit);

    return {
      data: page.map(entry => ({ id: entry.document.id, score: entry.score, ...entry.document.payload })),
      count: sorted.length,
      limit,
      offset,
      facets,
      corrected: null,
    };
  }

  /** Sugerencias de autocompletado a partir de los términos indexados (M-0386). */
  suggest(prefix, limit = 8) {
    const token = normalizeForSearch(prefix);
    if (!token) return [];
    const suggestions = [];
    for (const [term, bucket] of this.inverted) {
      if (term.startsWith(token)) suggestions.push({ term, documents: bucket.size });
    }
    return suggestions.sort((a, b) => b.documents - a.documents).slice(0, limit);
  }

  emptySearches({ limit = 20 } = {}) {
    return [...this.emptyTerms.entries()]
      .map(([term, count]) => ({ term, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  describe() {
    return {
      documents: this.documents.size,
      terms: this.inverted.size,
      synonyms: this.synonyms.size,
      emptyTerms: this.emptyTerms.size,
      ...this.stats,
    };
  }
}

function matchesFilters(document, filters) {
  for (const [key, expected] of Object.entries(filters || {})) {
    const value = document.filters?.[key];
    if (expected === undefined || expected === null || expected === '') continue;
    if (Array.isArray(expected)) {
      if (!expected.includes(value)) return false;
      continue;
    }
    if (expected && typeof expected === 'object') {
      if (expected.min !== undefined && !(Number(value) >= Number(expected.min))) return false;
      if (expected.max !== undefined && !(Number(value) <= Number(expected.max))) return false;
      continue;
    }
    if (value !== expected) return false;
  }
  return true;
}

function matchesFacets(document, facetFilters) {
  for (const [facet, wanted] of Object.entries(facetFilters || {})) {
    const values = document.facets?.[facet];
    const list = Array.isArray(values) ? values : values === undefined ? [] : [values];
    const expected = Array.isArray(wanted) ? wanted : [wanted];
    if (!expected.some(value => list.includes(value))) return false;
  }
  return true;
}

/** Recuento por valor de faceta sobre el resultado actual (M-0107, M-0385). */
function countFacets(documents) {
  const counts = {};
  for (const document of documents) {
    for (const [facet, values] of Object.entries(document.facets || {})) {
      const list = Array.isArray(values) ? values : [values];
      counts[facet] = counts[facet] || {};
      for (const value of list) counts[facet][value] = (counts[facet][value] || 0) + 1;
    }
  }
  return Object.fromEntries(
    Object.entries(counts).map(([facet, values]) => [
      facet,
      Object.entries(values)
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    ]),
  );
}

function sortResults(scored, sort) {
  const rules = {
    relevance: (a, b) => b.score - a.score || String(a.document.id).localeCompare(String(b.document.id)),
    newest: (a, b) => String(b.document.filters?.createdAt || '').localeCompare(String(a.document.filters?.createdAt || '')),
    price_asc: (a, b) => (a.document.filters?.price ?? Infinity) - (b.document.filters?.price ?? Infinity),
    price_desc: (a, b) => (b.document.filters?.price ?? -Infinity) - (a.document.filters?.price ?? -Infinity),
    popularity: (a, b) => (b.document.filters?.popularity ?? 0) - (a.document.filters?.popularity ?? 0),
    name: (a, b) => String(a.document.fields?.name || '').localeCompare(String(b.document.fields?.name || '')),
  };
  return [...scored].sort(rules[sort] || rules.relevance);
}
