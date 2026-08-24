import { existsSync, rmSync } from 'node:fs';

const path = new URL('../data/db.json', import.meta.url);
if (existsSync(path)) rmSync(path);
console.log('Datos de Ndivepa eliminados. Se recrearán al iniciar el servidor.');
