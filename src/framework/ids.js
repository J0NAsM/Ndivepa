/**
 * Identificadores (M-0029 … M-0031).
 *
 * Formato: `<prefijo>_<tiempo en base36><10 caracteres aleatorios>`.
 * El componente temporal va primero, de modo que el orden lexicográfico coincide
 * con el orden de creación: eso permite paginar por cursor sin campos extra.
 */
import { randomBytes, randomInt } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
/** Sin I, O, 0 ni 1: se leen en voz alta y se teclean sin error. */
const UNAMBIGUOUS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomString(length, alphabet = ALPHABET) {
  const bytes = randomBytes(length);
  let out = '';
  for (let index = 0; index < length; index += 1) out += alphabet[bytes[index] % alphabet.length];
  return out;
}

/** Identificador con prefijo, ordenable por tiempo. */
export function id(prefix) {
  const stamp = Date.now().toString(36).padStart(9, '0');
  return `${prefix}_${stamp}${randomString(10)}`;
}

/** Código legible para pedidos, cupones e invitaciones. */
export function humanCode(prefix = '', length = 8, separator = '-') {
  const grouped = randomString(length, UNAMBIGUOUS).match(/.{1,4}/g).join(separator);
  return prefix ? `${prefix}${separator}${grouped}` : grouped;
}

/** Token opaco de un uso (invitaciones, restablecimiento, recuperación de carrito). */
export function token(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/** Entero aleatorio en el rango cerrado, con fuente criptográfica. */
export function randomBetween(min, max) {
  return randomInt(min, max + 1);
}

/** Extrae la marca de tiempo de un identificador generado por `id()`. */
export function timestampOf(value) {
  const raw = String(value || '').split('_')[1];
  if (!raw) return null;
  const parsed = Number.parseInt(raw.slice(0, 9), 36);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

/** Prefijos canónicos por entidad, en un solo lugar para evitar divergencias. */
export const PREFIX = {
  product: 'prod',
  variant: 'var',
  option: 'opt',
  optionValue: 'optval',
  collection: 'pcol',
  category: 'pcat',
  facet: 'fac',
  facetValue: 'facval',
  tag: 'tag',
  asset: 'asset',
  priceSet: 'pset',
  price: 'price',
  priceRule: 'prule',
  priceList: 'plist',
  inventoryItem: 'iitem',
  inventoryLevel: 'ilev',
  reservation: 'resv',
  stockMovement: 'smov',
  stockLocation: 'sloc',
  cart: 'cart',
  lineItem: 'li',
  adjustment: 'adj',
  taxLine: 'txl',
  order: 'order',
  orderChange: 'ordch',
  transaction: 'trx',
  creditLine: 'cred',
  surcharge: 'schg',
  draftOrder: 'draft',
  return: 'ret',
  exchange: 'exch',
  claim: 'claim',
  refund: 'refund',
  returnReason: 'rreason',
  fulfillment: 'ful',
  fulfillmentSet: 'fset',
  serviceZone: 'szone',
  shippingProfile: 'sprof',
  shippingOption: 'sopt',
  shippingMethod: 'smeth',
  payment: 'pay',
  paymentCollection: 'paycol',
  paymentSession: 'pases',
  paymentMethod: 'pmeth',
  promotion: 'promo',
  promotionRule: 'prule2',
  applicationMethod: 'appm',
  campaign: 'camp',
  campaignBudget: 'cbud',
  giftCard: 'gift',
  customer: 'cus',
  customerGroup: 'cgroup',
  address: 'addr',
  user: 'usr',
  role: 'role',
  invite: 'invite',
  apiKey: 'apik',
  session: 'ses',
  region: 'reg',
  country: 'ctry',
  province: 'prov',
  zone: 'zone',
  taxCategory: 'txcat',
  taxRate: 'txrate',
  currency: 'cur',
  channel: 'chan',
  seller: 'sell',
  store: 'store',
  setting: 'set',
  notification: 'notif',
  historyEntry: 'hist',
  audit: 'audit',
  alert: 'alert',
  job: 'job',
  event: 'evt',
  webhook: 'hook',
  delivery: 'del',
  content: 'page',
  merchant: 'mer',
  network: 'net',
  program: 'prog',
  affiliateLink: 'link',
  click: 'clk',
  conversion: 'conv',
  commission: 'com',
  payout: 'payout',
  placement: 'plc',
  importRun: 'import',
  workflowRun: 'wfrun',
};
