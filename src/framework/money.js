/**
 * Aritmética de dinero (M-0035 … M-0040).
 *
 * Regla del proyecto: **todo importe se guarda en unidades mínimas** (enteros).
 * 999,00 USD se guarda como 99900. Nunca se suman números con decimales, porque
 * 0.1 + 0.2 !== 0.3 y un céntimo perdido en un descuento repartido es un descuadre
 * que aparece semanas después en la conciliación.
 */
import { ValidationError } from './errors.js';

/** Decimales por moneda (M-0036). Las que no aparecen usan 2. */
export const CURRENCY_DECIMALS = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

export function decimalsFor(currency) {
  return CURRENCY_DECIMALS[String(currency || 'USD').toUpperCase()] ?? 2;
}

export function factorFor(currency) {
  return 10 ** decimalsFor(currency);
}

/** Redondeo half-up determinista, también para valores negativos. */
export function roundHalfUp(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Convierte un valor decimal introducido por una persona a unidades mínimas. */
export function toMinor(amount, currency = 'USD') {
  if (amount === null || amount === undefined || amount === '') return null;
  const numeric = typeof amount === 'string' ? Number(amount.replace(',', '.')) : Number(amount);
  if (!Number.isFinite(numeric)) throw ValidationError.single('amount', 'El importe no es un número válido.');
  return roundHalfUp(numeric * factorFor(currency));
}

/** Convierte unidades mínimas a decimal para mostrar o exportar. */
export function toDecimal(minor, currency = 'USD') {
  if (minor === null || minor === undefined) return null;
  return Number(minor) / factorFor(currency);
}

export function add(...amounts) {
  return amounts.reduce((total, amount) => total + Math.trunc(Number(amount) || 0), 0);
}

export function subtract(a, b) {
  return Math.trunc(Number(a) || 0) - Math.trunc(Number(b) || 0);
}

export function multiply(minor, quantity) {
  return roundHalfUp((Number(minor) || 0) * (Number(quantity) || 0));
}

/** Porcentaje sobre un importe en unidades mínimas, con redondeo definido (M-0037). */
export function percentage(minor, percent) {
  return roundHalfUp(((Number(minor) || 0) * (Number(percent) || 0)) / 100);
}

/** Nunca deja un importe por debajo de cero: los totales negativos son un defecto. */
export function clampToZero(minor) {
  const value = Math.trunc(Number(minor) || 0);
  return value < 0 ? 0 : value;
}

/**
 * Reparte un importe entre pesos, compensando los restos (M-0038).
 * La suma del resultado es exactamente `total`, siempre. Los céntimos sobrantes
 * van a los pesos mayores, de forma determinista y reproducible.
 */
export function distribute(total, weights) {
  const amount = Math.trunc(Number(total) || 0);
  const list = weights.map(weight => Math.max(0, Number(weight) || 0));
  const sum = list.reduce((acc, weight) => acc + weight, 0);
  if (!sum) {
    const shares = new Array(list.length).fill(0);
    if (shares.length) shares[0] = amount;
    return shares;
  }
  const shares = list.map(weight => Math.trunc((amount * weight) / sum));
  let remainder = amount - shares.reduce((acc, share) => acc + share, 0);
  const order = list
    .map((weight, index) => ({ weight, index }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  let cursor = 0;
  const step = remainder < 0 ? -1 : 1;
  while (remainder !== 0 && order.length) {
    shares[order[cursor % order.length].index] += step;
    remainder -= step;
    cursor += 1;
  }
  return shares;
}

/**
 * Descompone un importe con impuesto incluido en base e impuesto.
 * `rate` es el porcentaje (21 para 21 %).
 */
export function splitTaxInclusive(minor, rate) {
  const gross = Math.trunc(Number(minor) || 0);
  const percent = Number(rate) || 0;
  const tax = roundHalfUp((gross * percent) / (100 + percent));
  return { net: gross - tax, tax, gross };
}

/** Calcula el impuesto añadido sobre una base sin impuesto. */
export function taxOnNet(minor, rate) {
  const net = Math.trunc(Number(minor) || 0);
  const tax = percentage(net, rate);
  return { net, tax, gross: net + tax };
}

/** Formato por locale (M-0039). */
export function format(minor, currency = 'USD', locale = 'es-PY') {
  if (minor === null || minor === undefined) return 'Consultar precio';
  const decimals = decimalsFor(currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: String(currency).toUpperCase(),
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(toDecimal(minor, currency));
  } catch {
    return `${toDecimal(minor, currency).toFixed(decimals)} ${currency}`;
  }
}

/** Porcentaje de descuento entre precio anterior y actual, o null si no aplica. */
export function discountPercent(previousMinor, currentMinor) {
  const previous = Number(previousMinor);
  const current = Number(currentMinor);
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return null;
  if (previous <= 0 || current < 0 || current >= previous) return null;
  return Math.round(((previous - current) / previous) * 100);
}

/** Aplica un tipo de cambio manual. No consulta ningún proveedor externo (M-0209). */
export function convert(minor, fromCurrency, toCurrency, rate) {
  const numericRate = Number(rate);
  if (!Number.isFinite(numericRate) || numericRate <= 0) {
    throw ValidationError.single('rate', 'El tipo de cambio debe ser un número positivo.');
  }
  const decimal = toDecimal(minor, fromCurrency) * numericRate;
  return roundHalfUp(decimal * factorFor(toCurrency));
}

/** Objeto de dinero canónico para respuestas de API. */
export function money(minor, currency = 'USD') {
  return {
    amount: minor === null || minor === undefined ? null : Math.trunc(Number(minor)),
    currency: String(currency).toUpperCase(),
    decimals: decimalsFor(currency),
    decimal: toDecimal(minor, currency),
    formatted: format(minor, currency),
  };
}
