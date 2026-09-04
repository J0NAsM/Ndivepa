/**
 * Exportación de informes a CSV (M-0373, M-0456, M-0482, M-0523, M-0755, M-0836).
 *
 * Los importes se exportan en **decimales**, porque un CSV lo abre una persona en una
 * hoja de cálculo; internamente siguen guardados en unidades mínimas. La columna de
 * moneda va siempre al lado del importe para que la cifra no quede sin contexto.
 */
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { bootstrapCli, finish } from './lib/bootstrap.js';
import { csvRow } from '../src/framework/strings.js';
import { toDecimal } from '../src/framework/money.js';
import { ageInDays } from '../src/framework/dates.js';

const app = await bootstrapCli();
const outDir = new URL('../exports/', import.meta.url);
await mkdir(outDir, { recursive: true });

const catalog = app.container.resolve('catalog');
const affiliate = app.container.resolve('affiliate');
const analytics = app.container.resolve('analytics');
const inventory = app.container.resolve('inventory');
const promotion = app.container.resolve('promotion');
const orderModule = app.container.resolve('order');

const write = async (filename, headers, rows) => {
  const content = [csvRow(headers), ...rows.map(csvRow)].join('\n');
  const target = new URL(filename, outDir);
  const temporary = new URL(`.${filename}.${randomUUID()}.tmp`, outDir);
  // BOM para Excel y escritura atómica para no dejar un informe truncado.
  await writeFile(temporary, `\uFEFF${content}\n`, 'utf8');
  try { await rename(temporary, target); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  return { filename, rows: rows.length };
};

const reports = [];

// Rendimiento por producto.
const summary = analytics.reports.summary();
reports.push(await write(
  'rendimiento-productos.csv',
  ['product_id', 'producto', 'vistas', 'clics', 'ctr_pct', 'conversiones', 'conversion_pct', 'comision', 'epc'],
  summary.productPerformance.map(row => [
    row.id, row.name, row.views, row.clicks, row.ctr, row.conversions, row.conversionRate,
    toDecimal(row.commission, 'USD'), toDecimal(row.epc, 'USD'),
  ]),
));

// Conversiones y comisiones.
reports.push(await write(
  'conversiones.csv',
  ['network_conversion_id', 'product_id', 'click_id', 'fecha', 'tipo', 'venta_atribuida', 'moneda_venta',
    'comision', 'moneda_comision', 'estado', 'fuente', 'atribuida'],
  affiliate.conversions.repository.all().map(row => [
    row.networkConversionId, row.productId, row.clickId, row.date, row.type,
    toDecimal(row.saleAmount, row.saleCurrency), row.saleCurrency,
    toDecimal(row.commission, row.commissionCurrency), row.commissionCurrency,
    row.status, row.source, row.attribution?.attributed ? 'si' : 'no',
  ]),
));

reports.push(await write(
  'comisiones.csv',
  ['commission_id', 'conversion_id', 'product_id', 'importe', 'moneda', 'estado', 'aprobada_en', 'pagada_en', 'payout_id'],
  affiliate.commissions.repository.all().map(row => [
    row.id, row.conversionId, row.productId, toDecimal(row.amount, row.currency), row.currency,
    row.status, row.approvedAt, row.paidAt, row.payoutId,
  ]),
));

// Salud de enlaces y precios afiliados.
reports.push(await write(
  'salud-enlaces.csv',
  ['link_id', 'product_id', 'comercio', 'estado', 'revision', 'verificado_hace_dias', 'precio_comercio',
    'moneda', 'precio_verificado_hace_dias', 'motivo'],
  affiliate.links.repository.all().map(row => [
    row.id, row.productId,
    affiliate.merchants.repository.byId(row.merchantId)?.name || '',
    row.status, row.reviewState, ageInDays(row.validation?.checkedAt),
    toDecimal(row.merchantPrice?.amount, row.merchantPrice?.currency || 'USD'),
    row.merchantPrice?.currency || '',
    ageInDays(row.merchantPrice?.verifiedAt),
    row.validation?.messages?.[0] || '',
  ]),
));

// Calidad del catálogo.
const quality = catalog.products.qualityReport();
reports.push(await write(
  'calidad-catalogo.csv',
  ['product_id', 'producto', 'completitud_pct', 'faltantes'],
  quality.worst.concat(
    catalog.products.repository.all()
      .filter(product => !quality.worst.some(row => row.id === product.id))
      .map(product => ({ id: product.id, name: product.name, ...catalog.products.completeness(product) })),
  ).map(row => [row.id, row.name, row.score, (row.missing || []).join(' ')]),
));

// Catálogo completo.
reports.push(await write(
  'catalogo.csv',
  ['product_id', 'handle', 'nombre', 'estado', 'tipo', 'monetizacion', 'categoria', 'comercio', 'programa',
    'precio', 'moneda', 'precio_anterior', 'actualizado'],
  catalog.products.repository.all().map(row => [
    row.id, row.handle, row.name, row.status, row.type, row.monetizationType,
    catalog.categories.repository.byId(row.categoryId)?.name || '',
    affiliate.merchants.repository.byId(row.merchantId)?.name || '',
    affiliate.programs.repository.byId(row.programId)?.name || '',
    toDecimal(row.price?.amount, row.price?.currency || 'USD'), row.price?.currency || '',
    toDecimal(row.price?.previousAmount, row.price?.currency || 'USD'), row.price?.updatedAt,
  ]),
));

// Inventario, promociones y pedidos: se exportan solo si tienen datos.
const levels = inventory.levels.repository.all();
if (levels.length) {
  reports.push(await write(
    'inventario.csv',
    ['sku', 'ubicacion', 'en_stock', 'reservado', 'disponible', 'entrante'],
    levels.map(level => [
      inventory.items.repository.byId(level.inventoryItemId)?.sku || level.inventoryItemId,
      inventory.locations.repository.byId(level.locationId)?.name || level.locationId,
      level.stocked, level.reserved, Math.max(0, (level.stocked || 0) - (level.reserved || 0)), level.incoming,
    ]),
  ));
}

const usages = promotion.usages.repository.all();
if (usages.length) {
  reports.push(await write(
    'promociones-usos.csv',
    ['promotion_id', 'promocion', 'cupon', 'order_id', 'customer_id', 'descuento', 'moneda', 'fecha'],
    usages.map(usage => [
      usage.promotionId,
      promotion.promotions.repository.byId(usage.promotionId)?.name || '',
      promotion.coupons.repository.byId(usage.couponId)?.code || '',
      usage.orderId, usage.customerId,
      toDecimal(usage.discountAmount, usage.currencyCode || 'USD'), usage.currencyCode, usage.createdAt,
    ]),
  ));
}

const orders = orderModule.orders.repository.all();
if (orders.length) {
  reports.push(await write(
    'pedidos.csv',
    ['order_id', 'codigo', 'estado', 'pago', 'envio', 'moneda', 'subtotal', 'descuento', 'envio_importe',
      'impuesto', 'total', 'pagado', 'reembolsado', 'fecha'],
    orders.map(order => [
      order.id, order.code, order.status, order.paymentStatus, order.fulfillmentStatus, order.currencyCode,
      toDecimal(order.subtotal, order.currencyCode), toDecimal(order.discountTotal, order.currencyCode),
      toDecimal(order.shippingTotal, order.currencyCode), toDecimal(order.taxTotal, order.currencyCode),
      toDecimal(order.total, order.currencyCode), toDecimal(order.paidTotal, order.currencyCode),
      toDecimal(order.refundedTotal, order.currencyCode), order.placedAt,
    ]),
  ));
}

// Embudo con comparación de períodos.
const comparison = analytics.reports.compare({ days: 30 });
reports.push(await write(
  'embudo.csv',
  ['periodo', 'inicio', 'fin', 'vistas', 'clics', 'conversiones', 'ctr_pct', 'conversion_pct', 'comision', 'venta_atribuida'],
  [
    ['actual', comparison.current.range.start, comparison.current.range.end, comparison.current.views,
      comparison.current.clicks, comparison.current.conversions, comparison.current.ctr,
      comparison.current.conversionRate, toDecimal(comparison.current.commission, 'USD'),
      toDecimal(comparison.current.attributedSales, 'USD')],
    ['anterior', comparison.previous.range.start, comparison.previous.range.end, comparison.previous.views,
      comparison.previous.clicks, comparison.previous.conversions, comparison.previous.ctr,
      comparison.previous.conversionRate, toDecimal(comparison.previous.commission, 'USD'),
      toDecimal(comparison.previous.attributedSales, 'USD')],
  ],
));

console.log('Informes generados en exports/:\n');
for (const report of reports) console.log(`  ${report.filename.padEnd(28)} ${report.rows} fila(s)`);
console.log('\nLos importes van en decimales. Las ventas atribuidas pertenecen al comercio externo,');
console.log('no son ingreso propio: el ingreso confirmado es solo la comisión pagada.');
await finish(app);
