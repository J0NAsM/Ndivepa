/**
 * Diagnóstico completo del sistema (M-1004).
 * Con `--json` imprime el informe entero para automatización.
 */
import { bootstrapCli, finish, printTable } from './lib/bootstrap.js';

const app = await bootstrapCli();
const report = app.container.resolve('diagnostics').report();

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
  await finish(app, { code: report.healthy ? 0 : 1 });
} else {
  const catalogs = report.catalogs;
  console.log('Ndivepa · diagnóstico\n');
  console.log(`  Estado                ${report.healthy ? 'correcto' : 'CON INCIDENCIAS'}`);
  console.log(`  Esquema               v${catalogs.storage.schemaVersion} (objetivo v${catalogs.storage.targetVersion})`);
  console.log(`  Módulos               ${catalogs.modules.modules.length}`);
  console.log(`  Permisos declarados   ${catalogs.permissions.length} recursos`);
  console.log(`  Eventos vistos        ${catalogs.events.events.length}`);
  console.log(`  Trabajos registrados  ${catalogs.jobs.handlers.length}`);
  console.log(`  Estrategias           ${catalogs.strategies.length}`);
  console.log(`  Workflows             ${catalogs.workflows.length}`);
  console.log(`  Índice de búsqueda    ${catalogs.search.documents} documentos, ${catalogs.search.terms} términos`);
  console.log(`  Traducciones faltan   ${catalogs.missingTranslations.length}`);
  console.log(`  Incidencias           ${report.counts.critical} críticas, ${report.counts.warning} avisos\n`);

  const rows = Object.entries(catalogs.storage.collections)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => ({ name, count }));
  console.log('Colecciones con datos:');
  printTable(rows, [{ key: 'name', label: 'COLECCIÓN' }, { key: 'count', label: 'REGISTROS' }]);

  if (report.counts.total) {
    console.log('\nIncidencias:');
    printTable(
      [...report.referentialIntegrity, ...report.invariants, ...report.conformance].map(item => ({
        severity: item.severity,
        code: item.code,
        detalle: JSON.stringify(item).slice(0, 80),
      })),
      [{ key: 'severity', label: 'SEV' }, { key: 'code', label: 'CÓDIGO' }, { key: 'detalle', label: 'DETALLE' }],
    );
  }
  await finish(app, { code: report.healthy ? 0 : 1 });
}
