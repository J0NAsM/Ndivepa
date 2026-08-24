import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const dbPath = new URL('../data/db.json', import.meta.url);
const backupDir = new URL('../backups/', import.meta.url);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = new URL(`db-${stamp}.json`, backupDir);
const checksumPath = new URL(`db-${stamp}.sha256`, backupDir);

let source;
try { source = await readFile(dbPath); } catch { console.error('No existe data/db.json. Inicia Ndivepa una vez antes de crear una copia.'); process.exit(1); }
try { JSON.parse(source.toString('utf8')); } catch { console.error('La base local no contiene JSON válido; no se creó una copia.'); process.exit(1); }

await mkdir(backupDir, { recursive: true });
await copyFile(dbPath, backupPath);
const copied = await readFile(backupPath);
const checksum = createHash('sha256').update(copied).digest('hex');
await writeFile(checksumPath, `${checksum}  ${new URL(backupPath).pathname.split('/').pop()}\n`, 'utf8');
console.log(`Copia verificada creada: ${backupPath.pathname}`);
console.log(`SHA-256: ${checksum}`);
