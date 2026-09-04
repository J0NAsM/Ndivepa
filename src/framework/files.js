/**
 * Almacenamiento de ficheros (M-0110 … M-0113, M-0330 … M-0332).
 *
 * Contrato de proveedor al estilo `asset-storage-strategy` de Vendure. Solo el
 * proveedor local está implementado: S3 y CDN quedan declarados pero sin activar,
 * porque requieren credenciales que el proyecto no tiene.
 */
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { ValidationError } from './errors.js';

/** Firma binaria por tipo (M-0111): la extensión y el `mime` declarado se pueden falsear. */
export const SIGNATURES = {
  'image/png': bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/webp': bytes => bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP',
  'image/gif': bytes => bytes.subarray(0, 6).toString() === 'GIF89a' || bytes.subarray(0, 6).toString() === 'GIF87a',
  'image/avif': bytes => bytes.subarray(4, 8).toString() === 'ftyp' && bytes.subarray(8, 12).toString().startsWith('avif'),
  'application/pdf': bytes => bytes.subarray(0, 5).toString() === '%PDF-',
};

export const EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
};

/** Límite por tipo (M-0113). */
export const SIZE_LIMITS = {
  'image/png': 700_000,
  'image/jpeg': 700_000,
  'image/webp': 700_000,
  'image/gif': 900_000,
  'image/avif': 700_000,
  'application/pdf': 3_000_000,
};

/** Nombre generado, nunca el del cliente (M-0112, M-0331). */
export const namingStrategies = {
  uuid: ({ mime }) => `${randomUUID()}.${EXTENSIONS[mime] || 'bin'}`,
  hashed: ({ bytes, mime }) => `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${EXTENSIONS[mime] || 'bin'}`,
  dated: ({ mime }) => {
    const today = new Date().toISOString().slice(0, 10);
    return `${today}/${randomUUID()}.${EXTENSIONS[mime] || 'bin'}`;
  },
};

export class LocalFileProvider {
  constructor({ directory, publicPath = '/uploads' }) {
    this.directory = directory;
    this.publicPath = publicPath;
    this.name = 'local';
  }

  target(filename) {
    const base = resolve(this.directory);
    const target = resolve(base, String(filename || ''));
    if (target === base || !target.startsWith(base + sep) || String(filename).split(/[\\/]/).some(part => !part || part === '.' || part === '..')) {
      throw ValidationError.single('filename', 'Nombre de fichero no permitido.');
    }
    return target;
  }

  async save(filename, bytes) {
    const target = this.target(filename);
    await mkdir(join(target, '..'), { recursive: true });
    // `wx` falla si el fichero existe: nunca se sobrescribe en silencio.
    await writeFile(target, bytes, { flag: 'wx' });
    return { url: `${this.publicPath}/${filename.replace(/\\/g, '/')}`, path: target };
  }

  async remove(filename) {
    try { await unlink(this.target(filename)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async read(filename) {
    return readFile(this.target(filename));
  }
}

export class FileService {
  constructor({ provider, naming = 'uuid', allowed = Object.keys(SIGNATURES), maxBytes = null, logger } = {}) {
    this.provider = provider;
    this.naming = naming;
    this.allowed = allowed;
    this.maxBytes = maxBytes;
    this.logger = logger;
  }

  /** Decodifica y valida un data-URI. Devuelve bytes y tipo real. */
  decodeDataUri(input) {
    const match = /^data:([a-z]+\/[a-z0-9+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(input || ''));
    if (!match) throw ValidationError.single('data', 'El contenido debe ser un data-URI en base64.');
    const mime = match[1].toLowerCase();
    if (!this.allowed.includes(mime)) {
      throw ValidationError.single('data', `Tipo de fichero no admitido. Admitidos: ${this.allowed.join(', ')}.`);
    }
    const encoded = match[2].replace(/\s+/g, '');
    const limit = Math.min(SIZE_LIMITS[mime] || 700_000, this.maxBytes || Number.MAX_SAFE_INTEGER);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw ValidationError.single('data', 'El contenido base64 está mal formado.');
    }
    if (encoded.length > Math.ceil(limit / 3) * 4 + 4) {
      throw ValidationError.single('data', `El fichero excede el límite de ${Math.round(limit / 1000)} KB.`);
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length) throw ValidationError.single('data', 'El fichero está vacío.');
    if (bytes.length > limit) {
      throw ValidationError.single('data', `El fichero excede el límite de ${Math.round(limit / 1000)} KB.`);
    }
    const verify = SIGNATURES[mime];
    if (verify && !verify(bytes)) {
      throw ValidationError.single('data', 'El contenido no coincide con el tipo declarado.');
    }
    return { mime, bytes, hash: createHash('sha256').update(bytes).digest('hex') };
  }

  /** Guarda y devuelve los metadatos del fichero, incluido el hash para deduplicar. */
  async store(input, { naming = this.naming } = {}) {
    const { mime, bytes, hash } = this.decodeDataUri(input);
    const strategy = namingStrategies[naming];
    if (!strategy) throw ValidationError.single('naming', `Estrategia de nombre no reconocida: ${naming}.`);
    const filename = strategy({ bytes, mime });
    const saved = await this.provider.save(filename, bytes);
    const dimensions = readDimensions(bytes, mime);
    if (dimensions.width !== null && (
      dimensions.width < 1 || dimensions.height < 1
      || dimensions.width > 12_000 || dimensions.height > 12_000
      || dimensions.width * dimensions.height > 40_000_000
    )) {
      await this.provider.remove(filename).catch(() => {});
      throw ValidationError.single('data', 'Las dimensiones de la imagen no son válidas o son excesivas.');
    }
    return {
      url: saved.url,
      filename,
      mime,
      bytes: bytes.length,
      hash,
      dimensions,
      provider: this.provider.name,
    };
  }

  async remove(filename) {
    return this.provider.remove(filename);
  }
}

/**
 * Dimensiones leídas de la cabecera del propio fichero, sin decodificar la imagen.
 * Sirve para avisar de imágenes de baja resolución (M-0418) sin dependencias.
 */
export function readDimensions(bytes, mime) {
  try {
    if (mime === 'image/png') {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (mime === 'image/jpeg') {
      let offset = 2;
      while (offset < bytes.length - 9) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1];
        const length = bytes.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
    if (mime === 'image/webp' && bytes.subarray(12, 16).toString() === 'VP8X') {
      return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    }
  } catch {
    /* si la cabecera no es legible, no se inventa un tamaño */
  }
  return { width: null, height: null };
}
