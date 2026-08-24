/**
 * Utilidades de texto (M-0032 … M-0034).
 * Único lugar del proyecto donde se define el escapado: si aparece otro, es un defecto.
 */

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, char => HTML_ENTITIES[char]);
}

export const escapeXml = escapeHtml;

/** Escapa un bloque JSON-LD para que no pueda cerrar la etiqueta script que lo contiene. */
export function escapeJsonLd(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

/** Slug URL-seguro con normalización Unicode y longitud máxima. */
export function slug(value, { maxLength = 80, fallback = 'oferta' } = {}) {
  const base = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) return fallback;
  if (base.length <= maxLength) return base;
  return base.slice(0, maxLength).replace(/-+$/g, '');
}

/**
 * Slug único dentro de un conjunto ya usado. Añade `-2`, `-3`… en lugar de
 * caracteres aleatorios, para que la URL siga siendo legible.
 */
export function uniqueSlug(value, taken, options = {}) {
  const used = taken instanceof Set ? taken : new Set(taken || []);
  const base = slug(value, options);
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Corta respetando la palabra completa. */
export function truncate(value, maxLength = 160, ellipsis = '…') {
  const text = String(value ?? '').trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength - ellipsis.length);
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}${ellipsis}`;
}

/** Normaliza para comparar y para indexar: minúsculas sin acentos ni signos. */
export function normalizeForSearch(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Convierte `camelCase` y `snake_case` en etiqueta legible. */
export function humanize(value) {
  return String(value ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .replace(/^./, char => char.toUpperCase());
}

/** Comparación sin cortocircuito para tokens representados como texto. */
export function safeEqual(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

/** Enmascara un secreto dejando solo un prefijo visible (claves de API, tokens). */
export function mask(value, visible = 6) {
  const text = String(value ?? '');
  if (text.length <= visible) return '*'.repeat(text.length);
  return `${text.slice(0, visible)}${'*'.repeat(Math.min(24, text.length - visible))}`;
}

/** Serializa una fila CSV escapando comillas y separadores. */
export function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values) {
  return values.map(csvCell).join(',');
}

/** Divide una línea CSV respetando comillas dobles escapadas. */
export function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map(cell => cell.trim());
}
