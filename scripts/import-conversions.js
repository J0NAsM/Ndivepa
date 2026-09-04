/**
 * Importación de conversiones de red desde CSV (M-0744, M-1008).
 *
 * Este script era el último resto de la v0.1: abría `data/db.json`, insertaba a
 * mano en `data.conversions` y `data.commissions` y volvía a escribir el fichero
 * completo. Tres consecuencias reales:
 *
 *  - Buscaba los productos en `affiliateProducts`, colección que la migración a
 *    modelo modular dejó vacía, así que **omitía todas las filas en silencio**.
 *  - Guardaba los importes en decimales (`39.96`) donde el resto del sistema
 *    trabaja en unidades mínimas, mezclando dos escalas en la misma columna.
 *  - Escribía sin transacción ni escritura atómica: importar con el servidor
 *    levantado podía perder lo que el servidor tuviera en memoria.
 *
 * Ahora usa los mismos servicios que el panel: atribución al clic, unicidad por
 * `network_conversion_id`, estimación de comisión según el programa cuando la red
 * no la informa, auditoría y eventos de dominio.
 *
 * Uso: npm run import-conversions -- .\ruta\conversiones.csv [--dry-run]
 */
import { readFile, stat } from 'node:fs/promises';
import { bootstrapCli, finish, printTable, requireArg } from './lib/bootstrap.js';
import { parseCsv } from '../src/framework/strings.js';
import { toMinor } from '../src/framework/money.js';

const filePath = requireArg(2, 'Uso: npm run import-conversions -- .\\ruta\\conversiones.csv [--dry-run]');
const dryRun = process.argv.includes('--dry-run');

/** Estados que informan las redes, traducidos a los del dominio. */
const STATUS_MAP = {
  detected: 'pending',
  pending: 'pending',
  approved: 'approved',
  confirmed: 'approved',
  // Un pago solo se registra con su `payout`: aquí la conversión queda aprobada.
  paid: 'approved',
  rejected: 'rejected',
  reversed: 'rejected',
};

const fileInfo = await stat(filePath);
if (fileInfo.size > 10_000_000) throw new Error('El CSV supera el límite operativo de 10 MB.');
const raw = await readFile(filePath, 'utf8');
const rows = parseCsv(raw, { maxRows: 50_001, maxColumns: 200 }).filter(row => row.some(cell => cell !== ''));
if (rows.length < 2) {
  console.error('El CSV no tiene filas de datos.');
  process.exit(1);
}

const headers = rows[0].map(header => header.trim().toLowerCase());
const duplicateHeaders = headers.filter((header, index) => headers.indexOf(header) !== index);
if (duplicateHeaders.length) throw new Error(`El CSV contiene encabezados duplicados: ${[...new Set(duplicateHeaders)].join(', ')}.`);
const problems = [];
if (!headers.includes('network_conversion_id')) problems.push('network_conversion_id');
// El producto se identifica por su `id` o por su `handle`. El handle es el que
// una persona puede escribir a mano: los identificadores se generan al crear el
// producto y no aparecen en ningún informe de red.
if (!headers.includes('product_id') && !headers.includes('product_handle')) problems.push('product_id o product_handle');
if (problems.length) {
  console.error(`Faltan columnas obligatorias: ${problems.join(', ')}.`);
  console.error(`Columnas encontradas: ${headers.join(', ')}.`);
  console.error('Opcionales: click_id, type, sale_amount, sale_currency, commission, commission_currency, status, date.');
  process.exit(1);
}

const app = await bootstrapCli();
const catalog = app.container.resolve('catalog');
const affiliate = app.container.resolve('affiliate');
const settings = app.container.resolve('settings').settings;

/** Importe decimal del CSV a unidades mínimas; cadena vacía significa «sin dato». */
function amount(value, currency) {
  if (value === undefined || String(value).trim() === '') return null;
  const numeric = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(numeric)) throw new Error(`El importe "${value}" no es un número válido.`);
  return toMinor(numeric, currency);
}

const results = [];
let imported = 0;

for (let index = 1; index < rows.length; index += 1) {
  const cells = rows[index];
  const row = Object.fromEntries(headers.map((header, position) => [header, cells[position] ?? '']));
  const rowNumber = index + 1;

  try {
    if (cells.length > headers.length) throw new Error('La fila contiene más columnas que el encabezado.');
    const networkConversionId = String(row.network_conversion_id || '').trim();
    if (!networkConversionId) throw new Error('Falta network_conversion_id.');
    if (affiliate.conversions.repository.find({ networkConversionId })) throw new Error(`La conversión ${networkConversionId} ya fue importada.`);

    const reference = String(row.product_id || row.product_handle || '').trim();
    const product = catalog.products.repository.byId(reference) || catalog.products.byHandle(reference);
    if (!product) throw new Error(`El producto ${reference || '(vacío)'} no existe.`);

    const rawStatus = String(row.status || 'pending').trim().toLowerCase();
    const target = STATUS_MAP[rawStatus];
    if (!target) throw new Error(`Estado "${rawStatus}" no reconocido.`);

    const program = product.programId ? affiliate.programs.repository.byId(product.programId) : null;
    const saleCurrency = String(row.sale_currency || settings.get('defaultCurrency', 'USD')).toUpperCase();
    const commissionCurrency = String(row.commission_currency || saleCurrency).toUpperCase();

    const payload = {
      networkConversionId,
      clickId: row.click_id || null,
      productId: product.id,
      merchantId: product.merchantId || null,
      networkId: program?.networkId || null,
      programId: product.programId || null,
      date: row.date || undefined,
      type: ['purchase', 'lead', 'booking', 'subscription', 'other'].includes(row.type) ? row.type : 'purchase',
      saleAmount: amount(row.sale_amount, saleCurrency),
      saleCurrency,
      // Sin columna de comisión, el dominio la estima con las reglas del programa
      // y la marca como estimada; no se inventa un importe confirmado.
      commission: amount(row.commission, commissionCurrency),
      commissionCurrency,
      source: 'import_csv',
    };
    for (const key of Object.keys(payload)) if (payload[key] === null) delete payload[key];

    if (dryRun) {
      results.push({ fila: rowNumber, estado: 'ok (simulado)', detalle: `${networkConversionId} -> ${target}` });
      imported += 1;
      continue;
    }

    const conversion = await affiliate.conversions.create(payload);
    if (target === 'approved') await affiliate.conversions.approve(conversion.id);
    if (target === 'rejected') await affiliate.conversions.reject(conversion.id, `Importado como "${rawStatus}".`);

    const attributed = conversion.attribution?.attributed ? 'atribuida' : `sin atribuir (${conversion.attribution?.reason})`;
    const note = rawStatus === 'paid' ? ' · el pago se registra con su payout' : '';
    imported += 1;
    results.push({
      fila: rowNumber,
      estado: target,
      detalle: `${conversion.id} · ${attributed} · comisión ${conversion.commissionSource}${note}`,
    });
  } catch (error) {
    results.push({ fila: rowNumber, estado: 'error', detalle: error.message.slice(0, 90) });
  }
}

const failed = results.filter(result => result.estado === 'error').length;

console.log(`\nImportación de conversiones${dryRun ? ' (simulación)' : ''}\n`);
printTable(results, [
  { key: 'fila', label: 'FILA' },
  { key: 'estado', label: 'ESTADO' },
  { key: 'detalle', label: 'DETALLE' },
]);
console.log(`\n  Procesadas: ${results.length}`);
console.log(`  Correctas:  ${imported}`);
console.log(`  Con error:  ${failed}`);
if (!dryRun && imported) {
  console.log('\nUna comisión aprobada no es ingreso: se convierte en cobro cuando se');
  console.log('registra el pago de la red con `payouts`.');
}

await finish(app, { code: failed && !imported ? 1 : 0 });
