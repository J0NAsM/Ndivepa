/**
 * Reconstruye el índice de búsqueda del catálogo (M-1005).
 */
import { bootstrapCli, finish } from './lib/bootstrap.js';

const app = await bootstrapCli();
const result = app.container.resolve('catalog').products.reindex();
const index = app.container.resolve('search').describe();

console.log(`Índice reconstruido: ${result.indexed} producto(s) publicados.`);
console.log(`  Términos: ${index.terms}`);
console.log(`  Documentos: ${index.documents}`);
await finish(app);
