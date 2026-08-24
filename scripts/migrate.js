/**
 * Aplica las migraciones pendientes (M-1001).
 * El `Store` guarda un snapshot antes de tocar nada; si una migración falla, el
 * snapshot queda en `backups/snapshots/` y el proceso sale con código 1.
 */
import { bootstrapCli, finish } from './lib/bootstrap.js';

const app = await bootstrapCli();
const description = app.store.describe();

console.log('Migración completada.');
console.log(`  Versión de esquema: ${description.schemaVersion} (objetivo ${description.targetVersion})`);
console.log(`  Migraciones aplicadas: ${(app.store.read().migrations || []).length}`);
console.log(`  Checksum del documento: ${description.checksum}`);
console.log('\nRecuento por colección:');
for (const [name, count] of Object.entries(description.collections).filter(([, value]) => value > 0)) {
  console.log(`  ${name.padEnd(24)} ${count}`);
}

await finish(app);
