/**
 * Persistencia transaccional en documento (M-0054 … M-0061, M-1009 … M-1010).
 *
 * Resuelve las cinco deudas más graves del monolito:
 *  1. Escritura no atómica  -> se escribe un temporal y se hace `rename`.
 *  2. Escrituras concurrentes -> una única cola serializada.
 *  3. Lectura completa por request -> el documento vive en memoria.
 *  4. Sin transacciones -> `transaction()` confirma todo o nada.
 *  5. Migración destructiva -> migraciones versionadas con snapshot previo.
 */
import { readFile, writeFile, rename, mkdir, readdir, unlink, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { NdivepaError } from './errors.js';
import { now } from './dates.js';

export class Store {
  /**
   * @param {object} options
   * @param {string} options.file ruta del documento
   * @param {string} options.snapshotDir carpeta de snapshots previos a migración
   * @param {object} options.logger
   */
  constructor({ file, snapshotDir, logger, snapshotKeep = 10 }) {
    this.file = file;
    this.tempFile = `${file}.tmp`;
    this.snapshotDir = snapshotDir;
    this.snapshotKeep = snapshotKeep;
    this.logger = logger;
    this.state = null;
    this.migrations = [];
    this.collections = new Map();
    this.writeQueue = Promise.resolve();
    this.pendingEvents = [];
    this.stats = { reads: 0, writes: 0, transactions: 0, rollbacks: 0, migrations: 0 };
  }

  /** Declara una colección con su versión de esquema y su semilla. */
  declare(name, { schemaVersion = 1, seed = () => [], singleton = false } = {}) {
    this.collections.set(name, { schemaVersion, seed, singleton });
    return this;
  }

  /** Añade una migración `from -> from + 1`. Se aplican en orden. */
  migration({ from, to, description, up }) {
    this.migrations.push({ from, to, description, up });
    this.migrations.sort((a, b) => a.from - b.from);
    return this;
  }

  get targetVersion() {
    return this.migrations.reduce((max, migration) => Math.max(max, migration.to), 1);
  }

  async load() {
    let raw = null;
    try {
      raw = await readFile(this.file, 'utf8');
      this.stats.reads += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    if (raw === null) {
      this.state = this.emptyDocument();
    } else {
      try {
        this.state = JSON.parse(raw);
      } catch (error) {
        // Documento corrupto: recuperar desde el último snapshot antes de rendirse (M-0061).
        this.logger?.error('El documento de datos no se pudo leer; se intenta recuperar un snapshot.', error);
        this.state = await this.recoverFromSnapshot();
      }
    }

    await this.migrate();
    this.ensureCollections();
    return this.state;
  }

  emptyDocument() {
    return { schemaVersion: 0, createdAt: now(), updatedAt: now(), migrations: [] };
  }

  ensureCollections() {
    for (const [name, definition] of this.collections) {
      if (definition.singleton) {
        if (this.state[name] === undefined || this.state[name] === null) this.state[name] = {};
      } else if (!Array.isArray(this.state[name])) {
        this.state[name] = [];
      }
    }
  }

  /**
   * Aplica las migraciones pendientes. Nunca descarta datos: si una migración
   * falla, el snapshot previo queda en disco y el proceso se detiene.
   */
  async migrate() {
    const current = Number(this.state.schemaVersion || 0);
    const pending = this.migrations.filter(migration => migration.from >= current);
    if (!pending.length) {
      if (this.state.schemaVersion === undefined) this.state.schemaVersion = this.targetVersion;
      return { applied: [], from: current, to: this.state.schemaVersion };
    }

    await this.snapshot(`pre-migracion-v${current}`);
    const applied = [];
    for (const migration of pending) {
      try {
        const result = migration.up(this.state) || this.state;
        this.state = result;
        this.state.schemaVersion = migration.to;
        this.state.migrations = [
          ...(this.state.migrations || []),
          { from: migration.from, to: migration.to, description: migration.description, appliedAt: now() },
        ];
        applied.push(`${migration.from}->${migration.to}`);
        this.stats.migrations += 1;
        this.logger?.info('Migración aplicada', { from: migration.from, to: migration.to, description: migration.description });
      } catch (error) {
        throw new NdivepaError(
          `La migración ${migration.from}->${migration.to} falló: ${error.message}. Se conserva el snapshot previo.`,
          { code: 'migration_failed', status: 500, cause: error },
        );
      }
    }
    this.ensureCollections();
    await this.persist();
    return { applied, from: current, to: this.state.schemaVersion };
  }

  /** Copia del documento actual en `snapshotDir`, con rotación por antigüedad. */
  async snapshot(label = 'snapshot') {
    if (!this.snapshotDir) return null;
    await mkdir(this.snapshotDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = join(this.snapshotDir, `${label}-${stamp}.json`);
    const payload = JSON.stringify(this.state ?? {}, null, 2);
    await writeFile(target, payload);
    await writeFile(`${target}.sha256`, `${createHash('sha256').update(payload).digest('hex')}  ${target}\n`);
    await this.rotateSnapshots();
    return target;
  }

  async rotateSnapshots() {
    try {
      const entries = (await readdir(this.snapshotDir)).filter(name => name.endsWith('.json')).sort();
      const excess = entries.slice(0, Math.max(0, entries.length - this.snapshotKeep));
      for (const name of excess) {
        await unlink(join(this.snapshotDir, name)).catch(() => {});
        await unlink(join(this.snapshotDir, `${name}.sha256`)).catch(() => {});
      }
    } catch {
      /* la rotación es best-effort: no debe impedir el arranque */
    }
  }

  async recoverFromSnapshot() {
    try {
      const entries = (await readdir(this.snapshotDir)).filter(name => name.endsWith('.json')).sort();
      for (const name of entries.reverse()) {
        try {
          const payload = await readFile(join(this.snapshotDir, name));
          const checksum = (await readFile(join(this.snapshotDir, `${name}.sha256`), 'utf8')).trim().split(/\s+/)[0];
          const actual = createHash('sha256').update(payload).digest('hex');
          if (checksum !== actual) {
            this.logger?.warn('Snapshot descartado por checksum inválido.', { snapshot: name });
            continue;
          }
          const candidate = JSON.parse(payload.toString('utf8'));
          this.logger?.warn('Documento recuperado desde snapshot', { snapshot: name });
          await copyFile(this.file, `${this.file}.corrupto`).catch(() => {});
          return candidate;
        } catch {
          /* probar el siguiente snapshot */
        }
      }
    } catch {
      /* sin snapshots disponibles */
    }
    this.logger?.warn('No hay snapshot válido; se arranca con un documento vacío.');
    return this.emptyDocument();
  }

  /** Escritura atómica: temporal + rename (M-0054). */
  async persist() {
    this.state.updatedAt = now();
    const payload = JSON.stringify(this.state, null, 2);
    await mkdir(join(this.file, '..'), { recursive: true });
    await writeFile(this.tempFile, payload);
    await rename(this.tempFile, this.file);
    this.stats.writes += 1;
  }

  /**
   * Transacción (M-0056). Clona el estado, aplica el cambio y confirma. Si `mutator`
   * lanza, nada se persiste: el estado en memoria vuelve al valor previo.
   *
   * Todas las escrituras se serializan en una única cola (M-0055), de modo que dos
   * peticiones concurrentes no pueden perderse la una a la otra.
   */
  transaction(mutator, { events = [] } = {}) {
    const run = async () => {
      const backup = this.state;
      const draft = structuredClone(this.state);
      const collected = [...events];
      const context = {
        state: draft,
        emit: (name, payload) => collected.push({ name, payload }),
      };
      let result;
      try {
        result = await mutator(draft, context);
      } catch (error) {
        this.state = backup;
        this.stats.rollbacks += 1;
        throw error;
      }
      this.state = draft;
      try {
        await this.persist();
      } catch (error) {
        this.state = backup;
        this.stats.rollbacks += 1;
        throw error;
      }
      this.stats.transactions += 1;
      // Los eventos se publican solo cuando la transacción ya está en disco (M-0079).
      this.pendingEvents.push(...collected);
      return result;
    };

    const chained = this.writeQueue.then(run, run);
    this.writeQueue = chained.then(() => undefined, () => undefined);
    return chained;
  }

  /** Lectura sin copia: el llamador no debe mutar el resultado. */
  read() {
    if (!this.state) throw new NdivepaError('El almacenamiento no está cargado.', { code: 'store_not_loaded' });
    return this.state;
  }

  collection(name) {
    const value = this.read()[name];
    return Array.isArray(value) ? value : [];
  }

  /** Vacía y devuelve los eventos acumulados por transacciones confirmadas. */
  drainEvents() {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  /** Espera a que la cola de escritura quede vacía (apagado ordenado, M-1027). */
  async flush() {
    await this.writeQueue;
  }

  checksum() {
    return createHash('sha256').update(JSON.stringify(this.state)).digest('hex');
  }

  describe() {
    const counts = {};
    for (const [name, definition] of this.collections) {
      counts[name] = definition.singleton
        ? Object.keys(this.state?.[name] || {}).length
        : (this.state?.[name] || []).length;
    }
    return {
      schemaVersion: this.state?.schemaVersion ?? null,
      targetVersion: this.targetVersion,
      collections: counts,
      stats: { ...this.stats },
      checksum: this.checksum().slice(0, 16),
    };
  }
}
