/**
 * Exporta el contrato OpenAPI generado desde las rutas (M-1006).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { bootstrapCli, finish } from './lib/bootstrap.js';
import { buildHttpApp } from '../src/app.js';

const app = await bootstrapCli();
const { router, spec } = buildHttpApp(app);

const outDir = new URL('../exports/', import.meta.url);
await mkdir(outDir, { recursive: true });
await writeFile(new URL('openapi.json', outDir), JSON.stringify(spec, null, 2));

const publicRoutes = router.routes.filter(route => route.permission === null).length;
console.log(`Contrato exportado a exports/openapi.json`);
console.log(`  Rutas totales:  ${router.routes.length}`);
console.log(`  Públicas:       ${publicRoutes}`);
console.log(`  Con permiso:    ${router.routes.length - publicRoutes}`);
console.log(`  Caminos:        ${Object.keys(spec.paths).length}`);
await finish(app);
