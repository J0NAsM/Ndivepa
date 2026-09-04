/**
 * Arranque compartido por los scripts de operación (M-1001 … M-1008).
 *
 * Los scripts usan los **mismos servicios** que el servidor. Antes cada uno
 * manipulaba `data/db.json` a mano y reimplementaba la lógica: eso hizo que el
 * mantenimiento y el importador aplicaran reglas distintas de las del panel.
 */
import { createApp } from '../../src/app.js';

/**
 * Arranca la aplicación igual que el servidor, pero sin escuchar en un puerto.
 *
 * `seed` viene activado a propósito. Con la semilla desactivada, un `npm run
 * verify` sobre una instalación nueva creaba el documento con las colecciones
 * vacías y sin sembrar; el servidor arrancaba después, encontraba el fichero ya
 * migrado y dejaba la instalación a medias: catálogo vacío, panel sin datos y
 * `npm run check` en rojo. La semilla es idempotente, así que activarla aquí no
 * duplica nada y hace que los scripts vean la misma instalación que el servidor.
 *
 * @param {{seed?:boolean, jobs?:boolean}} options
 * @returns {Promise<object>} la aplicación construida, sin servidor HTTP
 */
export async function bootstrapCli({ seed = true, jobs = false } = {}) {
  const app = await createApp({
    env: { ...process.env, JOBS_ENABLED: jobs ? 'true' : 'false', LOG_LEVEL: process.env.LOG_LEVEL || 'info' },
    seed,
  });
  return app;
}

/** Cierra ordenadamente y devuelve el código de salida al proceso. */
export async function finish(app, { code = 0 } = {}) {
  await app.store.flush();
  await app.container.shutdown();
  process.exitCode = code;
}

/** Impresión de tabla simple, sin dependencias. */
export function printTable(rows, columns) {
  if (!rows.length) {
    console.log('  (sin resultados)');
    return;
  }
  const widths = columns.map(column => Math.max(
    column.label.length,
    ...rows.map(row => String(row[column.key] ?? '').length),
  ));
  const line = cells => `  ${cells.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ')}`;
  console.log(line(columns.map(column => column.label)));
  console.log(`  ${widths.map(width => '-'.repeat(width)).join('  ')}`);
  for (const row of rows) console.log(line(columns.map(column => row[column.key])));
}

/** Lee un argumento posicional obligatorio. */
export function requireArg(index, message) {
  const value = process.argv[index];
  if (!value) {
    console.error(message);
    process.exit(1);
  }
  return value;
}
