/**
 * Comprobación estática sin dependencias.
 *
 * El proyecto no arrastra un linter con su árbol de paquetes a propósito, así que
 * esta comprobación cubre lo que de verdad ha roto el repositorio alguna vez:
 *
 *  1. **Sintaxis**: cada fichero pasa por `node --check`. Un error de sintaxis en
 *     un módulo que solo se carga en una ruta poco visitada no aparecía hasta
 *     producción.
 *  2. **Importaciones locales resolubles**: un `import './x.js'` con el nombre
 *     mal escrito solo falla al ejecutar ese fichero. Aquí falla en CI.
 *  3. **Dependencias declaradas**: un `import` de paquete que no está en
 *     `package.json` construye una imagen que no arranca, que es exactamente lo
 *     que le pasaba al `Dockerfile`.
 *  4. **Restos de depuración**: `console.log` fuera de `scripts/`, `debugger`, y
 *     marcadores de conflicto de fusión.
 *
 * Sale con código 1 si encuentra algo. `--json` imprime el informe completo.
 */
import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const SCAN = ['src', 'scripts', 'test', 'public'];
const IGNORED = new Set(['node_modules', '.git', 'data', 'backups', 'exports', 'uploads']);

// `console` es la interfaz de los scripts de operación y del cliente del panel:
// ahí no es un resto de depuración, es la salida del programa.
const CONSOLE_ALLOWED = [`scripts${'/'}`, `public${'/'}`];

const findings = [];
const report = (file, line, rule, message) => findings.push({ file, line, rule, message });

async function walk(directory) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (extname(entry.name) === '.js') files.push(full);
  }
  return files;
}

/** Extrae los especificadores de `import`/`export ... from` y `import(...)`. */
function importSpecifiers(source) {
  const found = [];
  const patterns = [
    /(?:^|\n)\s*import\s[^;'"]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s[^;'"]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return [...new Set(found)];
}

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const declared = new Set([
  ...Object.keys(manifest.dependencies || {}),
  ...Object.keys(manifest.devDependencies || {}),
]);

const files = (await Promise.all(SCAN.map(directory => walk(join(root, directory))))).flat();
if (!files.length) {
  console.error('No se encontró ningún fichero que comprobar.');
  process.exit(1);
}

for (const file of files) {
  const shown = relative(root, file).replace(/\\/g, '/');
  const source = await readFile(file, 'utf8');

  // 1. Sintaxis.
  try {
    await run(process.execPath, ['--check', file]);
  } catch (error) {
    const detail = String(error.stderr || error.message).split('\n').find(row => row.includes('SyntaxError'))
      || 'sintaxis no válida';
    report(shown, 0, 'sintaxis', detail.trim());
    continue; // Sin sintaxis válida el resto de las comprobaciones no aporta nada.
  }

  // 2 y 3. Importaciones.
  for (const specifier of importSpecifiers(source)) {
    if (specifier.startsWith('node:') || specifier.startsWith('data:') || specifier.startsWith('http')) continue;
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const target = resolve(dirname(file), specifier);
      try {
        await stat(target);
      } catch {
        report(shown, lineOf(source, specifier), 'import-roto', `no existe "${specifier}"`);
      }
      continue;
    }
    // Paquete: se admite el subcamino (`graphql/utilities`).
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    if (!declared.has(name)) {
      report(shown, lineOf(source, specifier), 'dependencia-no-declarada', `"${name}" no está en package.json`);
    }
  }

  // 4. Restos de depuración y conflictos sin resolver.
  const lines = source.split(/\r?\n/);
  const consoleAllowed = CONSOLE_ALLOWED.some(prefix => shown.startsWith(prefix));
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    if (/^(?:<{7}|={7}|>{7})(?:\s|$)/.test(line)) {
      report(shown, number, 'conflicto', 'marcador de conflicto de fusión sin resolver');
    }
    if (/(^|[^.\w])debugger\s*;?\s*$/.test(line)) {
      report(shown, number, 'debugger', 'sentencia `debugger` en el código');
    }
    if (!consoleAllowed && /(^|[^.\w])console\.(log|debug|dir|trace)\s*\(/.test(line)) {
      report(shown, number, 'console', 'usa el `logger` de la aplicación en vez de `console`');
    }
  }
}

function lineOf(source, needle) {
  const index = source.indexOf(needle);
  if (index < 0) return 0;
  return source.slice(0, index).split(/\r?\n/).length;
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ files: files.length, findings }, null, 2));
} else {
  console.log(`Comprobación estática: ${files.length} fichero(s).`);
  if (findings.length) {
    console.log('');
    for (const finding of findings) {
      console.log(`  ${finding.file}:${finding.line}  [${finding.rule}] ${finding.message}`);
    }
  }
  console.log(`\n${findings.length ? `FALLO: ${findings.length} incidencia(s).` : 'Sin incidencias.'}`);
}

process.exitCode = findings.length ? 1 : 0;
