# Arquitectura de Ndivepa

Documento de referencia técnica. Describe **cómo está hecho el proyecto**: el estado heredado
(v0.1, monolito), la arquitectura objetivo (v0.2, plataforma modular con paridad
Medusa + Vendure) y las reglas que no se negocian en ninguna de las dos.

---

## 1. Resumen ejecutivo

| Eje | v0.1 (heredado) | v0.2 (objetivo, en ejecución) |
| --- | --- | --- |
| Runtime | Node.js 20+, `node:http` puro, sin dependencias | Igual: cero dependencias de producción |
| Código servidor | `server.js` (23 líneas físicas, ~22 KB minificado) + `security.js` | `src/framework/**` + `src/modules/**` + `src/api/**` |
| Persistencia | `data/db.json` leído y reescrito completo en cada request | Repositorios sobre un *store* transaccional con escritura atómica y migraciones |
| HTTP | Monkey-patch de `Server.prototype.emit` | Pipeline explícito de middlewares + router con parámetros |
| Dominio | 11 colecciones afiliadas | ~60 dominios de comercio + los 11 afiliados |
| Frontend | `public/app.js` (46 líneas físicas, ~44 KB) SPA vanilla | Igual base, dividida en vistas y con panel de comercio |
| Pruebas | 12 pruebas HTTP end-to-end | Pruebas por capa: unidad (framework), dominio (módulos), HTTP (API) |
| Autenticación | Sesiones en `Map` en memoria, scrypt | Sesiones persistidas, API keys, RBAC granular, proveedores de auth |

La v0.2 **no reescribe desde cero**: envuelve el comportamiento existente. Todas las rutas y
respuestas de la v0.1 siguen funcionando; el código nuevo vive junto al heredado y lo sustituye
módulo a módulo con las pruebas como red de seguridad.

---

## 2. Estado heredado (v0.1)

### 2.1 Mapa de ficheros

```text
Ndivepa/
├── server.js                     # Servidor HTTP + API + dominio + persistencia (todo junto)
├── security.js                   # Cabeceras, rate limit, uploads, SEO server-side, SSRF
├── package.json                  # type: module, sin dependencias, scripts npm
├── data/db.json                  # Base de datos completa (documento único)
├── public/
│   ├── index.html                # Shell de la SPA
│   ├── app.js                    # SPA: tienda pública + panel administrativo
│   ├── store.css, styles.css, analytics.css
│   ├── guias.html, privacidad.html, robots.txt
│   └── uploads/                  # Imágenes subidas por el administrador
├── scripts/
│   ├── reset-data.js             # Borra data/db.json
│   ├── affiliate-maintenance.js  # Revisión local de enlaces/precios, genera alertas
│   ├── import-conversions.js     # CSV de conversiones -> conversiones + comisiones
│   ├── import-products.js        # CSV de productos -> productos + enlaces
│   ├── export-report.js          # CSV de rendimiento, conversiones y comisiones
│   ├── backup-data.js            # JSON + checksum SHA-256 en backups/
│   └── register-maintenance-task.ps1
├── test/http.test.js             # 12 pruebas end-to-end contra el servidor real
├── examples/*.csv                # Plantillas de importación
├── Dockerfile, docker-compose.yml
└── .context/                     # Esta documentación
```

### 2.2 `server.js` — responsabilidades mezcladas

Un único fichero contiene, en este orden:

1. **Constantes de arranque**: `root`, `dbPath`, `publicDir`, `port` (4300), `sessions` (`Map`),
   `ttl` (43 200 000 ms = 12 h).
2. **Utilidades**: `now()`, `id(prefix)` (UUID recortado a 8), `round()` (2 decimales),
   `hash(password, salt)` (scrypt 64 bytes).
3. **Semilla (`seed`)**: objeto literal con `schema: 'affiliate-v1'`, ajustes, 4 categorías,
   3 comercios, 3 redes, 3 programas, 1 campaña, 2 ubicaciones, 2 productos, 2 enlaces,
   2 eventos, 1 conversión, 1 comisión y 1 alerta.
4. **Persistencia**: `db()` lee y parsea `data/db.json`; si falla, clona la semilla. Si
   `schema !== 'affiliate-v1'`, descarta todo excepto `users`. `save(d)` reescribe el fichero
   completo con `JSON.stringify(d, null, 2)`.
5. **HTTP helpers**: `send`, `readBody`, `cookie`, `user`, `publicUser`, `admin`, `by`, `audit`.
6. **Validación de enlaces**: `unsafeHost`, `matching`, `validate`, `health`.
7. **Proyecciones**: `product()` (producto + categoría + comercio + programa + enlace),
   `summary()` (métricas del dashboard).
8. **Router improvisado**: `api()` es una cadena de `if (m === 'POST' && p[1] === '...')`.
9. **Redirección afiliada**: `go()`.
10. **Estáticos**: `file()` con tabla `mime` de 4 entradas.
11. **Arranque**: `createServer(...).listen(port)`.

### 2.3 `security.js` — la capa transversal

No exporta nada. Se importa por su efecto secundario: sustituye `Server.prototype.emit` por
`guardedEmit`, que intercepta cada evento `request` antes de que llegue al handler de
`server.js`. Hace:

- **Cabeceras de seguridad**: `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, CSP con
  `script-src 'self'` (sin `unsafe-inline` en scripts).
- **`writeHead` envuelto**: añade `Cache-Control: public, max-age=3600,
  stale-while-revalidate=86400` a estáticos y `; Secure` a las cookies si
  `NODE_ENV=production`.
- **Rate limiting** (`attempts: Map`, ventana por IP+ruta): login 10/15 min,
  `/api/events/view` 120/min, `/go/*` 60/min. Purga entradas caducadas al pasar de 2000 claves.
- **Límite de tamaño**: 413 si `content-length > 1 000 000`.
- **Uploads** (`POST /api/admin/uploads`): exige sesión de administrador leyendo
  `globalThis.ndivepaSessions` (puente frágil con `server.js`), acepta solo data-URI
  `image/png|jpeg|webp`, valida **firma binaria** (magic bytes), máximo 700 000 bytes, escribe
  con `flag: 'wx'` y nombre `randomUUID()`.
- **Consentimiento**: si `/go/:id` no lleva `consent=1`, redirige **sin registrar el clic**.
- **SEO server-side**: `/sitemap.xml`, `/robots.txt`, `/producto/:slug-:id` (HTML con canonical,
  Open Graph, Twitter card y JSON-LD `Product`/`Offer`) y `/campana/:codigo`.
- **Antifalsificación**: `escapeHtml` en todo lo interpolado y escape de `<` en el JSON-LD.

### 2.4 Modelo de datos heredado

`data/db.json` es un documento único con estas colecciones:

| Colección | Claves relevantes |
| --- | --- |
| `settings` | `storeName`, `currency`, `countries[]`, `affiliateDisclosure` |
| `users` | `id`, `name`, `email`, `role`, `salt`, `passwordHash` |
| `categories` | `id`, `name` |
| `merchants` | `id`, `name`, `domains[]`, `status` |
| `networks` | `id`, `name`, `status`, `allowedTracking{subId,sharedId,utm,redirect,deepLinks}` |
| `programs` | `merchantId`, `networkId`, `affiliateId`, `trackingId`, `requiredTrackingKey`, `commissionType`, `estimatedCommission` |
| `campaigns` | `code`, `startsAt`, `endsAt`, `channel`, `status` |
| `placements` | `key`, `name` |
| `affiliateProducts` | `categoryId`, `type`, `image`, `merchantId`, `programId`, `campaignId`, `monetizationType`, `status`, `price{...}` |
| `affiliateLinks` | `productId`, `productUrl`, `affiliateUrl`, `finalUrl`, `status`, `validation{...}`, `health{...}` |
| `events` | `type` (`product_view` / `affiliate_click`), `clickId`, `sessionId`, `source`, `medium`, `device`, `country`, `page`, `fraudFlag` |
| `conversions` | `networkConversionId`, `clickId`, `saleAmount`, `commission`, `status`, `source` |
| `commissions` | `conversionId`, `amount`, `status`, `payableAt`, `paidAt` |
| `payouts`, `alerts`, `audits`, `imports`, `webhooks` | operación y trazabilidad |

### 2.5 Contrato HTTP heredado

| Método | Ruta | Auth | Nota |
| --- | --- | --- | --- |
| GET | `/api/auth/me` | — | Devuelve `{user}` o `{user:null}` |
| POST | `/api/auth/login` | — | Cookie `ndivepa_session` HttpOnly SameSite=Lax |
| POST | `/api/auth/logout` | — | 204 + cookie vencida |
| POST | `/api/auth/password` | admin | Mínimo 12 caracteres |
| GET | `/api/store-config` | — | `settings` |
| GET | `/api/products` | — | Publicados; `?all=true` con sesión admin devuelve borradores |
| POST | `/api/events/view` | — | Registra `product_view` |
| GET | `/api/affiliate-summary` | admin | Métricas del dashboard |
| GET/POST/PATCH/DELETE | `/api/admin/{categories,merchants,networks,programs,campaigns,placements,links,conversions,commissions,payouts,alerts,audits,events}` | admin | CRUD genérico por tabla `mapped` |
| GET/POST/PATCH/DELETE | `/api/admin/products` | admin | CRUD con validación de enlace |
| POST | `/api/admin/links/validate` | admin | Validación previa |
| POST | `/api/admin/links/:id/validate` | admin | Revalida y crea alerta |
| POST | `/api/admin/uploads` | admin | Imagen data-URI |
| GET | `/go/:linkId` | — | 302 al `affiliateUrl` **sin modificarlo** |
| GET | `/producto/:slug-:id`, `/campana/:codigo`, `/sitemap.xml`, `/robots.txt` | — | HTML/XML server-side |

### 2.6 Deudas técnicas identificadas

1. **Un solo fichero para todo**: dominio, HTTP, persistencia y validación acoplados.
2. **Minificación manual**: código ilegible, imposible de revisar en diff.
3. **Escritura no atómica**: `writeFile` directo sobre `data/db.json`; un corte a mitad de
   escritura corrompe la base entera.
4. **Sin control de concurrencia**: dos requests simultáneos hacen *read-modify-write* y el
   último gana (pérdida silenciosa de escrituras).
5. **Lectura completa por request**: `db()` parsea todo el JSON en cada llamada.
6. **Sesiones en memoria**: se pierden al reiniciar; no escalan a más de un proceso.
7. **Monkey-patch de `Server.prototype.emit`**: afecta a *cualquier* servidor del proceso, rompe
   el orden natural de middlewares y hace el flujo difícil de seguir.
8. **`globalThis.ndivepaSessions`**: acoplamiento oculto entre `security.js` y `server.js`.
9. **CRUD genérico sin validación**: `mapped` acepta cualquier campo del body en `POST`/`PATCH`.
10. **`PATCH /api/admin/products` con `Object.assign`**: permite escribir campos arbitrarios.
11. **Sin paginación ni filtros**: los endpoints devuelven colecciones completas.
12. **Sin RBAC**: solo existe `role === 'admin'`, todo o nada.
13. **Sin CSRF**: cookie `SameSite=Lax` es la única defensa en mutaciones.
14. **Rate limit por IP en memoria**: se reinicia con el proceso, no distingue proxy.
15. **Sin migraciones**: cambiar de esquema descarta los datos.
16. **Sin bus de eventos ni trabajos**: todo es síncrono dentro del request.
17. **Sin i18n**: textos en español incrustados en el código.
18. **Sin OpenAPI**: el contrato solo existe en el README.
19. **Sin observabilidad**: `console.error` como único registro.
20. **`round()` en punto flotante**: el dinero se maneja como `Number`, no en unidades mínimas.

---

## 3. Arquitectura objetivo (v0.2)

### 3.1 Principios

1. **Cero dependencias de producción.** Todo se implementa sobre la biblioteca estándar de Node.
   Es la restricción más fuerte y la que da forma al diseño.
2. **Modular por dominio.** Cada módulo posee sus modelos, su servicio, sus rutas y sus pruebas.
   Un módulo no importa el servicio de otro: pide su dependencia al contenedor.
3. **El dominio no conoce HTTP.** Los servicios reciben y devuelven objetos planos. Las rutas
   traducen HTTP ↔ dominio.
4. **Persistencia intercambiable.** Los servicios hablan con repositorios; el repositorio decide
   si detrás hay JSON, SQLite o PostgreSQL.
5. **Todo cambio de estado es auditable.** Eventos de dominio + histórico + auditoría.
6. **Estrategias reemplazables.** Al estilo Vendure: cálculo de precio, código de pedido,
   asignación de stock, distribución de descuentos… son puntos de extensión, no `if`s.
7. **Compensación explícita.** Al estilo Medusa: los procesos de varios pasos son *workflows*
   con función de compensación por paso.
8. **El modo afiliado sigue siendo el predeterminado.** El comercio directo se activa por
   configuración, nunca por defecto.

### 3.2 Capas

```text
+----------------------------------------------------------------------+
|  public/  ·  SPA tienda + panel  ·  páginas SSR (SEO, campañas)       |
+-------------------------------+--------------------------------------+
                                | HTTP/JSON
+-------------------------------v--------------------------------------+
|  src/api/                                                            |
|    store/    rutas de tienda        admin/   rutas de panel          |
|    legacy/   compatibilidad v0.1    openapi  contrato generado       |
+-------------------------------+--------------------------------------+
                                | pipeline: cabeceras -> cors -> límites ->
                                | rate limit -> sesión -> RBAC -> router
+-------------------------------v--------------------------------------+
|  src/modules/**  ·  un servicio por dominio                          |
|  product · pricing · inventory · cart · order · payment · fulfillment|
|  promotion · customer · tax · region · channel · affiliate · ...      |
+-------------------------------+--------------------------------------+
                                | container.resolve()
+-------------------------------v--------------------------------------+
|  src/framework/  ·  container · store · repository · events · jobs   |
|  workflow · cache · locks · rbac · i18n · money · errors · logger    |
+-------------------------------+--------------------------------------+
                                |
+-------------------------------v--------------------------------------+
|  data/db.json (documento transaccional) · public/uploads · backups   |
+----------------------------------------------------------------------+
```

### 3.3 Estructura de directorios objetivo

```text
src/
├── framework/
│   ├── errors.js          # jerarquía tipada: NotFound, Invalid, Conflict, Unauthorized…
│   ├── ids.js             # identificadores con prefijo, ordenables por tiempo
│   ├── money.js           # aritmética en unidades mínimas, reparto con restos
│   ├── strings.js         # slug, escapeHtml, escapeXml, truncate, normalize
│   ├── validate.js        # validador declarativo de esquemas
│   ├── logger.js          # niveles, JSON estructurado, correlación de request
│   ├── config.js          # env + defaults + estrategias sustituibles
│   ├── container.js       # registro y resolución de módulos, ciclo de vida
│   ├── store.js           # persistencia atómica: tmp+rename, migraciones, snapshots
│   ├── repository.js      # consultas: filtros, operadores, orden, paginación, soft delete
│   ├── events.js          # bus de eventos: suscriptores, reintentos, cola de fallos
│   ├── jobs.js            # cola de trabajos: programación, reintento, backoff
│   ├── workflow.js        # pasos + compensación + reintentos + idempotencia
│   ├── cache.js           # caché con TTL, invalidación por etiqueta
│   ├── locks.js           # bloqueos con expiración
│   ├── rbac.js            # permisos por recurso y acción, roles compuestos
│   ├── i18n.js            # traducciones de interfaz y contenido
│   ├── customfields.js    # campos personalizados por entidad
│   ├── plugins.js         # carga de extensiones con hooks declarados
│   ├── search.js          # índice invertido, tokenización, facetas
│   ├── files.js           # almacenamiento de ficheros (local, extensible)
│   ├── notifications.js   # plantillas y proveedores de notificación
│   ├── analytics.js       # proveedores de analítica con consentimiento
│   ├── webhooks.js        # suscripciones, firma HMAC, reintentos
│   ├── ratelimit.js       # ventanas deslizantes, cubos, por clave
│   └── http/
│       ├── router.js      # método + patrón con `:param` y comodines
│       ├── pipeline.js    # composición de middlewares
│       ├── context.js     # request, respuesta, sesión, actor, alcance
│       ├── respond.js     # sobre de respuesta, paginación, errores
│       ├── middlewares.js # cabeceras, cors, csrf, body, auth, rbac, límites
│       └── openapi.js     # contrato generado desde las rutas
├── modules/
│   ├── settings/  store/  currency/  region/  tax/  channel/  seller/
│   ├── user/  role/  invite/  api-key/  auth/  session/
│   ├── customer/  customer-group/  address/
│   ├── asset/  product/  facet/  collection/  category/
│   ├── pricing/  price-list/  inventory/  stock-location/
│   ├── cart/  order/  draft-order/  return/  exchange/  claim/  refund/
│   ├── fulfillment/  shipping/  payment/  gift-card/  promotion/  campaign/
│   ├── notification/  history/  audit/  search/  translation/
│   └── affiliate/  # merchants, networks, programs, links, clicks, conversions,
│                   # commissions, payouts, alerts (dominio original)
└── api/
    ├── store/     # catálogo, carrito, pedido, cliente, pago, envío
    ├── admin/     # gestión completa
    └── legacy/    # rutas v0.1 intactas
```

### 3.4 Contrato de un módulo

Cada módulo exporta una definición con la misma forma. Ese contrato es lo que permite añadir
dominios sin tocar el arranque:

```js
// src/modules/<dominio>/index.js
export default {
  name: 'product',
  requires: ['store', 'events', 'pricing'],   // resueltas por el contenedor
  models: { product: productSchema, variant: variantSchema },
  migrations: [/* … */],
  register(container) { return new ProductService(container); },
  routes: { admin: adminRoutes, store: storeRoutes },
  subscribers: [{ event: 'product.created', handler: reindex }],
  jobs: [{ name: 'product.reindex', handler: reindexAll }],
};
```

### 3.5 Persistencia transaccional

`store.js` mantiene el documento en memoria y garantiza:

- **Escritura atómica**: se escribe `data/db.json.tmp` y se hace `rename` (operación atómica
  en el mismo volumen).
- **Serialización**: una única cola de escritura; no hay dos escrituras concurrentes.
- **Transacciones**: `store.transaction(fn)` clona el estado, aplica `fn`, valida y confirma;
  si `fn` lanza, no se persiste nada.
- **Migraciones versionadas**: `schemaVersion` numérico; cada migración transforma de `n` a
  `n+1` sin descartar datos.

### 3.6 Dinero

Todo importe se guarda en **unidades mínimas** (`amount: 99900`, `currency: 'USD'`,
`decimals: 2`). `money.js` centraliza suma, resta, porcentaje, reparto proporcional con
compensación de restos y formato. Nunca se suman `Number` con decimales.

### 3.7 Modo de monetización

`settings.commerceMode` decide qué API se expone:

| Modo | Catálogo | Carrito / Pedido | Pago | Envío | Afiliación |
| --- | --- | --- | --- | --- | --- |
| `AFFILIATE` (predeterminado) | sí | no | no | no | sí |
| `HYBRID` | sí | sí | sí (opcional) | sí | sí |
| `DIRECT` | sí | sí | sí | sí | no |

En `AFFILIATE` las rutas de carrito, pago y envío responden `409 commerce_mode_disabled`. El
modelo de datos existe siempre; lo que cambia es la superficie expuesta. Así se cumple el
principio de negocio original —Ndivepa no cobra al cliente— sin renunciar a la capacidad.

---

## 4. Reglas invariantes

Estas reglas se cumplen en v0.1 y deben cumplirse en v0.2. Cualquier cambio que las rompa es un
defecto, no una mejora.

1. **Un enlace de afiliado nunca se modifica.** No se añaden UTMs, SubIDs, parámetros ni
   redirecciones sin una regla explícita del programa (`network.allowedTracking`).
2. **Ninguna comprobación de enlaces hace peticiones externas.** Evita SSRF y scraping no
   autorizado.
3. **`localhost`, IPs directas, `.local`, `.internal`, IPv6 directa y protocolos no HTTP(S)
   están bloqueados** como destino.
4. **Una comisión `pending` no es ingreso.** Ventas atribuidas, comisión pendiente, aprobada y
   pagada son cuatro métricas distintas y se muestran separadas.
5. **Toda oferta muestra divulgación de afiliado** y los enlaces salientes llevan
   `rel="sponsored nofollow noopener"`.
6. **Sin consentimiento no hay analítica.** El clic redirige igual, pero no se registra.
7. **Los secretos viven en variables de entorno.** Nunca en `db.json`, documentos ni código.
8. **No se inventan datos.** Ni credenciales, ni textos legales, ni métricas de campo.
