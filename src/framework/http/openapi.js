/**
 * Contrato OpenAPI generado desde las rutas (M-0139, M-0140, M-0889 … M-0893).
 *
 * El contrato se deriva de las rutas registradas, no se escribe a mano: así no puede
 * quedar desfasado. Cada ruta aporta su permiso, su esquema y sus códigos de error.
 */

const ERROR_SCHEMA = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
      },
    },
  },
};

const COMMON_RESPONSES = {
  400: 'Petición mal formada.',
  401: 'Falta autenticación.',
  403: 'Permiso insuficiente.',
  404: 'Recurso no encontrado.',
  405: 'Método no permitido.',
  409: 'Conflicto de estado o de unicidad.',
  413: 'Cuerpo demasiado grande.',
  415: 'Tipo de contenido no soportado.',
  422: 'Datos inválidos.',
  429: 'Límite de peticiones alcanzado.',
  500: 'Error interno.',
};

/** Traduce una regla de `validate.js` a un esquema JSON. */
function ruleToSchema(rule) {
  if (!rule) return { type: 'string' };
  const schema = {};
  const typeMap = { integer: 'integer', number: 'number', boolean: 'boolean', array: 'array', object: 'object', string: 'string', any: {} };
  schema.type = typeMap[rule.type] || 'string';
  if (rule.type === 'any') delete schema.type;
  if (rule.enum) schema.enum = rule.enum;
  if (rule.maxLength) schema.maxLength = rule.maxLength;
  if (rule.minLength) schema.minLength = rule.minLength;
  if (rule.min !== undefined) schema.minimum = rule.min;
  if (rule.max !== undefined) schema.maximum = rule.max;
  if (rule.format === 'email') schema.format = 'email';
  if (rule.format === 'url') schema.format = 'uri';
  if (rule.format === 'date') schema.format = 'date-time';
  if (rule.type === 'array' && rule.items) schema.items = ruleToSchema(rule.items);
  if (rule.type === 'object' && rule.shape) {
    schema.properties = Object.fromEntries(Object.entries(rule.shape).map(([key, inner]) => [key, ruleToSchema(inner)]));
  }
  if (rule.default !== undefined) schema.default = rule.default;
  return schema;
}

function schemaFor(fields) {
  if (!fields) return null;
  const required = Object.entries(fields).filter(([, rule]) => rule.required).map(([key]) => key);
  return {
    type: 'object',
    additionalProperties: false,
    ...(required.length ? { required } : {}),
    properties: Object.fromEntries(Object.entries(fields).map(([key, rule]) => [key, ruleToSchema(rule)])),
  };
}

/**
 * @param {object} options
 * @param {import('./router.js').Router} options.router
 * @param {object} options.config
 * @param {string} options.version
 */
export function buildOpenApi({ router, config, version = '0.2.0' }) {
  const paths = {};

  for (const route of router.routes) {
    const openApiPath = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\/\*$/, '/{path}');
    paths[openApiPath] = paths[openApiPath] || {};

    const parameters = [];
    for (const match of route.path.matchAll(/:([A-Za-z0-9_]+)/g)) {
      parameters.push({ name: match[1], in: 'path', required: true, schema: { type: 'string' } });
    }
    for (const [name, rule] of Object.entries(route.query || {})) {
      parameters.push({ name, in: 'query', required: Boolean(rule.required), schema: ruleToSchema(rule) });
    }

    const responses = {
      [String(route.status || 200)]: {
        description: route.responseDescription || 'Operación correcta.',
        content: { 'application/json': { schema: route.responseSchema || { type: 'object', additionalProperties: true } } },
      },
    };
    for (const code of route.errors || defaultErrors(route)) {
      responses[String(code)] = {
        description: COMMON_RESPONSES[code] || 'Error.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      };
    }

    const operation = {
      summary: route.summary || `${route.method} ${route.path}`,
      description: route.description || undefined,
      tags: route.tags?.length ? route.tags : [route.path.split('/')[2] || 'general'],
      operationId: route.operationId || `${route.method.toLowerCase()}${route.path.replace(/[^A-Za-z0-9]+/g, '_')}`,
      parameters: parameters.length ? parameters : undefined,
      security: route.permission === null ? [] : [{ sessionCookie: [] }, { apiKey: [] }],
      'x-permission': route.permission ?? null,
      responses,
    };

    const bodySchema = schemaFor(route.body);
    if (bodySchema && ['POST', 'PUT', 'PATCH'].includes(route.method)) {
      operation.requestBody = {
        required: Boolean(route.bodyRequired),
        content: { 'application/json': { schema: bodySchema, example: route.bodyExample || undefined } },
      };
    }

    paths[openApiPath][route.method.toLowerCase()] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Ndivepa API',
      version,
      description:
        'API de Ndivepa. La plataforma es AFFILIATE-first: en modo AFFILIATE las rutas de carrito, '
        + 'pago y envío responden 409 commerce_mode_disabled aunque el modelo de datos exista.',
      license: { name: 'Privado' },
    },
    servers: [{ url: config?.publicBaseUrl || `http://localhost:${config?.port || 4300}` }],
    tags: [...new Set(Object.values(paths).flatMap(item => Object.values(item).flatMap(op => op.tags || [])))]
      .sort()
      .map(name => ({ name })),
    paths,
    components: {
      schemas: {
        Error: ERROR_SCHEMA,
        ListEnvelope: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object', additionalProperties: true } },
            count: { type: 'integer' },
            limit: { type: ['integer', 'null'] },
            offset: { type: 'integer' },
            hasMore: { type: 'boolean' },
            cursor: { type: ['string', 'null'] },
          },
        },
        Money: {
          type: 'object',
          properties: {
            amount: { type: ['integer', 'null'], description: 'Importe en unidades mínimas.' },
            currency: { type: 'string' },
            decimals: { type: 'integer' },
            decimal: { type: ['number', 'null'] },
            formatted: { type: 'string' },
          },
        },
      },
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: config?.session?.cookieName || 'ndivepa_session' },
        apiKey: { type: 'http', scheme: 'bearer', description: 'Clave de API con permisos declarados.' },
        publishableKey: { type: 'apiKey', in: 'header', name: 'X-Publishable-Key', description: 'Token de canal para la API de tienda.' },
      },
    },
  };
}

function defaultErrors(route) {
  const codes = [422, 500];
  if (route.permission !== null) codes.unshift(401, 403);
  if (route.path.includes(':')) codes.push(404);
  return [...new Set(codes)].sort((a, b) => a - b);
}

/** Página de documentación sin dependencias externas: la CSP no permite CDNs. */
export function renderDocsPage(specUrl = '/api/openapi.json') {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>API de Ndivepa</title>
<style>
:root{--bg:#f6f8fc;--fg:#15213a;--muted:#62708a;--line:#e5e9f0;--card:#fff;--accent:#6457e9}
@media(prefers-color-scheme:dark){:root{--bg:#0f1424;--fg:#e8ecf6;--muted:#97a3bd;--line:#232c45;--card:#161d33}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,sans-serif}
main{width:min(1000px,calc(100% - 32px));margin:0 auto;padding:32px 0 64px}
h1{font-size:1.9rem;letter-spacing:-.03em;margin:0 0 4px}p.lead{color:var(--muted);margin:0 0 24px}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px}
input,select{padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
details{background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:8px;overflow:hidden}
summary{cursor:pointer;padding:10px 14px;display:flex;gap:10px;align-items:center;font-family:ui-monospace,monospace;font-size:.86rem}
summary::-webkit-details-marker{display:none}
.m{font-weight:800;font-size:.72rem;padding:2px 7px;border-radius:5px;color:#fff;min-width:56px;text-align:center}
.GET{background:#2b7a4b}.POST{background:#2a5bd7}.PATCH{background:#a2661b}.PUT{background:#7a4bd7}.DELETE{background:#b62a3a}
.body{padding:0 14px 14px;font-size:.86rem}
.tag{color:var(--muted);font-size:.76rem}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;font-size:.78rem}
.perm{color:var(--accent);font-weight:700}
h2{font-size:1rem;margin:26px 0 10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
</style></head><body><main>
<h1>API de Ndivepa</h1>
<p class="lead">Contrato generado desde las rutas registradas. <a href="${specUrl}">Descargar OpenAPI 3.1</a></p>
<div class="filters">
  <input id="q" type="search" placeholder="Filtrar por ruta o resumen" aria-label="Filtrar rutas">
  <select id="tag" aria-label="Filtrar por etiqueta"><option value="">Todas las etiquetas</option></select>
  <select id="scope" aria-label="Filtrar por acceso">
    <option value="">Público y privado</option><option value="public">Solo público</option><option value="private">Solo con permiso</option>
  </select>
</div>
<div id="out" aria-live="polite"></div>
</main><script>
const state={spec:null,q:'',tag:'',scope:''};
const el=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
fetch('${specUrl}').then(r=>r.json()).then(spec=>{
  state.spec=spec;
  const tags=[...new Set(Object.values(spec.paths).flatMap(p=>Object.values(p).flatMap(o=>o.tags||[])))].sort();
  el('tag').insertAdjacentHTML('beforeend',tags.map(t=>'<option>'+esc(t)+'</option>').join(''));
  render();
});
for(const id of ['q','tag','scope'])el(id).addEventListener('input',e=>{state[id]=e.target.value;render()});
function render(){
  const rows=[];
  for(const [path,item] of Object.entries(state.spec.paths))
    for(const [method,op] of Object.entries(item))
      rows.push({path,method:method.toUpperCase(),op});
  const filtered=rows.filter(r=>{
    if(state.q&&!(r.path+' '+(r.op.summary||'')).toLowerCase().includes(state.q.toLowerCase()))return false;
    if(state.tag&&!(r.op.tags||[]).includes(state.tag))return false;
    const isPublic=!r.op['x-permission'];
    if(state.scope==='public'&&!isPublic)return false;
    if(state.scope==='private'&&isPublic)return false;
    return true;
  }).sort((a,b)=>a.path.localeCompare(b.path)||a.method.localeCompare(b.method));
  const groups={};
  for(const r of filtered){const t=(r.op.tags||['general'])[0];(groups[t]=groups[t]||[]).push(r)}
  el('out').innerHTML=Object.keys(groups).sort().map(tag=>
    '<h2>'+esc(tag)+' · '+groups[tag].length+'</h2>'+groups[tag].map(r=>
      '<details><summary><span class="m '+r.method+'">'+r.method+'</span><span>'+esc(r.path)+'</span>'
      +(r.op['x-permission']?'<span class="perm">'+esc(r.op['x-permission'])+'</span>':'<span class="tag">público</span>')
      +'</summary><div class="body"><p>'+esc(r.op.summary||'')+'</p>'
      +(r.op.requestBody?'<pre>'+esc(JSON.stringify(r.op.requestBody.content['application/json'].schema,null,2))+'</pre>':'')
      +'<p class="tag">Respuestas: '+Object.keys(r.op.responses).join(', ')+'</p></div></details>').join('')
  ).join('')||'<p class="tag">Ninguna ruta coincide con el filtro.</p>';
}
</script></body></html>`;
}
