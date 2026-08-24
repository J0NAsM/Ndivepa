/**
 * Siembra idempotente de los datos base (M-1002).
 * Ejecutarlo dos veces no duplica nada: cada módulo siembra por clave natural.
 */
import { bootstrapCli, finish } from './lib/bootstrap.js';

const before = { ...(await bootstrapCli()).store.describe().collections };
const app = await bootstrapCli({ seed: true });
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
