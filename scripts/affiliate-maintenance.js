/**
 * Mantenimiento local de afiliación (M-0143, M-0441, M-0553).
 *
 * Reescrito sobre los servicios del dominio: antes este script reimplementaba la
 * validación de enlaces y creaba alertas con su propio formato, lo que hacía que el
 * panel y el mantenimiento discreparan.
 *
 * Sigue sin visitar ningún sitio externo: todo se decide con la configuración local.
 */
import { bootstrapCli, finish, printTable } from './lib/bootstrap.js';
import { ageInDays } from '../src/framework/dates.js';

const app = await bootstrapCli();
const affiliate = app.container.resolve('affiliate');
const catalog = app.container.resolve('catalog');
const alerts = app.container.resolve('alert');
const settings = app.container.resolve('settings').settings;
const inventory = app.container.resolve('inventory');

const linkStaleDays = settings.get('affiliate.linkStaleDays', Number(process.env.LINK_STALE_DAYS) || 14);
const priceStaleDays = settings.get('affiliate.priceStaleDays', Number(process.env.PRICE_STALE_DAYS) || 30);

const findings = [];
const record = (code, detail) => findings.push({ code, ...detail });

// 1. Revalidación de los enlaces cuya comprobación ha envejecido.
let revalidated = 0;
for (const link of affiliate.links.repository.all({ active: true })) {
  const age = ageInDays(link.validation?.checkedAt);
  if (age !== null && age <= linkStaleDays) continue;
  const updated = await affiliate.links.revalidate(link.id);
  revalidated += 1;
  if (updated.status !== 'valid') {
    record('enlace_requiere_revision', { id: link.id, estado: updated.status, motivo: updated.validation?.messages?.[0] });
  }
}

// 2. Enlaces ya marcados como problemáticos.
for (const link of affiliate.links.repository.all({ active: true })) {
  if (link.status === 'invalid') record('enlace_invalido', { id: link.id, motivo: link.validation?.messages?.[0] });
  else if (link.status === 'warning') record('enlace_con_aviso', { id: link.id, motivo: link.validation?.messages?.[0] });
}

// 3. Precios del comercio sin verificar.
for (const link of affiliate.links.repository.all({ active: true })) {
  const age = ageInDays(link.merchantPrice?.verifiedAt);
  if (age === null) {
    record('precio_sin_verificar', { id: link.id });
    continue;
  }
  if (age > priceStaleDays) {
    record('precio_desactualizado', { id: link.id, dias: age });
    await alerts.raise({
      type: 'affiliate_price_stale',
      severity: 'warning',
      message: `El precio del enlace ${link.label || link.id} se verificó hace ${age} días (umbral ${priceStaleDays}).`,
      entityId: link.id,
      entityType: 'affiliateLink',
    });
  }
}

// 4. Programas inactivos con productos publicados.
for (const product of catalog.products.published()) {
  if (!product.programId) {
    record('producto_sin_programa', { id: product.id, nombre: product.name });
    continue;
  }
  const program = affiliate.programs.repository.byId(product.programId);
  if (!program || program.status !== 'active') {
    record('programa_inactivo', { id: product.id, nombre: product.name, programId: product.programId });
    await alerts.raise({
      type: 'program_inactive_published',
      severity: 'warning',
      message: `El producto «${product.name}» está publicado con un programa inactivo.`,
      entityId: product.id,
      entityType: 'product',
    });
  }
}

// 5. Productos publicados sin clics en el período de referencia.
const events = app.store.collection('events');
const clicksByProduct = new Map();
for (const event of events) {
  if (event.type !== 'affiliate_click') continue;
  clicksByProduct.set(event.productId, (clicksByProduct.get(event.productId) || 0) + 1);
}
for (const product of catalog.products.published()) {
  if (!clicksByProduct.get(product.id)) record('producto_sin_clics', { id: product.id, nombre: product.name });
}

// 6. Comisiones aprobadas sin pago y calidad del catálogo.
const overdue = affiliate.commissions.overdue({ days: 60 });
for (const commission of overdue) {
  record('comision_sin_pago', { id: commission.id, dias: commission.ageDays });
}
const quality = catalog.products.qualityReport();
for (const finding of quality.findings.filter(item => item.severity === 'critical')) {
  record(`catalogo_${finding.code}`, { ids: (finding.productIds || finding.variantIds || []).join(',') });
}

// 7. Stock bajo, solo si hay inventario gestionado.
const lowStock = await inventory.service.checkLowStock();

console.log('Ndivepa · mantenimiento local\n');
console.log(`  Enlaces revalidados          ${revalidated}`);
console.log(`  Umbral de enlace (días)      ${linkStaleDays}`);
console.log(`  Umbral de precio (días)      ${priceStaleDays}`);
console.log(`  Completitud media catálogo   ${quality.averageCompleteness} %`);
console.log(`  Alertas de stock             ${lowStock.raised}`);
console.log(`  Hallazgos                    ${findings.length}\n`);

if (findings.length) {
  const counts = new Map();
  for (const finding of findings) counts.set(finding.code, (counts.get(finding.code) || 0) + 1);
  printTable(
    [...counts.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
    [{ key: 'code', label: 'HALLAZGO' }, { key: 'count', label: 'CANTIDAD' }],
  );
  console.log('\nDetalle:');
  printTable(
    findings.slice(0, 40).map(finding => ({ code: finding.code, detalle: JSON.stringify(finding).slice(0, 90) })),
    [{ key: 'code', label: 'HALLAZGO' }, { key: 'detalle', label: 'DETALLE' }],
  );
  if (findings.length > 40) console.log(`  … y ${findings.length - 40} más.`);
}

console.log('\nEste script no visita sitios externos ni modifica ninguna URL de afiliado.');
console.log(`Alertas abiertas ahora: ${alerts.open().length}`);
await finish(app);
