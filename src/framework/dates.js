/**
 * Utilidades de fecha (M-0041 … M-0043).
 * Todo se guarda en ISO-8601 UTC; la zona horaria es una preferencia de presentación.
 */

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const now = () => new Date().toISOString();

export function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function toIso(value) {
  return toDate(value)?.toISOString() ?? null;
}

export function plusDays(value, days) {
  const date = toDate(value) || new Date();
  return new Date(date.getTime() + days * DAY).toISOString();
}

export function plusMinutes(value, minutes) {
  const date = toDate(value) || new Date();
  return new Date(date.getTime() + minutes * MINUTE).toISOString();
}

export function ageInDays(value, reference = Date.now()) {
  const date = toDate(value);
  if (!date) return null;
  return Math.floor((reference - date.getTime()) / DAY);
}

/** Clave `YYYY-MM-DD` en UTC, para agrupar series diarias. */
export function dayKey(value) {
  const date = toDate(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

/** Clave `YYYY-Www` ISO, para agrupar series semanales. */
export function weekKey(value) {
  const date = toDate(value);
  if (!date) return null;
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc - yearStart) / DAY + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function monthKey(value) {
  const date = toDate(value);
  return date ? date.toISOString().slice(0, 7) : null;
}

export const GROUPERS = { day: dayKey, week: weekKey, month: monthKey };

/** Rango de los últimos `days` días, terminando ahora. */
export function lastDaysRange(days, reference = Date.now()) {
  const end = new Date(reference);
  const start = new Date(reference - (Number(days) || 30) * DAY);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Período anterior de la misma duración, para comparar (M-0041). */
export function previousRange({ start, end }) {
  const from = toDate(start);
  const to = toDate(end);
  if (!from || !to) return null;
  const span = to.getTime() - from.getTime();
  return { start: new Date(from.getTime() - span).toISOString(), end: from.toISOString() };
}

export function withinRange(value, { start, end } = {}) {
  const date = toDate(value);
  if (!date) return false;
  const from = toDate(start);
  const to = toDate(end);
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

/** Vigencia declarada por `startsAt`/`endsAt` (M-0042). Sin fechas, está vigente. */
export function isActiveNow({ startsAt, endsAt } = {}, reference = Date.now()) {
  const start = toDate(startsAt);
  const end = toDate(endsAt);
  if (start && reference < start.getTime()) return false;
  if (end && reference > end.getTime()) return false;
  return true;
}

export function rangesOverlap(a, b) {
  const aStart = toDate(a?.startsAt)?.getTime() ?? -Infinity;
  const aEnd = toDate(a?.endsAt)?.getTime() ?? Infinity;
  const bStart = toDate(b?.startsAt)?.getTime() ?? -Infinity;
  const bEnd = toDate(b?.endsAt)?.getTime() ?? Infinity;
  return aStart <= bEnd && bStart <= aEnd;
}

/** Serie continua de claves entre dos fechas, incluidos los días sin datos. */
export function seriesKeys({ start, end }, granularity = 'day') {
  const from = toDate(start);
  const to = toDate(end);
  if (!from || !to) return [];
  const grouper = GROUPERS[granularity] || dayKey;
  const keys = [];
  const seen = new Set();
  const step = granularity === 'month' ? 28 * DAY : granularity === 'week' ? 7 * DAY : DAY;
  for (let cursor = from.getTime(); cursor <= to.getTime(); cursor += step) {
    const key = grouper(new Date(cursor));
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  const lastKey = grouper(to);
  if (lastKey && !seen.has(lastKey)) keys.push(lastKey);
  return keys;
}

/** Día de la semana en minúsculas y en inglés, para reglas de promoción. */
export function weekdayName(value) {
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const date = toDate(value);
  return date ? names[date.getUTCDay()] : null;
}
