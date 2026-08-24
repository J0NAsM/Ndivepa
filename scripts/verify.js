/**
 * Verificación de integridad (M-0020, M-1003).
 * Sale con código 1 si hay incidencias críticas, para poder usarlo en un hook o en CI.
 */
import { bootstrapCli, finish, printTable } from './lib/bootstrap.js';

const app = await bootstrapCli();
const diagnostics = app.container.resolve('diagnostics');
const referential = diagnostics.referentialIntegrity();
const invariants = diagnostics.invariants();
const conformance = diagnostics.conformance();
const all = [...referential, ...invariants, ...conformance];
const critical = all.filter(item => item.severity === 'critical');

console.log(`Integridad referencial: ${referential.length} incidencia(s)`);
console.log(`Reglas invariantes:     ${invariants.length} incidencia(s)`);
console.log(`Conformidad de módulos: ${conformance.length} incidencia(s)`);

if (all.length) {
  console.log('');
  printTable(
    all.map(item => ({ code: item.code, severity: item.severity, detalle: JSON.stringify(item).slice(0, 90) })),
    [{ key: 'severity', label: 'SEVERIDAD' }, { key: 'code', label: 'CÓDIGO' }, { key: 'detalle', label: 'DETALLE' }],
  );
}

console.log(`\n${critical.length ? `FALLO: ${critical.length} incidencia(s) crítica(s).` : 'Verificación superada.'}`);
await finish(app, { code: critical.length ? 1 : 0 });
