/**
 * Índice de búsqueda invertido (M-0105 … M-0109, M-0381 … M-0395).
 *
 * Equivalente funcional a `search-local` de Medusa y a `search.service` de Vendure,
 * pero sin motor externo: un índice invertido en memoria, reconstruible desde el
 * documento en cualquier momento. Suficiente para decenas de miles de fichas y sin
 * una dependencia más que mantener.
 *
 * Tolerancia (v4, marketplace):
 *  - plurales: «hamacas» encuentra «hamaca»;
 *  - palabras incompletas: «hama» encuentra «hamaca» por prefijo;
 *  - errores: «amaca», «hamcaa» o «poyvii» se corrigen con Levenshtein acotado;
 *  - sinónimos y términos locales registrados por los módulos;
 *  - cobertura: una ficha que contiene todas las palabras pesa más que otra que
 *    contiene una sola repetida.
 *
 * La búsqueda semántica queda como punto de integración (`useReranker`), no como
 * requisito: sin reordenadores el resultado es léxico y determinista.
 */
import { normalizeForSearch } from './strings.js';

const STOP_WORDS = new Set([
  'de', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'o', 'para', 'con', 'en', 'por', 'del', 'al',
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'in', 'of', 'to',
]);

/**
 * Plural a singular, conservador: «hamacas» -> «hamaca», «colores» -> «color».
 * No pretende ser un lematizador; solo evita que un plural deje sin resultados.
 */
export function stem(token) {
  if (token.length <= 4 || /\d/.test(token)) return token;
  if (/[rlndz]es$/.test(token) && token.length > 5) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function tokenize(text) {
  return normalizeForSearch(text)
    .split(/[\s-]+/)
    .filter(token => token.length > 1 && !STOP_WORDS.has(token))
    .map(stem);
}

/** Distancia de Damerau-Levenshtein con corte temprano: `null` si supera `max`. */
export function boundedLevenshtein(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return null;
  let beforePrevious = null;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      // Transposición de dos letras contiguas («hamcaa» por «hamaca») cuenta como una.
      if (beforePrevious && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, beforePrevious[j - 2] + 1);
      }
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return null;
    beforePrevious = previous;
    previous = current;
  }
  return previous[b.length] <= max ? previous[b.length] : null;
}

/** Tolerancia según longitud: una palabra corta con dos errores ya es otra palabra. */
export function typoBudget(token) {
  if (token.length >= 7) return 2;
  if (token.length >= 4) return 1;
  return 0;
}

export class SearchIndex {
  /**
   * @param {object} options
   * @param {Record<string, number>} options.weights peso por campo indexado
   */
  constructor({
    weights = { name: 5, sku: 4, brand: 3, tags: 3, subtitle: 2, category: 2, seller: 2, attributes: 1, description: 1 },
    logger,
  } = {}) {
    this.weights = weights;
    this.logger = logger;
    this.documents = new Map();
    this.inverted = new Map();
    this.synonyms = new Map();
    this.emptyTerms = new Map();
    this.stats = { indexed: 0, searches: 0 };
    // Punto de integración para búsqueda semántica: recibe los candidatos ya
    // puntuados y puede reordenarlos. Sin reordenadores la búsqueda es léxica.
    this.rerankers = [];
  }

  useReranker(reranker) {
    this.rerankers.push(reranker);
    return this;
  }

  /** Sinónimos por idioma (M-0108, M-0388): `notebook` -> `laptop`, `portatil`. */
  addSynonyms(term, equivalents) {
    const key = stem(normalizeForSearch(term));
    const current = this.synonyms.get(key) || new Set();
    for (const item of equivalents) {
      for (const token of tokenize(item)) current.add(token);
    }
    this.synonyms.set(key, current);
    return this;
  }

  /** Vacía los sinónimos para volver a cargarlos desde su origen (panel o semilla). */
  clearSynonyms() {
    this.synonyms.clear();
    return this;
  }

  /** Sinónimos registrados, en la forma en que se editan. */
  synonymList() {
    return [...this.synonyms.entries()].map(([term, values]) => ({ term, equivalents: [...values] }));
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

  has(documentId) {
    return this.documents.has(documentId);
  }

  /** Coincidencia exacta o por prefijo, para autocompletar y tolerar palabras a medias (M-0106). */
  candidatesFor(token) {
    const exact = this.inverted.get(token);
    if (exact) return [{ term: token, bucket: exact, distance: 0 }];
    const matches = [];
    if (token.length < 3) return matches;
    for (const [term, bucket] of this.inverted) {
      if (term.startsWith(token)) matches.push({ term, bucket, distance: 0, prefix: true });
    }
    return matches;
  }

  /** Compatibilidad con el nombre anterior; ahora es Damerau-Levenshtein real. */
  static editDistanceWithin(a, b, max = 1) {
    return boundedLevenshtein(a, b, max) !== null;
  }

  fuzzyCandidates(token) {
    const budget = typoBudget(token);
    if (!budget) return [];
    const matches = [];
    for (const [term, bucket] of this.inverted) {
      const distance = boundedLevenshtein(token, term, budget);
      if (distance !== null) matches.push({ term, bucket, distance });
    }
    // Solo la mejor distancia: con dos errores se abre demasiado el abanico.
    const best = Math.min(...matches.map(match => match.distance));
    return matches.filter(match => match.distance === best);
  }

  /**
   * Busca y devuelve documentos puntuados, con recuento de facetas del resultado.
   * @param {{query?:string, filters?:object, facetFilters?:object, fuzzy?:boolean,
   *          limit?:number, offset?:number, sort?:string}} params
   */
  search({ query = '', filters = {}, facetFilters = {}, fuzzy = true, limit = 24, offset = 0, sort = 'relevance' } = {}) {
    this.stats.searches += 1;
    const queryTokens = [...new Set(tokenize(query))];
    let scored = [];
    const corrections = [];

    if (!queryTokens.length) {
      scored = [...this.documents.values()].map(document => ({ document, score: 0, coverage: 1 }));
    } else {
      const scores = new Map();
      const hits = new Map();
      for (const original of queryTokens) {
        // Cada palabra de la consulta cuenta una vez, aunque se expanda en sinónimos.
        const variants = this.expand([original]);
        let matches = variants.flatMap(token => this.candidatesFor(token));
        if (!matches.length && fuzzy) {
          matches = this.fuzzyCandidates(original);
          if (matches.length) corrections.push({ from: original, to: matches[0].term });
        }
        const seen = new Set();
        for (const match of matches) {
          // Una corrección o un prefijo valen algo menos que la palabra exacta.
          const factor = match.distance ? 0.6 : match.prefix ? 0.8 : 1;
          for (const [documentId, weight] of match.bucket) {
            scores.set(documentId, (scores.get(documentId) || 0) + weight * factor);
            if (!seen.has(documentId)) {
              seen.add(documentId);
              hits.set(documentId, (hits.get(documentId) || 0) + 1);
            }
          }
        }
      }
      scored = [...scores.entries()]
        .map(([documentId, score]) => {
          const coverage = (hits.get(documentId) || 0) / queryTokens.length;
          return { document: this.documents.get(documentId), score: Math.round(score * (0.5 + coverage) * 100) / 100, coverage };
        })
        .filter(entry => entry.document);
      // Con tres o más palabras se exige cubrir al menos la mitad: evita que
      // «hamaca de poyvi roja» devuelva todo lo que sea rojo.
      if (queryTokens.length >= 3) scored = scored.filter(entry => entry.coverage >= 0.5);
    }

    scored = scored.filter(entry => matchesFilters(entry.document, filters) && matchesFacets(entry.document, facetFilters));
    for (const reranker of this.rerankers) {
      try {
        scored = reranker({ query, tokens: queryTokens, results: scored }) || scored;
      } catch (error) {
        this.logger?.warn?.('Reordenador de búsqueda fallido; se conserva el orden léxico', { error: error.message });
      }
    }

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
      corrected: corrections.length ? corrections : null,
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
      rerankers: this.rerankers.length,
      ...this.stats,
    };
  }
}

function matchesFilters(document, filters) {
  for (const [key, expected] of Object.entries(filters || {})) {
    const value = document.filters?.[key];
    if (expected === undefined || expected === null || expected === '') continue;
    const values = Array.isArray(value) ? value : [value];
    if (Array.isArray(expected)) {
      if (!expected.some(item => values.includes(item))) return false;
      continue;
    }
    if (expected && typeof expected === 'object') {
      if (expected.min !== undefined && expected.min !== null && expected.min !== '' && !(Number(value) >= Number(expected.min))) return false;
      if (expected.max !== undefined && expected.max !== null && expected.max !== '' && !(Number(value) <= Number(expected.max))) return false;
      continue;
    }
    if (!values.includes(expected)) return false;
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
    rating: (a, b) => (b.document.filters?.rating ?? 0) - (a.document.filters?.rating ?? 0)
      || (b.document.filters?.reviewCount ?? 0) - (a.document.filters?.reviewCount ?? 0),
    name: (a, b) => String(a.document.fields?.name || '').localeCompare(String(b.document.fields?.name || '')),
  };
  return [...scored].sort(rules[sort] || rules.relevance);
}
