/**
 * Siembra idempotente de los datos base (M-1002).
 * Ejecutarlo dos veces no duplica nada: cada módulo siembra por clave natural.
 *
 * Antes este script arrancaba la aplicación **dos veces** para comparar el antes
 * y el después. Eso abría dos `Store` sobre el mismo `data/db.json`, cada uno con
 * su propia copia en memoria y su propia cola de escritura: el segundo podía
 * sobrescribir lo que el primero acabara de guardar. Ahora se arranca una sola
 * vez, se mide el documento antes de sembrar y se siembra sobre esa instancia.
 */
import { bootstrapCli, finish } from './lib/bootstrap.js';

// Sin semilla: primero se mide lo que ya hay.
const app = await bootstrapCli({ seed: false });
const before = { ...app.store.describe().collections };

await app.seed();

const after = app.store.describe().collections;
const changes = Object.entries(after)
  .map(([name, count]) => ({ name, before: before[name] ?? 0, after: count }))
  .filter(row => row.after !== row.before);

if (!changes.length) console.log('Nada que sembrar: los datos base ya existen.');
else {
  console.log('Semilla aplicada:');
  for (const row of changes) console.log(`  ${row.name.padEnd(24)} ${row.before} -> ${row.after}`);
}

await finish(app);
