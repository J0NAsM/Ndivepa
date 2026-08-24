/**
 * Internacionalización (M-0100 … M-0102, M-0309).
 *
 * Dos problemas distintos con la misma solución:
 *  - textos de la interfaz y de los errores;
 *  - contenido traducible de las entidades (nombre y descripción de un producto).
 */
import { toDate } from './dates.js';

export class I18n {
  constructor({ defaultLocale = 'es', supported = ['es'], logger } = {}) {
    this.defaultLocale = defaultLocale;
    this.supported = supported;
    this.logger = logger;
    this.catalogs = new Map();
    this.missing = new Set();
  }

  register(locale, messages) {
    const current = this.catalogs.get(locale) || {};
    this.catalogs.set(locale, { ...current, ...messages });
    return this;
  }

  /** Elige el mejor idioma disponible a partir de `Accept-Language` (M-0102). */
  negotiate(header, explicit = null) {
    if (explicit && this.supported.includes(explicit)) return explicit;
    const candidates = String(header || '')
      .split(',')
      .map(part => {
        const [tag, quality] = part.trim().split(';q=');
        return { tag: tag.trim().toLowerCase(), quality: Number(quality ?? 1) };
      })
      .filter(entry => entry.tag)
      .sort((a, b) => b.quality - a.quality);
    for (const candidate of candidates) {
      const exact = this.supported.find(locale => locale.toLowerCase() === candidate.tag);
      if (exact) return exact;
      const base = candidate.tag.split('-')[0];
      const partial = this.supported.find(locale => locale.toLowerCase().split('-')[0] === base);
      if (partial) return partial;
    }
    return this.defaultLocale;
  }

  /** Traduce con respaldo al idioma por defecto y a la propia clave. */
  t(key, locale = this.defaultLocale, params = {}) {
    const template = this.catalogs.get(locale)?.[key]
      ?? this.catalogs.get(this.defaultLocale)?.[key]
      ?? null;
    if (template === null) {
      this.missing.add(`${locale}:${key}`);
      return key;
    }
    return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] !== undefined ? String(params[name]) : match));
  }

  /** Claves sin traducción, para el diagnóstico (M-0309). */
  missingKeys() {
    return [...this.missing].sort();
  }
}

/**
 * Traducciones de contenido por entidad (M-0101).
 * Se guardan en una colección aparte para no engordar la entidad y para poder
 * añadir un idioma sin migrar el catálogo entero.
 */
export class TranslationStore {
  constructor({ store, collection = 'translations', defaultLocale = 'es' } = {}) {
    this.store = store;
    this.collection = collection;
    this.defaultLocale = defaultLocale;
  }

  key(entity, entityId, locale) {
    return `${entity}:${entityId}:${locale}`;
  }

  /** Devuelve `{campo: valor}` para una entidad e idioma, con respaldo. */
  for(entity, entityId, locale) {
    const rows = this.store.collection(this.collection);
    const exact = rows.find(row => row.entity === entity && row.entityId === entityId && row.locale === locale);
    if (exact) return exact.fields || {};
    const fallback = rows.find(row => row.entity === entity && row.entityId === entityId && row.locale === this.defaultLocale);
    return fallback?.fields || {};
  }

  /** Aplica las traducciones sobre la entidad, sin mutarla. */
  apply(record, entity, locale) {
    if (!record || locale === this.defaultLocale) return record;
    const fields = this.for(entity, record.id, locale);
    return Object.keys(fields).length ? { ...record, ...fields, locale } : record;
  }

  applyAll(records, entity, locale) {
    return records.map(record => this.apply(record, entity, locale));
  }

  set(state, { entity, entityId, locale, fields }) {
    if (!Array.isArray(state[this.collection])) state[this.collection] = [];
    const rows = state[this.collection];
    const position = rows.findIndex(row => row.entity === entity && row.entityId === entityId && row.locale === locale);
    const record = {
      id: this.key(entity, entityId, locale),
      entity,
      entityId,
      locale,
      fields,
      updatedAt: new Date().toISOString(),
    };
    if (position >= 0) rows[position] = { ...rows[position], ...record };
    else rows.unshift(record);
    return record;
  }

  /** Idiomas con traducción para una entidad, y cuál es la más reciente. */
  coverage(entity, entityId) {
    const rows = this.store
      .collection(this.collection)
      .filter(row => row.entity === entity && row.entityId === entityId);
    return {
      locales: rows.map(row => row.locale).sort(),
      updatedAt: rows.map(row => toDate(row.updatedAt)?.toISOString()).filter(Boolean).sort().at(-1) || null,
    };
  }
}
