/**
 * Validación de enlaces afiliados (M-0142, M-0457 … M-0459).
 *
 * Extraída del monolito y desminificada, con el comportamiento intacto. Dos reglas
 * del proyecto que este fichero **debe** respetar y que las pruebas protegen:
 *
 *  1. La validación **no hace ninguna petición de red**. Todo se decide con la
 *     configuración local: evita SSRF y evita scraping no autorizado al comercio.
 *  2. La URL de afiliado **no se reescribe nunca**. No se añaden UTMs, SubIDs ni
 *     redirecciones: eso rompería los términos del programa y podría invalidar la
 *     comisión.
 */

/** Hosts que no se admiten como destino, aunque la URL sea sintácticamente válida. */
export function isUnsafeHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost'
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.localhost')
    // IPv4 directa: sin nombre de dominio no hay comercio verificable.
    || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
    // IPv6 directa (los dos puntos ya se han desenvuelto de los corchetes).
    || host.includes(':')
  );
}

export function hostMatchesDomain(host, domain) {
  const left = String(host || '').toLowerCase();
  const right = String(domain || '').toLowerCase();
  return left === right || left.endsWith(`.${right}`);
}

const INVALID = messages => ({
  status: 'invalid',
  technical: 'invalid',
  commercial: 'unknown',
  tracking: 'unknown',
  policy: 'invalid',
  messages,
});

/**
 * @param {object} context catálogo local: `{merchants, programs, networks}`
 * @param {{affiliateUrl:string, merchantId?:string, programId?:string, productUrl?:string}} input
 * @returns {{status:'valid'|'warning'|'invalid', technical:string, commercial:string,
 *            tracking:string, policy:string, messages:string[], checkedAt:string}}
 */
export function validateAffiliateLink(context, input, timestamp = new Date().toISOString()) {
  let url;
  try {
    url = new URL(input.affiliateUrl);
  } catch {
    return { ...INVALID(['La URL de afiliado no tiene un formato válido.']), checkedAt: timestamp };
  }

  if (!['https:', 'http:'].includes(url.protocol) || isUnsafeHost(url.hostname)) {
    return { ...INVALID(['La URL usa un protocolo o host no permitido.']), checkedAt: timestamp };
  }

  const merchant = context.merchants.find(item => item.id === input.merchantId);
  const program = context.programs.find(item => item.id === input.programId);
  const network = program ? context.networks.find(item => item.id === program.networkId) : null;

  const messages = [];
  let commercial = 'valid';
  let tracking = 'valid';
  let policy = 'valid';

  if (url.protocol !== 'https:') messages.push('Usa HTTPS siempre que el programa lo permita.');

  if (!merchant) {
    commercial = 'warning';
    messages.push('No se encontró el comercio.');
  } else if (!merchant.domains?.some(domain => hostMatchesDomain(url.hostname, domain))) {
    commercial = 'warning';
    messages.push('El dominio no coincide con el comercio esperado.');
  } else if (merchant.status && merchant.status !== 'active') {
    commercial = 'warning';
    messages.push('El comercio está marcado como inactivo.');
  }

  if (!program || program.status !== 'active') {
    commercial = 'warning';
    messages.push('El programa está inactivo o no existe.');
  }

  if (program?.requiredTrackingKey) {
    const value = url.searchParams.get(program.requiredTrackingKey);
    if (!value) {
      tracking = 'invalid';
      messages.push(`Falta el parámetro de tracking ${program.requiredTrackingKey}.`);
    } else if (program.trackingId && value !== program.trackingId) {
      tracking = 'invalid';
      messages.push('El tracking ID no coincide con la cuenta configurada.');
    }
  }

  // Comprobación de política: si la red no autoriza redirecciones ni UTMs, se avisa
  // de que no se ha añadido nada, para que quede constancia de la decisión.
  if (network?.allowedTracking?.redirect === false) {
    messages.push('No se añadieron parámetros ni redirecciones: la red no los autoriza.');
  }
  if (network?.allowedTracking?.utm === false) {
    const utms = [...url.searchParams.keys()].filter(key => key.startsWith('utm_'));
    if (utms.length) {
      policy = 'warning';
      messages.push(`La red no autoriza UTMs y la URL trae ${utms.join(', ')}. Revísalo con el programa.`);
    }
  }

  if (!messages.length) {
    messages.push('Estructura, comercio y tracking verificados contra la configuración local.');
  }

  const status = tracking === 'invalid' ? 'invalid' : commercial === 'warning' || policy === 'warning' ? 'warning' : 'valid';
  return { status, technical: 'valid', commercial, tracking, policy, messages, checkedAt: timestamp };
}

/**
 * Estado de salud derivado de la validación. No refleja una comprobación HTTP real:
 * el proyecto no hace peticiones externas, y `httpCode` queda deliberadamente nulo.
 */
export function deriveHealth(validation, affiliateUrl) {
  let finalDomain = null;
  try {
    finalDomain = new URL(affiliateUrl).hostname;
  } catch {
    finalDomain = null;
  }
  return {
    state: validation.status === 'valid' ? 'healthy' : validation.status === 'invalid' ? 'down' : 'warning',
    checkedAt: validation.checkedAt,
    lastSuccessAt: validation.status === 'valid' ? validation.checkedAt : null,
    errors: validation.status === 'invalid' ? 1 : 0,
    httpCode: null,
    finalDomain,
  };
}
