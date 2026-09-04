/**
 * Jerarquía de errores tipados (M-0021 … M-0028).
 *
 * Cada error lleva `code` estable para el cliente, `status` HTTP y `details`
 * estructurados. La serialización nunca expone pilas ni rutas de disco en producción.
 */

export class NdivepaError extends Error {
  constructor(message, { code = 'error', status = 500, details = null, cause = null } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }

  toJSON() {
    const body = { code: this.code, message: this.message };
    if (this.details) body.details = this.details;
    return body;
  }
}

export class ValidationError extends NdivepaError {
  /** @param issues lista completa de campos inválidos, no solo el primero */
  constructor(issues = [], message = 'Los datos enviados no son válidos.') {
    super(message, { code: 'validation_error', status: 422, details: { issues } });
    this.issues = issues;
  }

  static single(field, message) {
    return new ValidationError([{ field, message }], message);
  }
}

/** Petición HTTP sintácticamente inválida (URL, cabeceras o cuerpo). */
export class BadRequestError extends NdivepaError {
  constructor(message = 'La solicitud no es válida.', details = null) {
    super(message, { code: 'bad_request', status: 400, details });
  }
}

export class NotFoundError extends NdivepaError {
  constructor(resource, identifier) {
    const message = identifier
      ? `No se encontró ${resource} con identificador ${identifier}.`
      : `No se encontró ${resource}.`;
    super(message, { code: 'not_found', status: 404, details: { resource, id: identifier ?? null } });
  }
}

export class ConflictError extends NdivepaError {
  constructor(message, details = null) {
    super(message, { code: 'conflict', status: 409, details });
  }
}

export class UnauthorizedError extends NdivepaError {
  constructor(message = 'Inicia sesión para continuar.') {
    super(message, { code: 'unauthorized', status: 401 });
  }
}

export class ForbiddenError extends NdivepaError {
  constructor(message = 'No tienes permiso para esta operación.', permission = null) {
    super(message, { code: 'forbidden', status: 403, details: permission ? { permission } : null });
  }
}

export class RateLimitError extends NdivepaError {
  constructor(retryAfterSeconds = 60, limit = null) {
    super('Demasiadas solicitudes; intenta de nuevo más tarde.', {
      code: 'rate_limited',
      status: 429,
      details: { retryAfter: retryAfterSeconds, limit },
    });
    this.retryAfter = retryAfterSeconds;
  }
}

export class PayloadTooLargeError extends NdivepaError {
  constructor(limitBytes) {
    super('Solicitud demasiado grande.', { code: 'payload_too_large', status: 413, details: { limitBytes } });
  }
}

/** Modo de comercio desactivado: la capacidad existe pero no está expuesta (M-0027, M-0204). */
export class NotAllowedError extends NdivepaError {
  constructor(capability, mode) {
    super(`La capacidad "${capability}" no está disponible en el modo ${mode}.`, {
      code: 'commerce_mode_disabled',
      status: 409,
      details: { capability, mode },
    });
  }
}

export class MethodNotAllowedError extends NdivepaError {
  constructor(allowed = []) {
    super('Método no permitido para esta ruta.', { code: 'method_not_allowed', status: 405, details: { allowed } });
    this.allowed = allowed;
  }
}

export class UnsupportedMediaTypeError extends NdivepaError {
  constructor(received) {
    super('Tipo de contenido no soportado.', {
      code: 'unsupported_media_type',
      status: 415,
      details: { received: received || null },
    });
  }
}

/** Transición de máquina de estados rechazada (M-0616). */
export class InvalidStateError extends NdivepaError {
  constructor(entity, from, to, allowed = []) {
    super(`No se puede pasar ${entity} de "${from}" a "${to}".`, {
      code: 'invalid_state_transition',
      status: 409,
      details: { entity, from, to, allowed },
    });
  }
}

/** Serializa cualquier error para una respuesta HTTP, sin filtrar detalles internos. */
export function serializeError(error, { exposeInternals = false } = {}) {
  if (error instanceof NdivepaError) return { status: error.status, body: { error: error.toJSON() } };
  const body = { error: { code: 'internal_error', message: 'Error interno del servidor.' } };
  if (exposeInternals) {
    body.error.details = { message: String(error?.message || error), stack: error?.stack || null };
  }
  return { status: 500, body };
}

export const isNdivepaError = value => value instanceof NdivepaError;
