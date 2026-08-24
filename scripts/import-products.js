/**
 * Importación de productos afiliados desde CSV (M-0372, M-0744).
 *
 * Informe **fila por fila**: una fila mal formada no aborta la importación ni deja el
 * catálogo a medias, porque cada producto se crea en su propia transacción.
 *
 * Uso: npm run import-products -- .\ruta\productos.csv [--dry-run]
 */
import { readFile } from 'node:fs/promises';
import { bootstrapCli, finish, printTable, requireArg } from './lib/bootstrap.js';
import { parseCsvLine } from '../src/framework/strings.js';
import { toMinor } from '../src/framework/money.js';
import { now } from '../src/framework/dates.js';

const filePath = requireArg(2, 'Uso: npm run import-products -- .\\ruta\\productos.csv [--dry-run]');
const dryRun = process.argv.includes('--dry-run');

const raw = await readFile(filePath, 'utf8');
const lines = raw.split(/\r?\n/).filter(line => line.trim().length);
if (lines.length < 2) {
  console.error('El CSV no tiene filas de datos.');
  process.exit(1);
}

const headers = parseCsvLine(lines[0]).map(header => header.trim().toLowerCase());
const REQUIRED = ['name', 'merchant_id', 'program_id', 'affiliate_url'];
const missingHeaders = REQUIRED.filter(header => !headers.includes(header));
if (missingHeaders.length) {
  console.error(`Faltan columnas obligatorias: ${missingHeaders.join(', ')}.`);
  console.error(`Columnas encontradas: ${headers.join(', ')}.`);
  process.exit(1);
}

const app = await bootstrapCli();
const catalog = app.container.resolve('catalog');
const affiliate = app.container.resolve('affiliate');
const settings = app.container.resolve('settings').settings;

const results = [];
let created = 0;

for (let index = 1; index < lines.length; index += 1) {
  const cells = parseCsvLine(lines[index]);
  const row = Object.fromEntries(headers.map((header, position) => [header, cells[position] ?? '']));
  const rowNumber = index + 1;

  try {
    if (!row.name || !row.merchant_id || !row.program_id || !row.affiliate_url) {
      throw new Error('Nombre, merchant_id, program_id y affiliate_url son obligatorios.');
    }
    if (!affiliate.merchants.repository.byId(row.merchant_id)) throw new Error(`El comercio ${row.merchant_id} no existe.`);
    if (!affiliate.programs.repository.byId(row.program_id)) throw new Error(`El programa ${row.program_id} no existe.`);
    if (row.category_id && !catalog.categories.repository.byId(row.category_id)) {
      throw new Error(`La categoría ${row.category_id} no existe.`);
    }

    // El enlace se valida antes de crear el producto: así no queda un producto sin
    // destino usable si la URL es inválida.
    const validation = affiliate.links.preview({
      affiliateUrl: row.affiliate_url,
      merchantId: row.merchant_id,
      programId: row.program_id,
    });
    if (validation.status === 'invalid') throw new Error(`Enlace inválido: ${validation.messages.join(' ')}`);

    const currency = String(row.currency || settings.get('defaultCurrency', 'USD')).toUpperCase();
    const priceValue = row.price === '' || row.price === undefined ? null : Number(String(row.price).replace(',', '.'));
    if (priceValue !== null && !Number.isFinite(priceValue)) throw new Error('El precio no es un número válido.');

    if (dryRun) {
      results.push({ fila: rowNumber, estado: 'ok (simulado)', detalle: `${row.name} · ${validation.status}` });
      created += 1;
      continue;
    }

    const product = await catalog.products.create({
      name: row.name,
      description: row.description || '',
      categoryId: row.category_id || null,
      type: ['physical', 'digital', 'service', 'course', 'bundle', 'subscription'].includes(row.type) ? row.type : 'other',
      image: row.image || '🔗',
      merchantId: row.merchant_id,
      programId: row.program_id,
      campaignId: row.campaign_id || null,
      monetizationType: 'AFFILIATE',
      // Todo lo importado entra como borrador: el enlace se revisa antes de publicar.
      status: 'draft',
      brand: row.brand || null,
      price: {
        amount: priceValue === null ? null : toMinor(priceValue, currency),
        previousAmount: row.previous_price ? toMinor(Number(String(row.previous_price).replace(',', '.')), currency) : null,
        currency,
        source: 'import_csv',
        updatedAt: priceValue === null ? null : now(),
      },
      metadata: { importedFrom: filePath, importedAt: now() },
    });

    const link = await affiliate.links.create({
      productId: product.id,
      merchantId: row.merchant_id,
      programId: row.program_id,
      affiliateUrl: row.affiliate_url,
      productUrl: row.product_url || null,
      merchantPrice: priceValue === null ? undefined : {
        amount: toMinor(priceValue, currency),
        currency,
        verifiedAt: now(),
        source: 'import_csv',
      },
    });

    created += 1;
    results.push({
      fila: rowNumber,
      estado: 'creado',
      detalle: `${product.id} · enlace ${link.status}${link.status !== 'valid' ? ' (requiere revisión)' : ''}`,
    });
  } catch (error) {
    results.push({ fila: rowNumber, estado: 'error', detalle: error.message.slice(0, 90) });
  }
}

const failed = results.filter(result => result.estado === 'error').length;

console.log(`\nImportación de productos${dryRun ? ' (simulación)' : ''}\n`);
printTable(results, [
  { key: 'fila', label: 'FILA' },
  { key: 'estado', label: 'ESTADO' },
  { key: 'detalle', label: 'DETALLE' },
]);
console.log(`\n  Procesadas: ${results.length}`);
console.log(`  Correctas:  ${created}`);
console.log(`  Con error:  ${failed}`);
if (!dryRun && created) {
  console.log('\nTodos los productos entran como borrador. Valida cada enlace desde el panel');
  console.log('antes de publicarlos: un enlace inválido bloquea la publicación.');
}

await finish(app, { code: failed && !created ? 1 : 0 });
