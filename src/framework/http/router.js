/**
 * Router (M-0125 … M-0128).
 *
 * Sustituye la cadena de `if (m === 'POST' && p[1] === '...')` del monolito.
 * Resolución por método y segmentos, con `:param` y comodín final `*`. Si la ruta
 * existe pero el método no, responde 405 con `Allow` en lugar de un 404 engañoso.
 */
import { BadRequestError, MethodNotAllowedError, NotFoundError } from '../errors.js';

const PARAM = /^:(.+)$/;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const UNSAFE_PARAMETER = /[\/\\\0]/;

function decodeParameter(value, name) {
  try {
    const decoded = decodeURIComponent(value);
    if (UNSAFE_PARAMETER.test(decoded)) throw new Error('separator');
    return decoded;
  } catch {
    throw new BadRequestError(`El parámetro de ruta "${name}" no está codificado correctamente.`);
  }
}

export class Router {
  constructor({ prefix = '' } = {}) {
    this.prefix = prefix.replace(/\/+$/, '');
    this.routes = [];
  }

  /**
   * @param {object} definition
   * @param {string} definition.method
   * @param {string} definition.path patrón, por ejemplo `/products/:id/variants`
   * @param {Function} definition.handler
   * @param {string|null} definition.permission permiso requerido, o `null` si es pública
   * @param {object} definition.schema esquema de validación de cuerpo y query
   */
  add(definition) {
    const { method, path, handler } = definition;
    if (!method || !path || typeof handler !== 'function') {
      throw new Error(`Ruta mal declarada: ${method} ${path}`);
    }
    // Toda ruta administrativa debe declarar permiso o marcarse pública a propósito (M-0297).
    if (definition.permission === undefined) {
      throw new Error(`La ruta ${method} ${path} debe declarar \`permission\` (usa null para pública).`);
    }
    const upperMethod = String(method).toUpperCase();
    if (!METHODS.has(upperMethod)) throw new Error(`Método HTTP no soportado: ${method}.`);
    if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
      throw new Error(`La ruta debe empezar por / y no incluir consulta ni fragmento: ${path}.`);
    }
    const full = `${this.prefix}${path}`.replace(/\/+$/, '') || '/';
    const segments = full.split('/').filter(Boolean);
    const wildcard = segments.indexOf('*');
    if (wildcard >= 0 && wildcard !== segments.length - 1) throw new Error(`El comodín debe ser el último segmento: ${full}.`);
    for (const segment of segments) {
      if (segment.startsWith(':') && !/^:[A-Za-z][A-Za-z0-9_]*$/.test(segment)) {
        throw new Error(`Parámetro de ruta inválido en ${full}: ${segment}.`);
      }
    }
    if (this.routes.some(route => route.method === upperMethod && route.path === full)) {
      throw new Error(`Ruta duplicada: ${upperMethod} ${full}.`);
    }
    this.routes.push({
      ...definition,
      method: upperMethod,
      path: full,
      segments,
    });
    this.sortedCache = null;
    return this;
  }

  get(path, handler, options = {}) { return this.add({ ...options, method: 'GET', path, handler }); }
  post(path, handler, options = {}) { return this.add({ ...options, method: 'POST', path, handler }); }
  patch(path, handler, options = {}) { return this.add({ ...options, method: 'PATCH', path, handler }); }
  put(path, handler, options = {}) { return this.add({ ...options, method: 'PUT', path, handler }); }
  delete(path, handler, options = {}) { return this.add({ ...options, method: 'DELETE', path, handler }); }

  /** Incorpora las rutas de otro router. */
  merge(other) {
    for (const incoming of other.routes) {
      if (this.routes.some(route => route.method === incoming.method && route.path === incoming.path)) {
        throw new Error(`Ruta duplicada: ${incoming.method} ${incoming.path}.`);
      }
    }
    this.routes.push(...other.routes);
    this.sortedCache = null;
    return this;
  }

  static matchSegments(routeSegments, pathSegments) {
    const params = {};
    for (let index = 0; index < routeSegments.length; index += 1) {
      const expected = routeSegments[index];
      if (expected === '*') {
        params['*'] = pathSegments.slice(index).join('/');
        return params;
      }
      const actual = pathSegments[index];
      if (actual === undefined) return null;
      const parameter = PARAM.exec(expected);
      if (parameter) {
        params[parameter[1]] = decodeParameter(actual, parameter[1]);
        continue;
      }
      if (expected !== actual) return null;
    }
    return routeSegments.length === pathSegments.length ? params : null;
  }

  /**
   * Puntuación de especificidad: los segmentos literales pesan más que los
   * parámetros, y el comodín es siempre el último recurso. Sin esto,
   * `GET /links/health` quedaría capturado por `GET /links/:id` solo por haberse
   * registrado antes, y devolvería un 404 desconcertante.
   */
  static specificity(route) {
    let score = route.segments.length * 10;
    for (const segment of route.segments) {
      if (segment === '*') score -= 100;
      else if (PARAM.test(segment)) score -= 5;
      else score += 5;
    }
    return score;
  }

  /** Ordena una sola vez y reutiliza el resultado hasta que se añada otra ruta. */
  sorted() {
    if (this.sortedCache?.length === this.routes.length) return this.sortedCache;
    this.sortedCache = [...this.routes].sort((a, b) => Router.specificity(b) - Router.specificity(a));
    return this.sortedCache;
  }

  /**
   * @returns {{route:object, params:object}}
   * @throws {MethodNotAllowedError|NotFoundError}
   */
  resolve(method, pathname) {
    const segments = pathname.split('/').filter(Boolean);
    const upper = method.toUpperCase();
    const pathMatches = [];

    for (const route of this.sorted()) {
      const params = Router.matchSegments(route.segments, segments);
      if (!params) continue;
      pathMatches.push(route);
      if (route.method === upper) return { route, params };
      // HEAD se sirve con el manejador de GET, sin cuerpo (M-0193).
      if (upper === 'HEAD' && route.method === 'GET') return { route, params, headOnly: true };
    }

    if (pathMatches.length) {
      const allowed = [...new Set(pathMatches.map(route => route.method))];
      if (allowed.includes('GET')) allowed.push('HEAD');
      allowed.push('OPTIONS');
      throw new MethodNotAllowedError([...new Set(allowed)].sort());
    }
    throw new NotFoundError('ruta', pathname);
  }

  /** Métodos disponibles para una ruta, usado por `OPTIONS` (M-0194). */
  allowedFor(pathname) {
    const segments = pathname.split('/').filter(Boolean);
    const allowed = new Set();
    for (const route of this.routes) {
      if (Router.matchSegments(route.segments, segments)) {
        allowed.add(route.method);
        if (route.method === 'GET') allowed.add('HEAD');
      }
    }
    if (allowed.size) allowed.add('OPTIONS');
    return [...allowed].sort();
  }

  /** Inventario de rutas para el diagnóstico y para generar el OpenAPI. */
  list() {
    return this.routes.map(route => ({
      method: route.method,
      path: route.path,
      permission: route.permission ?? null,
      summary: route.summary || null,
      tags: route.tags || [],
      public: route.permission === null,
    }));
  }
}
