import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, resolve } from 'node:path';

const [input] = process.argv.slice(2);
if (!input) {
  console.error('Uso: npm run verify-backup -- .\\backups\\db-AAAA-MM-DD.json');
  process.exitCode = 1;
} else {
  const backup = resolve(input);
  await access(backup, constants.R_OK);
  // Las copias de la aplicación usan `db-...sha256` y los snapshots internos
  // `archivo.json.sha256`; se aceptan ambos formatos para poder restaurar todo
  // el historial local sin renombrarlo.
  const checksumCandidates = [`${backup}.sha256`, backup.replace(/\.json$/i, '.sha256')];
  const checksumFile = await (async () => {
    for (const candidate of checksumCandidates) {
      try {
        await access(candidate, constants.R_OK);
        return candidate;
      } catch {
        // Probar el siguiente formato.
      }
    }
    throw new Error(`No se encontró el checksum para ${basename(backup)}.`);
  })();

  const payload = await readFile(backup);
  JSON.parse(payload.toString('utf8'));
  const expected = (await readFile(checksumFile, 'utf8')).trim().split(/\s+/)[0];
  const actual = createHash('sha256').update(payload).digest('hex');

  if (expected !== actual) {
    console.error(`FALLO: el checksum de ${basename(backup)} no coincide.`);
    process.exitCode = 1;
  } else {
    console.log(`Copia válida: ${basename(backup)}`);
    console.log(`SHA-256: ${actual}`);
  }
}
