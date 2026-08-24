# Backlog de mejoras · M-0001 … M-1040

Lista numerada y accionable. Cada línea es una mejora verificable. El orden sigue
[Plan_Maestro.md](Plan_Maestro.md). El estado real de ejecución se lleva en
[Registro_De_Cambios.md](Registro_De_Cambios.md).

Marcas: `[x]` hecho · `[ ]` pendiente · `[!]` bloqueado por acceso externo (nunca se simula).

---

## Fase 0 · Preparación · M-0001 … M-0020

- [ ] M-0001 Copia de seguridad verificada con checksum antes de tocar código.
- [ ] M-0002 Congelar las 12 pruebas actuales como contrato de regresión intocable.
- [ ] M-0003 Documentar la arquitectura heredada fichero por fichero.
- [ ] M-0004 Documentar el modelo de datos heredado colección por colección.
- [ ] M-0005 Documentar el contrato HTTP heredado ruta por ruta.
- [ ] M-0006 Enumerar las 20 deudas técnicas del monolito con su impacto.
- [ ] M-0007 Inventariar los 36 módulos de Medusa desde el código fuente.
- [ ] M-0008 Inventariar los 37 servicios de dominio de Vendure desde el código fuente.
- [ ] M-0009 Inventariar las estrategias configurables de Vendure.
- [ ] M-0010 Inventariar condiciones y acciones de promoción de ambas plataformas.
- [ ] M-0011 Construir la matriz de paridad por capacidad.
- [ ] M-0012 Declarar las diferencias deliberadas frente a Medusa y Vendure.
- [ ] M-0013 Declarar las reglas invariantes del negocio afiliado.
- [ ] M-0014 Definir el modo de monetización (`AFFILIATE`/`HYBRID`/`DIRECT`).
- [ ] M-0015 Crear el árbol `src/framework`, `src/modules`, `src/api`.
- [ ] M-0016 Definir el contrato único de módulo (`name`, `requires`, `register`, `routes`).
- [ ] M-0017 Escribir el plan maestro por fases con criterio de verificación.
- [ ] M-0018 Escribir este backlog numerado.
- [ ] M-0019 Separar en el plan lo bloqueado por acceso externo de lo ejecutable.
- [ ] M-0020 Añadir `scripts/verify.js` como comprobación de integridad del arranque.

## Fase 1 · Framework base · M-0021 … M-0140

### Errores, identidad y utilidades

- [ ] M-0021 Jerarquía de errores tipados con `code`, `status` y `details`.
- [ ] M-0022 `NotFoundError` con recurso e identificador en el mensaje.
- [ ] M-0023 `ValidationError` que acumula todos los campos inválidos, no solo el primero.
- [ ] M-0024 `ConflictError` para violaciones de unicidad y estado.
- [ ] M-0025 `UnauthorizedError` y `ForbiddenError` diferenciados (401 vs 403).
- [ ] M-0026 `RateLimitError` con `retryAfter`.
- [ ] M-0027 `NotAllowedError` para el modo de comercio desactivado.
- [ ] M-0028 Serialización de error segura: nunca expone rutas de disco ni pilas en producción.
- [ ] M-0029 Identificadores con prefijo por entidad (`prod_`, `order_`, `cart_`).
- [ ] M-0030 Identificadores ordenables por tiempo para paginación estable.
- [ ] M-0031 Generador de códigos legibles para pedidos y cupones sin caracteres ambiguos.
- [ ] M-0032 `slug()` con normalización Unicode, colisiones y longitud máxima.
- [ ] M-0033 `escapeHtml` y `escapeXml` centralizados en un solo módulo.
- [ ] M-0034 `truncate` respetando palabras para descripciones y metadatos.
- [ ] M-0035 Aritmética de dinero en unidades mínimas, sin punto flotante.
- [ ] M-0036 Tabla de decimales por moneda (JPY 0, USD 2, CLP 0, PYG 0).
- [ ] M-0037 Porcentaje de dinero con redondeo definido y determinista.
- [ ] M-0038 Reparto proporcional de descuento con compensación de restos.
- [ ] M-0039 Formato de dinero por locale con moneda y decimales correctos.
- [ ] M-0040 Conversión entre unidades mínimas y decimales en los bordes de la API.
- [ ] M-0041 Utilidades de fecha: rango, período anterior comparable, solapamiento.
- [ ] M-0042 Comprobación de vigencia (`startsAt`/`endsAt`) reutilizable.
- [ ] M-0043 Agrupación por día, semana y mes para series temporales.

### Validación y configuración

- [ ] M-0044 Validador declarativo con tipos, requeridos, enums y longitudes.
- [ ] M-0045 Validación de objetos anidados y arrays de objetos.
- [ ] M-0046 Coerción explícita y controlada de tipos desde query string.
- [ ] M-0047 Rechazo de campos desconocidos en las mutaciones (allowlist).
- [ ] M-0048 Validación de formato de correo, URL, moneda ISO-4217 y país ISO-3166.
- [ ] M-0049 Mensajes de validación en español, con la clave del campo.
- [ ] M-0050 Carga de configuración desde entorno con valores por defecto tipados.
- [ ] M-0051 Registro de estrategias reemplazables al estilo Vendure.
- [ ] M-0052 Validación del arranque: la configuración inválida detiene el proceso.
- [ ] M-0053 Configuración imprimible sin secretos para diagnóstico.

### Persistencia

- [ ] M-0054 Escritura atómica del documento (`tmp` + `rename`).
- [ ] M-0055 Cola de escritura serializada: sin escrituras concurrentes.
- [ ] M-0056 Transacciones con confirmación o descarte completo.
- [ ] M-0057 Documento cargado una sola vez en memoria, no en cada request.
- [ ] M-0058 Migraciones versionadas de `n` a `n+1` sin pérdida de datos.
- [ ] M-0059 Migración inicial `affiliate-v1` -> `schemaVersion: 2` conservando todo.
- [ ] M-0060 Snapshot previo automático antes de aplicar migraciones.
- [ ] M-0061 Detección de documento corrupto con recuperación desde el último snapshot.
- [ ] M-0062 Repositorio con `list`, `retrieve`, `create`, `update`, `delete`, `count`.
- [ ] M-0063 Operadores de filtro `$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`.
- [ ] M-0064 Operadores de texto `$like`, `$ilike` y `$contains`.
- [ ] M-0065 Operadores lógicos `$and`, `$or`, `$not`.
- [ ] M-0066 Filtro por campos anidados con notación de punto.
- [ ] M-0067 Orden por varios campos con dirección independiente.
- [ ] M-0068 Paginación por `limit`/`offset` con total y `hasMore`.
- [ ] M-0069 Paginación por cursor estable para listados grandes.
- [ ] M-0070 Proyección `select` para devolver solo los campos pedidos.
- [ ] M-0071 Borrado lógico (`deletedAt`) con filtro por defecto que lo excluye.
- [ ] M-0072 Restauración de registros borrados lógicamente.
- [ ] M-0073 Índices en memoria por clave para búsquedas O(1) por `id` y por `handle`.
- [ ] M-0074 Comprobación de unicidad declarada por modelo.
- [ ] M-0075 Integridad referencial declarada: borrar en cascada o bloquear.
- [ ] M-0076 Marcas de tiempo automáticas `createdAt`/`updatedAt`.
- [ ] M-0077 `metadata` libre en toda entidad, validada como objeto plano.

### Eventos, trabajos y procesos

- [ ] M-0078 Bus de eventos con suscriptores por nombre y comodín.
- [ ] M-0079 Emisión de eventos agrupada al confirmar la transacción, no antes.
- [ ] M-0080 Reintento de suscriptor fallido con backoff exponencial.
- [ ] M-0081 Cola de eventos fallidos inspeccionable desde el panel.
- [ ] M-0082 Cola de trabajos con estados `pending`, `running`, `done`, `failed`.
- [ ] M-0083 Trabajos con reintentos, límite y registro del último error.
- [ ] M-0084 Trabajos programados por intervalo con marca de última ejecución.
- [ ] M-0085 Concurrencia limitada por nombre de trabajo.
- [ ] M-0086 Cancelación de trabajos en cola.
- [ ] M-0087 Bloqueos con expiración para procesos que no deben solaparse.
- [ ] M-0088 Caché con TTL e invalidación por etiqueta.
- [ ] M-0089 Motor de workflows con pasos y función de compensación por paso.
- [ ] M-0090 Compensación en orden inverso al fallar un paso.
- [ ] M-0091 Idempotencia de workflow por clave para reintentos seguros.
- [ ] M-0092 Registro del recorrido del workflow para depuración.
- [ ] M-0093 Contenedor con registro, resolución y detección de dependencias circulares.
- [ ] M-0094 Orden topológico de arranque de módulos.
- [ ] M-0095 Ciclo de vida `register` -> `boot` -> `shutdown` de cada módulo.

### Capacidades transversales

- [ ] M-0096 RBAC con permisos `recurso:acción` y comodines.
- [ ] M-0097 Roles compuestos y herencia de permisos.
- [ ] M-0098 Permiso especial de superadministrador auditado.
- [ ] M-0099 Alcance de permisos por canal para operadores de marketplace.
- [ ] M-0100 Diccionario i18n con idioma por defecto y respaldo.
- [ ] M-0101 Traducciones de contenido por entidad y campo.
- [ ] M-0102 Negociación de idioma por `Accept-Language` y parámetro explícito.
- [ ] M-0103 Definición de campos personalizados por entidad, con tipo y validación.
- [ ] M-0104 Campos personalizados públicos frente a internos.
- [ ] M-0105 Índice de búsqueda invertido con tokenización y normalización.
- [ ] M-0106 Búsqueda con prefijos y tolerancia a acentos.
- [ ] M-0107 Facetas calculadas con recuento por valor.
- [ ] M-0108 Sinónimos configurables en la búsqueda.
- [ ] M-0109 Reindexado incremental al cambiar una entidad.
- [ ] M-0110 Almacenamiento de ficheros con proveedor local y contrato extensible.
- [ ] M-0111 Validación de tipo por firma binaria, no por extensión.
- [ ] M-0112 Nombres de fichero generados, nunca los del cliente.
- [ ] M-0113 Límite de tamaño por tipo de fichero configurable.
- [ ] M-0114 Registro de notificaciones con plantillas y variables.
- [ ] M-0115 Proveedor de notificación local que solo registra, sin enviar nada.
- [ ] M-0116 Analítica con proveedor local y respeto estricto del consentimiento.
- [ ] M-0117 Webhooks con suscripción por evento y firma HMAC-SHA256.
- [ ] M-0118 Reintento de webhook con backoff y registro de entregas.
- [ ] M-0119 Rate limiting por clave configurable, no solo por IP+ruta.
- [ ] M-0120 Cabecera `Retry-After` y `X-RateLimit-*` en las respuestas limitadas.
- [ ] M-0121 Cargador de plugins con hooks declarados y orden determinista.
- [ ] M-0122 Registro estructurado en JSON con nivel configurable.
- [ ] M-0123 Correlación de peticiones con `requestId` propagado a los registros.
- [ ] M-0124 Métricas internas de latencia y conteo por ruta.

### HTTP

- [ ] M-0125 Router real con método y patrón `:param`.
- [ ] M-0126 Rutas con comodín para estáticos y subárboles.
- [ ] M-0127 Resolución de ruta en tiempo constante por método.
- [ ] M-0128 `405 Method Not Allowed` con cabecera `Allow` cuando la ruta existe.
- [ ] M-0129 Pipeline de middlewares explícito y ordenado.
- [ ] M-0130 Contexto de petición con actor, sesión, alcance e idioma.
- [ ] M-0131 Lectura de cuerpo con límite, tipo y errores claros.
- [ ] M-0132 Sobre de respuesta coherente para listas (`data`, `count`, `limit`, `offset`).
- [ ] M-0133 Errores HTTP con `code`, `message` y `details` estables.
- [ ] M-0134 CORS configurable por origen con lista blanca.
- [ ] M-0135 Protección CSRF por doble envío de token en mutaciones con cookie.
- [ ] M-0136 `ETag` e `If-None-Match` en respuestas cacheables.
- [ ] M-0137 `X-Request-Id` de entrada y salida.
- [ ] M-0138 Compresión condicional de respuestas grandes.
- [ ] M-0139 Generación de OpenAPI 3.1 desde la definición de rutas.
- [ ] M-0140 Página `/api/docs` que consume el OpenAPI generado.

## Fase 2 · Migración del monolito · M-0141 … M-0200

- [ ] M-0141 Extraer la semilla a `src/modules/**/seed.js` por dominio.
- [ ] M-0142 Extraer la validación de enlaces a `src/modules/affiliate/link-validation.js`.
- [ ] M-0143 Extraer la salud del enlace a su propio servicio.
- [ ] M-0144 Extraer las métricas del dashboard a `src/modules/analytics/`.
- [ ] M-0145 Extraer la proyección de producto afiliado a su módulo.
- [ ] M-0146 Extraer la autenticación a `src/modules/auth/`.
- [ ] M-0147 Extraer la gestión de sesiones a `src/modules/session/`.
- [ ] M-0148 Extraer la auditoría a `src/modules/audit/`.
- [ ] M-0149 Extraer las alertas a `src/modules/alert/`.
- [ ] M-0150 Extraer los eventos de tracking a `src/modules/tracking/`.
- [ ] M-0151 Extraer conversiones y comisiones a sus módulos.
- [ ] M-0152 Extraer pagos de comisión (`payouts`) a su módulo.
- [ ] M-0153 Extraer comercios, redes y programas a `src/modules/affiliate/`.
- [ ] M-0154 Extraer campañas y ubicaciones a sus módulos.
- [ ] M-0155 Extraer la subida de imágenes a `src/modules/asset/`.
- [ ] M-0156 Extraer las páginas SSR de SEO a `src/api/seo/`.
- [ ] M-0157 Extraer `sitemap.xml` y `robots.txt` a su propio servicio.
- [ ] M-0158 Extraer las páginas de campaña a su propia vista.
- [ ] M-0159 Eliminar el monkey-patch de `Server.prototype.emit`.
- [ ] M-0160 Eliminar el acoplamiento por `globalThis.ndivepaSessions`.
- [ ] M-0161 Desminificar `server.js` dejándolo como arranque legible.
- [ ] M-0162 Desminificar la validación de enlaces con comentarios de intención.
- [ ] M-0163 Desminificar el cálculo de métricas.
- [ ] M-0164 Migrar los importes de conversión y comisión a unidades mínimas.
- [ ] M-0165 Migrar `settings.currency` a `settings.currencies[]` con predeterminada.
- [ ] M-0166 Migrar `categories` planas a categorías jerárquicas.
- [ ] M-0167 Migrar `affiliateProducts` a `products` con variante única implícita.
- [ ] M-0168 Conservar `affiliateProducts` como vista de compatibilidad.
- [ ] M-0169 Migrar `users` a `users` + `roles` con rol `admin` completo.
- [ ] M-0170 Migrar sesiones en memoria a sesiones persistidas.
- [ ] M-0171 Añadir `schemaVersion` y retirar la comparación por cadena `schema`.
- [ ] M-0172 Nunca descartar datos por diferencia de esquema: migrar o fallar.
- [ ] M-0173 Compatibilidad `GET /api/products` con la forma de respuesta v0.1.
- [ ] M-0174 Compatibilidad `GET /api/store-config` con la forma v0.1.
- [ ] M-0175 Compatibilidad `GET /api/affiliate-summary` con las mismas claves.
- [ ] M-0176 Compatibilidad del CRUD genérico `/api/admin/:recurso`.
- [ ] M-0177 Compatibilidad de `POST /api/admin/links/validate`.
- [ ] M-0178 Compatibilidad de `POST /api/admin/links/:id/validate`.
- [ ] M-0179 Compatibilidad de `POST /api/admin/uploads`.
- [ ] M-0180 Compatibilidad de `/go/:linkId` incluida la regla de consentimiento.
- [ ] M-0181 Compatibilidad de `/producto/:slug-:id` con el mismo HTML mínimo.
- [ ] M-0182 Compatibilidad de `/campana/:codigo`.
- [ ] M-0183 Compatibilidad de `/sitemap.xml` y `/robots.txt`.
- [ ] M-0184 Validar el cuerpo de todas las rutas heredadas con allowlist.
- [ ] M-0185 Sustituir `Object.assign` en `PATCH /products` por campos permitidos.
- [ ] M-0186 Impedir la escritura de `id`, `createdAt` y `monetizationType` desde el cuerpo.
- [ ] M-0187 Añadir paginación opcional a las rutas heredadas sin romper el contrato.
- [ ] M-0188 Añadir filtros opcionales a las rutas heredadas.
- [ ] M-0189 Registrar cada mutación heredada en la auditoría nueva.
- [ ] M-0190 Emitir eventos de dominio en cada mutación heredada.
- [ ] M-0191 Tabla `mime` completa para estáticos (svg, webp, woff2, ico, xml, txt, map).
- [ ] M-0192 Protección de traversal en estáticos con resolución y comprobación de prefijo.
- [ ] M-0193 `HEAD` correcto en estáticos y en la API.
- [ ] M-0194 `OPTIONS` con `Allow` en todas las rutas.
- [ ] M-0195 Manejo de `Range` en estáticos para ficheros grandes.
- [ ] M-0196 `Last-Modified` y `304` en estáticos.
- [ ] M-0197 Apagado ordenado: cerrar conexiones y vaciar la cola de escritura.
- [ ] M-0198 Captura de `unhandledRejection` y `uncaughtException` con registro.
- [ ] M-0199 Prueba de regresión: las 12 pruebas originales sin modificar.
- [ ] M-0200 Prueba de migración: base v0.1 real migrada sin pérdida.

## Fase 3 · Fundamentos de comercio · M-0201 … M-0320

### Ajustes, tienda y moneda

- [ ] M-0201 Módulo `settings` con ajustes globales tipados.
- [ ] M-0202 Almacén de configuración clave-valor con alcance (`settings-store`).
- [ ] M-0203 `commerceMode` con los tres modos y validación de transición.
- [ ] M-0204 Bloqueo de rutas de comercio en modo `AFFILIATE` con error explícito.
- [ ] M-0205 Ajustes de la tienda: nombre, contacto, divulgación, idiomas.
- [ ] M-0206 Monedas soportadas por tienda con una predeterminada.
- [ ] M-0207 Catálogo de monedas con símbolo, decimales y nombre.
- [ ] M-0208 Redondeo por moneda configurable.
- [ ] M-0209 Tipo de cambio manual entre monedas (sin proveedor externo).
- [ ] M-0210 Ajustes de zona horaria y formato de fecha.
- [ ] M-0211 Ajustes de SEO por defecto (título, descripción, imagen social).
- [ ] M-0212 Ajustes de política de privacidad y consentimiento.
- [ ] M-0213 Historial de cambios de ajustes con autor.

### Regiones, países e impuestos

- [ ] M-0214 Módulo `region` con moneda, países y ajustes fiscales.
- [ ] M-0215 Catálogo de países ISO-3166 alfa-2 con nombre local.
- [ ] M-0216 Provincias/estados por país.
- [ ] M-0217 Zonas que agrupan países y provincias.
- [ ] M-0218 Resolución de zona a partir de una dirección.
- [ ] M-0219 Categorías de impuesto por producto.
- [ ] M-0220 Tasas de impuesto por zona y categoría.
- [ ] M-0221 Tasa por defecto de la región y sobrescritura por zona.
- [ ] M-0222 Impuesto incluido en el precio frente a añadido al total.
- [ ] M-0223 Cálculo de impuesto por línea con redondeo por línea o por total.
- [ ] M-0224 Exención de impuesto por cliente con número fiscal registrado.
- [ ] M-0225 Impuesto sobre el envío configurable por región.
- [ ] M-0226 Desglose de impuestos por tasa en el pedido.
- [ ] M-0227 Estrategia de cálculo de impuesto reemplazable.
- [ ] M-0228 Proveedor de impuesto externo. **[!]** Requiere credenciales.

### Canales y vendedores

- [ ] M-0229 Módulo `channel` con código, moneda y visibilidad.
- [ ] M-0230 Asignación de productos a canales.
- [ ] M-0231 Precios por canal.
- [ ] M-0232 Inventario visible por canal.
- [ ] M-0233 Canal por defecto y canal de administración.
- [ ] M-0234 Token de canal para la API de tienda.
- [ ] M-0235 Módulo `seller` con datos del vendedor.
- [ ] M-0236 Vendedor asociado a canal (marketplace).
- [ ] M-0237 División del pedido por vendedor con totales propios.
- [ ] M-0238 Comisión del marketplace por vendedor.
- [ ] M-0239 Alcance del operador limitado a su canal.

### Usuarios, roles y autenticación

- [ ] M-0240 Módulo `user` con estado, idioma y último acceso.
- [ ] M-0241 Módulo `role` con permisos granulares.
- [ ] M-0242 Catálogo de permisos derivado de los recursos registrados.
- [ ] M-0243 Roles predefinidos: superadmin, operador, editor de catálogo, soporte, analista.
- [ ] M-0244 Asignación de varios roles por usuario.
- [ ] M-0245 Invitaciones con token de un uso y caducidad.
- [ ] M-0246 Aceptación de invitación con creación de contraseña.
- [ ] M-0247 Revocación de invitación.
- [ ] M-0248 Claves de API con prefijo visible y secreto derivado.
- [ ] M-0249 Claves de API con permisos, caducidad y revocación.
- [ ] M-0250 Registro de último uso e IP de la clave de API.
- [ ] M-0251 Sesiones persistidas con `userAgent`, IP y caducidad.
- [ ] M-0252 Listado y revocación de sesiones propias.
- [ ] M-0253 Revocación de todas las sesiones al cambiar la contraseña.
- [ ] M-0254 Rotación del identificador de sesión al iniciar sesión.
- [ ] M-0255 Bloqueo temporal de cuenta tras intentos fallidos.
- [ ] M-0256 Registro de intentos de acceso fallidos con IP.
- [ ] M-0257 Política de contraseña: longitud, repetición y lista de comunes.
- [ ] M-0258 Contraseñas con scrypt y parámetros configurables.
- [ ] M-0259 Restablecimiento de contraseña con token de un uso.
- [ ] M-0260 Verificación de correo con token de un uso.
- [ ] M-0261 2FA TOTP con secreto cifrado y códigos de respaldo.
- [ ] M-0262 Proveedores de autenticación registrables (`emailpass` implementado).
- [ ] M-0263 Proveedores OAuth (Google, GitHub, OIDC). **[!]** Requiere credenciales.

### Clientes

- [ ] M-0264 Módulo `customer` con cliente registrado e invitado.
- [ ] M-0265 Conversión de invitado a registrado conservando su historial.
- [ ] M-0266 Grupos de cliente con asignación múltiple.
- [ ] M-0267 Direcciones múltiples con envío y facturación predeterminadas.
- [ ] M-0268 Validación de dirección por país (campos requeridos).
- [ ] M-0269 Historial del cliente con entradas tipadas.
- [ ] M-0270 Notas internas sobre el cliente.
- [ ] M-0271 Etiquetas de cliente para segmentación.
- [ ] M-0272 Métricas por cliente: pedidos, gasto, ticket medio, última compra.
- [ ] M-0273 Consentimiento de marketing y analítica por cliente.
- [ ] M-0274 Exportación de datos del cliente en JSON.
- [ ] M-0275 Anonimización del cliente conservando la integridad del pedido.
- [ ] M-0276 Búsqueda de clientes por correo, nombre y teléfono.

### Base común de módulos

- [ ] M-0277 Servicio base con CRUD, validación, eventos y auditoría.
- [ ] M-0278 Definición de modelo declarativa reutilizable.
- [ ] M-0279 Registro automático de rutas CRUD desde el modelo.
- [ ] M-0280 Permisos generados automáticamente por recurso.
- [ ] M-0281 Traducciones registradas automáticamente por campo traducible.
- [ ] M-0282 Campos personalizados registrados automáticamente por entidad.
- [ ] M-0283 Eventos `created`/`updated`/`deleted` automáticos por recurso.
- [ ] M-0284 Auditoría automática con antes/después por mutación.
- [ ] M-0285 Semilla por módulo, idempotente y desactivable.
- [ ] M-0286 Validación de integridad referencial al arrancar.
- [ ] M-0287 Comando para listar módulos, rutas y permisos registrados.
- [ ] M-0288 Contrato de módulo probado por una prueba de conformidad.
- [ ] M-0289 Detección de nombres de módulo duplicados en el arranque.
- [ ] M-0290 Diagnóstico de dependencias no satisfechas con mensaje claro.
- [ ] M-0291 Aislamiento: un módulo no importa el servicio de otro directamente.
- [ ] M-0292 Documentación generada de cada módulo con sus modelos y rutas.
- [ ] M-0293 Prueba de humo por módulo: registra, arranca y responde.
- [ ] M-0294 Métrica de tiempo de arranque por módulo.
- [ ] M-0295 Recuento de entidades por módulo en el diagnóstico.
- [ ] M-0296 Validación de que cada modelo declara `id` y marcas de tiempo.
- [ ] M-0297 Validación de que cada ruta declara permiso o es pública explícitamente.
- [ ] M-0298 Prohibición de rutas administrativas sin permiso declarado.
- [ ] M-0299 Prueba que falla si una ruta administrativa queda sin protección.
- [ ] M-0300 Prueba que falla si un modelo pierde su migración.
- [ ] M-0301 Registro de la versión de esquema por módulo.
- [ ] M-0302 Compatibilidad hacia atrás declarada por módulo.
- [ ] M-0303 Convención de nombres de evento `dominio.entidad.acción`.
- [ ] M-0304 Catálogo de eventos disponible en el diagnóstico.
- [ ] M-0305 Catálogo de trabajos disponible en el diagnóstico.
- [ ] M-0306 Catálogo de permisos disponible en el diagnóstico.
- [ ] M-0307 Catálogo de estrategias disponible en el diagnóstico.
- [ ] M-0308 Catálogo de campos personalizados en el diagnóstico.
- [ ] M-0309 Catálogo de traducciones faltantes en el diagnóstico.
- [ ] M-0310 Salida del diagnóstico en JSON para automatización.
- [ ] M-0311 Comprobación de que ningún módulo escribe fuera de su colección.
- [ ] M-0312 Comprobación de que ningún módulo persiste secretos.
- [ ] M-0313 Comprobación de que ningún módulo hace peticiones externas.
- [ ] M-0314 Comprobación de que ningún módulo modifica enlaces de afiliado.
- [ ] M-0315 Prueba que protege la regla de no modificar enlaces de afiliado.
- [ ] M-0316 Prueba que protege la regla de no hacer peticiones externas.
- [ ] M-0317 Prueba que protege la regla de consentimiento antes de analítica.
- [ ] M-0318 Prueba que protege la separación entre venta atribuida e ingreso.
- [ ] M-0319 Prueba que protege el bloqueo de destinos inseguros.
- [ ] M-0320 Prueba que protege la divulgación de afiliado en toda ficha.

## Fase 4 · Catálogo · M-0321 … M-0460

### Activos

- [ ] M-0321 Módulo `asset` con tipo, tamaño, dimensiones y `mime`.
- [ ] M-0322 Subida por data-URI validada por firma binaria.
- [ ] M-0323 Orden de activos por entidad.
- [ ] M-0324 Activo principal por producto y por variante.
- [ ] M-0325 Punto focal del activo para recortes.
- [ ] M-0326 Texto alternativo obligatorio para accesibilidad.
- [ ] M-0327 Etiquetas sobre activos.
- [ ] M-0328 Reutilización del mismo activo en varias entidades.
- [ ] M-0329 Borrado de activo bloqueado si está en uso.
- [ ] M-0330 Deduplicación por hash del contenido.
- [ ] M-0331 Estrategia de nombre de fichero reemplazable.
- [ ] M-0332 Estrategia de almacenamiento reemplazable (local implementada).
- [ ] M-0333 Almacenamiento S3 o CDN. **[!]** Requiere credenciales.

### Producto

- [ ] M-0334 Modelo `product` con `handle` único y estado.
- [ ] M-0335 Estados `draft`, `proposed`, `published`, `rejected` con transiciones.
- [ ] M-0336 Histórico de `handle` con redirección de la ficha antigua.
- [ ] M-0337 Subtítulo, descripción corta y descripción larga.
- [ ] M-0338 Tipo de producto (`physical`, `digital`, `service`, `course`, `bundle`, `subscription`).
- [ ] M-0339 Marca y fabricante.
- [ ] M-0340 Modelo `product-variant` con SKU único.
- [ ] M-0341 EAN, UPC, GTIN y código de barras en la variante.
- [ ] M-0342 Peso, largo, ancho, alto y unidad de medida.
- [ ] M-0343 Material y país de origen (HS code incluido).
- [ ] M-0344 Grupos de opciones y valores de opción.
- [ ] M-0345 Generación de la matriz de variantes desde las opciones.
- [ ] M-0346 Validación de combinación de opciones única por variante.
- [ ] M-0347 Orden de variantes y variante predeterminada.
- [ ] M-0348 Variante con activo propio.
- [ ] M-0349 Etiquetas de producto.
- [ ] M-0350 Tipos de producto como catálogo.
- [ ] M-0351 Colecciones manuales.
- [ ] M-0352 Colecciones por reglas evaluadas al vuelo.
- [ ] M-0353 Categorías jerárquicas con padre e hijos.
- [ ] M-0354 Ruta materializada de categoría para consultas rápidas.
- [ ] M-0355 Orden de categorías entre hermanas.
- [ ] M-0356 Categoría visible/oculta e interna.
- [ ] M-0357 Producto en varias categorías con una principal.
- [ ] M-0358 Facetas con valores y modo de filtro (uno o varios).
- [ ] M-0359 Facetas privadas para uso interno.
- [ ] M-0360 Asignación de valores de faceta a producto y variante.
- [ ] M-0361 Productos relacionados, alternativas y accesorios.
- [ ] M-0362 Producto paquete (bundle) con componentes y cantidades.
- [ ] M-0363 Producto digital con entregable y límite de descargas.
- [ ] M-0364 Producto suscripción con período y renovación.
- [ ] M-0365 Perfil de envío por producto.
- [ ] M-0366 Metadatos SEO por producto con canonical propio.
- [ ] M-0367 Campos personalizados en producto y variante.
- [ ] M-0368 Traducciones de nombre, descripción y `handle` por idioma.
- [ ] M-0369 Duplicado de producto con variantes y activos.
- [ ] M-0370 Publicación y despublicación en lote.
- [ ] M-0371 Asignación de canal en lote.
- [ ] M-0372 Importación de catálogo por CSV con informe de errores por fila.
- [ ] M-0373 Exportación de catálogo por CSV.
- [ ] M-0374 Validación de que un producto publicado tiene precio o enlace.
- [ ] M-0375 Validación de que una variante publicada tiene SKU.
- [ ] M-0376 Aviso cuando un producto publicado no tiene activo.
- [ ] M-0377 Aviso cuando un producto publicado no tiene categoría.
- [ ] M-0378 Aviso cuando un producto afiliado no tiene enlace válido.
- [ ] M-0379 Contador de vistas y clics por variante.
- [ ] M-0380 Marca de producto destacado con orden manual.

### Búsqueda y descubrimiento

- [ ] M-0381 Índice de catálogo con nombre, descripción, SKU, marca y facetas.
- [ ] M-0382 Búsqueda por término con puntuación por campo.
- [ ] M-0383 Filtro por categoría, colección, faceta, precio y disponibilidad.
- [ ] M-0384 Orden por relevancia, precio, novedad y popularidad.
- [ ] M-0385 Recuento de facetas del resultado actual.
- [ ] M-0386 Sugerencias de autocompletado.
- [ ] M-0387 Corrección aproximada de errores tipográficos.
- [ ] M-0388 Sinónimos por idioma.
- [ ] M-0389 Términos vacíos registrados para mejorar el catálogo.
- [ ] M-0390 Reindexado completo e incremental.
- [ ] M-0391 Reindexado como trabajo en cola, no en el request.
- [ ] M-0392 Búsqueda restringida por canal y por estado de publicación.
- [ ] M-0393 Búsqueda con paginación estable.
- [ ] M-0394 Resultados sin productos ocultos ni borradores para el público.
- [ ] M-0395 Prueba de que la búsqueda nunca expone borradores.

### Contenido editorial

- [ ] M-0396 Módulo de páginas de contenido con `handle` y estado.
- [ ] M-0397 Guías editoriales con productos referenciados.
- [ ] M-0398 Comparativas editoriales con criterios declarados.
- [ ] M-0399 Bloques de contenido reutilizables.
- [ ] M-0400 Programación de publicación de contenido.
- [ ] M-0401 Autor y fecha de revisión editorial.
- [ ] M-0402 Aviso de contenido desactualizado por antigüedad.
- [ ] M-0403 Divulgación de afiliado obligatoria en contenido con enlaces.
- [ ] M-0404 Traducción de contenido editorial.
- [ ] M-0405 Metadatos SEO por página de contenido.
- [ ] M-0406 Índice de contenido en el sitemap.
- [ ] M-0407 Datos estructurados `Article` y `ItemList` cuando corresponda.
- [ ] M-0408 Enlaces internos entre contenido y fichas.
- [ ] M-0409 Recuento de clics salientes por pieza de contenido.
- [ ] M-0410 Prueba de que el contenido publicado lleva divulgación.

### Calidad del catálogo

- [ ] M-0411 Puntuación de completitud por producto.
- [ ] M-0412 Detección de descripciones duplicadas.
- [ ] M-0413 Detección de nombres casi idénticos.
- [ ] M-0414 Detección de SKU duplicado entre variantes.
- [ ] M-0415 Detección de precio ausente en producto publicado.
- [ ] M-0416 Detección de precio sospechoso (cero o negativo).
- [ ] M-0417 Detección de descuento imposible (anterior menor que actual).
- [ ] M-0418 Detección de imagen ausente o de baja resolución.
- [ ] M-0419 Detección de texto alternativo ausente.
- [ ] M-0420 Detección de categoría huérfana.
- [ ] M-0421 Detección de faceta sin valores.
- [ ] M-0422 Detección de colección vacía.
- [ ] M-0423 Detección de variante sin inventario en modo directo.
- [ ] M-0424 Detección de producto sin canal asignado.
- [ ] M-0425 Informe de calidad del catálogo exportable.
- [ ] M-0426 Alerta cuando la completitud media baja de un umbral.
- [ ] M-0427 Panel con las diez fichas peor puntuadas.
- [ ] M-0428 Sugerencia automática de categoría por palabras del nombre.
- [ ] M-0429 Sugerencia de facetas a partir de atributos existentes.
- [ ] M-0430 Prueba del cálculo de completitud.

### Catálogo afiliado integrado

- [ ] M-0431 El producto afiliado es un producto con `monetizationType: AFFILIATE`.
- [ ] M-0432 Un producto puede tener enlace afiliado y venta directa a la vez.
- [ ] M-0433 Prioridad de monetización configurable por producto.
- [ ] M-0434 Comparación entre precio propio y precio del comercio afiliado.
- [ ] M-0435 Aviso cuando el precio propio es peor que el afiliado.
- [ ] M-0436 Enlaces afiliados múltiples por producto (varios comercios).
- [ ] M-0437 Selección del mejor enlace por precio, disponibilidad o prioridad.
- [ ] M-0438 Historial de precio del comercio afiliado.
- [ ] M-0439 Gráfico de evolución de precio afiliado.
- [ ] M-0440 Alerta de bajada de precio afiliado.
- [ ] M-0441 Alerta de enlace afiliado roto por antigüedad de validación.
- [ ] M-0442 Validación en lote de todos los enlaces afiliados.
- [ ] M-0443 Cola de revisión de enlaces con estado y responsable.
- [ ] M-0444 Bloqueo de publicación con enlace inválido.
- [ ] M-0445 Registro de cada revalidación con su resultado.
- [ ] M-0446 Comparativa de comisión estimada entre programas del mismo comercio.
- [ ] M-0447 Recomendación del programa con mejor comisión estimada.
- [ ] M-0448 Aviso si el programa está inactivo pero el producto sigue publicado.
- [ ] M-0449 Aviso si el dominio del enlace no pertenece al comercio.
- [ ] M-0450 Aviso si falta el parámetro de tracking requerido.
- [ ] M-0451 Aviso si el tracking ID no coincide con la cuenta del programa.
- [ ] M-0452 Registro del motivo de cada aviso en la alerta.
- [ ] M-0453 Resolución de alerta con nota y autor.
- [ ] M-0454 Reapertura de alerta si el problema vuelve.
- [ ] M-0455 Métricas de salud del catálogo afiliado.
- [ ] M-0456 Exportación de la salud de enlaces.
- [ ] M-0457 Prueba de que un enlace nunca se reescribe al validarlo.
- [ ] M-0458 Prueba de que la validación no hace peticiones de red.
- [ ] M-0459 Prueba de que un destino inseguro siempre queda inválido.
- [ ] M-0460 Prueba de que el producto con enlace inválido no se publica.

## Fase 5 · Precios e inventario · M-0461 … M-0580

### Precios

- [ ] M-0461 Conjuntos de precios (`price-set`) por variante.
- [ ] M-0462 Precio por moneda dentro del conjunto.
- [ ] M-0463 Reglas de precio por región, canal, grupo de cliente y cantidad.
- [ ] M-0464 Precio calculado eligiendo la regla más específica.
- [ ] M-0465 Desempate determinista entre reglas de igual especificidad.
- [ ] M-0466 Precios escalonados por cantidad mínima y máxima.
- [ ] M-0467 Listas de precios con tipo `sale` y `override`.
- [ ] M-0468 Vigencia de lista de precios con inicio y fin.
- [ ] M-0469 Lista de precios restringida a grupos de cliente.
- [ ] M-0470 Estado de lista de precios (`active`, `draft`, `expired`).
- [ ] M-0471 Prioridad entre listas solapadas.
- [ ] M-0472 Precio original y precio con descuento mostrados por separado.
- [ ] M-0473 Cálculo del porcentaje de descuento a partir de ambos precios.
- [ ] M-0474 Precio mínimo y máximo por producto con variantes.
- [ ] M-0475 Precio por unidad de medida (por kilo, por litro).
- [ ] M-0476 Precio con impuestos incluidos calculado por región.
- [ ] M-0477 Estrategia de cálculo de precio de línea reemplazable.
- [ ] M-0478 Manejo de cambio de precio en carrito abierto con aviso.
- [ ] M-0479 Congelado del precio en la línea al confirmar el pedido.
- [ ] M-0480 Historial de cambios de precio con autor y fecha.
- [ ] M-0481 Importación de precios por CSV.
- [ ] M-0482 Exportación de precios por CSV.
- [ ] M-0483 Actualización de precios en lote por porcentaje.
- [ ] M-0484 Simulador de precio: variante, región, canal, grupo y cantidad.
- [ ] M-0485 Validación de que toda variante publicada tiene precio en su moneda.
- [ ] M-0486 Alerta de variante sin precio en una moneda soportada.
- [ ] M-0487 Prueba del precio calculado con reglas solapadas.
- [ ] M-0488 Prueba de precios escalonados en los límites de cantidad.
- [ ] M-0489 Prueba de lista de precios caducada que no aplica.
- [ ] M-0490 Prueba de impuesto incluido frente a añadido.

### Inventario

- [ ] M-0491 Módulo `inventory` con artículos desacoplados de la variante.
- [ ] M-0492 Vínculo variante ↔ artículo de inventario con cantidad requerida.
- [ ] M-0493 Niveles por ubicación con `stocked`, `reserved` e `incoming`.
- [ ] M-0494 Cantidad disponible calculada (`stocked - reserved`).
- [ ] M-0495 Reservas con referencia al pedido o carrito.
- [ ] M-0496 Liberación de reserva al cancelar o caducar.
- [ ] M-0497 Caducidad automática de reservas de carrito.
- [ ] M-0498 Movimientos de stock tipados y auditables.
- [ ] M-0499 Movimiento `allocation` al confirmar el pedido.
- [ ] M-0500 Movimiento `sale` al enviar.
- [ ] M-0501 Movimiento `cancellation` al cancelar.
- [ ] M-0502 Movimiento `release` al liberar reserva.
- [ ] M-0503 Movimiento `adjustment` con motivo obligatorio.
- [ ] M-0504 Movimiento `return` al recibir una devolución.
- [ ] M-0505 Recuento físico (stocktake) con diferencias registradas.
- [ ] M-0506 Ubicaciones de stock con dirección y prioridad.
- [ ] M-0507 Ubicación por canal de venta.
- [ ] M-0508 Estrategia de asignación de stock reemplazable.
- [ ] M-0509 Política de agotado: bloquear, permitir backorder o avisar.
- [ ] M-0510 Umbral de stock bajo por artículo y por ubicación.
- [ ] M-0511 Alerta de stock bajo como trabajo programado.
- [ ] M-0512 Alerta de stock agotado con producto publicado.
- [ ] M-0513 Transferencia de stock entre ubicaciones.
- [ ] M-0514 Stock entrante con fecha esperada.
- [ ] M-0515 Consumo de componentes al vender un paquete.
- [ ] M-0516 Disponibilidad de paquete calculada desde sus componentes.
- [ ] M-0517 Variante sin seguimiento de inventario (servicios, digitales).
- [ ] M-0518 Bloqueo por artículo para evitar sobreventa concurrente.
- [ ] M-0519 Idempotencia de la reserva por clave de referencia.
- [ ] M-0520 Informe de rotación por artículo.
- [ ] M-0521 Informe de valor de inventario por ubicación.
- [ ] M-0522 Importación de inventario por CSV.
- [ ] M-0523 Exportación de inventario por CSV.
- [ ] M-0524 Prueba de que no se puede reservar más de lo disponible.
- [ ] M-0525 Prueba de liberación de reserva al cancelar.
- [ ] M-0526 Prueba de caducidad de reserva de carrito.
- [ ] M-0527 Prueba de consumo de componentes del paquete.
- [ ] M-0528 Prueba de bloqueo concurrente sobre el mismo artículo.
- [ ] M-0529 Prueba de que el movimiento de stock siempre queda registrado.
- [ ] M-0530 Prueba de que el disponible nunca queda negativo sin backorder.

### Enlace precio-inventario-catálogo

- [ ] M-0531 Disponibilidad expuesta en el catálogo público sin cantidades exactas.
- [ ] M-0532 Estado `in_stock`, `low_stock`, `out_of_stock`, `preorder`, `backorder`.
- [ ] M-0533 Filtro de catálogo por disponibilidad.
- [ ] M-0534 Orden de catálogo que hunde lo agotado.
- [ ] M-0535 Ocultado opcional de variantes agotadas.
- [ ] M-0536 Aviso de últimas unidades configurable.
- [ ] M-0537 Fecha estimada de reposición visible.
- [ ] M-0538 Suscripción a aviso de reposición (registro local).
- [ ] M-0539 Precio y disponibilidad resueltos en una sola consulta.
- [ ] M-0540 Caché de precio calculado invalidada por cambio de precio o regla.
- [ ] M-0541 Caché de disponibilidad invalidada por movimiento de stock.
- [ ] M-0542 Coherencia entre catálogo, precio e inventario probada de extremo a extremo.
- [ ] M-0543 Métrica de fallos de caché por dominio.
- [ ] M-0544 Diagnóstico de incoherencias precio/inventario/catálogo.
- [ ] M-0545 Reparación guiada de incoherencias detectadas.
- [ ] M-0546 Registro de cada reparación con autor y motivo.
- [ ] M-0547 Exportación del diagnóstico de coherencia.
- [ ] M-0548 Alerta cuando el diagnóstico encuentra incoherencias.
- [ ] M-0549 Trabajo programado de diagnóstico diario.
- [ ] M-0550 Prueba del diagnóstico de coherencia.

### Precio afiliado

- [ ] M-0551 Precio del comercio afiliado como fuente separada del precio propio.
- [ ] M-0552 Antigüedad del precio afiliado visible en la ficha.
- [ ] M-0553 Aviso de precio afiliado desactualizado según `PRICE_STALE_DAYS`.
- [ ] M-0554 Nunca presentar un precio afiliado antiguo como precio actual.
- [ ] M-0555 Texto explícito «precio verificado el …» en la ficha.
- [ ] M-0556 Historial de precio afiliado con la fuente de cada registro.
- [ ] M-0557 Diferencia porcentual frente al último precio registrado.
- [ ] M-0558 Alerta de variación de precio superior a un umbral.
- [ ] M-0559 Registro manual de precio afiliado con autor.
- [ ] M-0560 Lectura automática de precio desde feed o API. **[!]** Requiere credenciales.
- [ ] M-0561 Comisión estimada calculada desde el precio y el programa.
- [ ] M-0562 Comisión estimada por tipo (porcentaje o importe fijo).
- [ ] M-0563 Comisión estimada por tramo de precio.
- [ ] M-0564 Nunca sumar comisión estimada al ingreso real.
- [ ] M-0565 Separación visual entre estimado y confirmado en el panel.
- [ ] M-0566 Prueba de que la comisión estimada no entra en el ingreso.
- [ ] M-0567 Prueba de que el precio antiguo se marca como no verificado.
- [ ] M-0568 Prueba del cálculo de comisión por tipo y tramo.
- [ ] M-0569 Exportación del historial de precios afiliados.
- [ ] M-0570 Panel de evolución de precio y comisión estimada.
- [ ] M-0571 Comparación de precio entre comercios del mismo producto.
- [ ] M-0572 Selección del comercio más barato con precio verificado.
- [ ] M-0573 Empate resuelto por prioridad del programa.
- [ ] M-0574 Registro de la decisión de selección para auditoría.
- [ ] M-0575 Aviso si todos los precios del producto están desactualizados.
- [ ] M-0576 Ocultado de la comparación si no hay precios verificados.
- [ ] M-0577 Prueba de la selección del mejor comercio.
- [ ] M-0578 Prueba del empate por prioridad.
- [ ] M-0579 Prueba de ocultado sin precios verificados.
- [ ] M-0580 Documentación del modelo de precio afiliado.

## Fase 6 · Carrito, pedido y checkout · M-0581 … M-0760

### Carrito

- [ ] M-0581 Módulo `cart` con canal, región, moneda y cliente.
- [ ] M-0582 Líneas de carrito con variante, cantidad y precio unitario congelado.
- [ ] M-0583 Ajustes de línea (descuentos) con origen identificado.
- [ ] M-0584 Líneas de impuesto por línea de carrito.
- [ ] M-0585 Totales del carrito: subtotal, descuento, envío, impuesto, total.
- [ ] M-0586 Añadir, actualizar y quitar línea con validación de inventario.
- [ ] M-0587 Cantidad máxima por línea configurable.
- [ ] M-0588 Fusión de líneas de la misma variante.
- [ ] M-0589 Carrito de invitado con identificador en cookie.
- [ ] M-0590 Fusión del carrito de invitado al iniciar sesión.
- [ ] M-0591 Estrategia de fusión reemplazable (usar existente, invitado, combinar).
- [ ] M-0592 Estrategia de carrito activo reemplazable.
- [ ] M-0593 Dirección de envío y de facturación en el carrito.
- [ ] M-0594 Método de envío seleccionado en el carrito.
- [ ] M-0595 Aplicación de cupón al carrito con validación.
- [ ] M-0596 Retirada de cupón del carrito.
- [ ] M-0597 Recálculo completo del carrito tras cada cambio.
- [ ] M-0598 Detección de precio cambiado desde que se añadió la línea.
- [ ] M-0599 Detección de variante despublicada en el carrito.
- [ ] M-0600 Detección de stock insuficiente al confirmar.
- [ ] M-0601 Caducidad de carrito inactivo configurable.
- [ ] M-0602 Carrito abandonado marcado tras un umbral de inactividad.
- [ ] M-0603 Recuperación de carrito abandonado por enlace firmado.
- [ ] M-0604 Métrica de abandono por paso del checkout.
- [ ] M-0605 Bloqueo del carrito durante la confirmación.
- [ ] M-0606 Idempotencia de la confirmación por clave.
- [ ] M-0607 Notas del cliente en el carrito.
- [ ] M-0608 Regalo: envoltorio y mensaje por línea.
- [ ] M-0609 Recargos aplicados al carrito.
- [ ] M-0610 Prueba de recálculo con descuento, envío e impuesto.

### Pedido

- [ ] M-0611 Módulo `order` con código legible y estrategia reemplazable.
- [ ] M-0612 Máquina de estados de pedido con transiciones declaradas.
- [ ] M-0613 Estados: `draft`, `pending`, `confirmed`, `processing`, `shipped`, `delivered`, `completed`, `cancelled`.
- [ ] M-0614 Estados de pago: `unpaid`, `authorized`, `partially_paid`, `paid`, `refunded`, `partially_refunded`.
- [ ] M-0615 Estados de fulfillment: `not_fulfilled`, `partially_fulfilled`, `fulfilled`, `returned`.
- [ ] M-0616 Rechazo de transición inválida con error explícito.
- [ ] M-0617 Hooks antes y después de cada transición.
- [ ] M-0618 Líneas de pedido con referencia a la variante y datos congelados.
- [ ] M-0619 Ajustes e impuestos por línea de pedido.
- [ ] M-0620 Métodos de envío del pedido con su precio y ajustes.
- [ ] M-0621 Recargos del pedido.
- [ ] M-0622 Resumen del pedido con totales, pagado, reembolsado y pendiente.
- [ ] M-0623 Transacciones del pedido (cargo, reembolso, ajuste).
- [ ] M-0624 Líneas de crédito para saldos a favor.
- [ ] M-0625 Historial del pedido con entradas tipadas y autor.
- [ ] M-0626 Notas internas y notas visibles al cliente.
- [ ] M-0627 Etiquetas de pedido.
- [ ] M-0628 Cancelación con motivo y liberación de stock.
- [ ] M-0629 Confirmación con asignación de stock.
- [ ] M-0630 Pedido dividido por vendedor en marketplace.
- [ ] M-0631 Pedido por canal con numeración independiente opcional.
- [ ] M-0632 Acceso al pedido por código con estrategia reemplazable.
- [ ] M-0633 Pedidos borrador creados por el operador.
- [ ] M-0634 Conversión de borrador a pedido con pago pendiente.
- [ ] M-0635 Modificación de pedido con cálculo de diferencia.
- [ ] M-0636 Modificación que requiere cobro adicional o reembolso.
- [ ] M-0637 Registro de cada acción de modificación.
- [ ] M-0638 Bloqueo de modificación en estados finales.
- [ ] M-0639 Duplicado de pedido como borrador.
- [ ] M-0640 Reordenar: crear carrito desde un pedido anterior.
- [ ] M-0641 Búsqueda de pedidos por código, cliente, estado y fecha.
- [ ] M-0642 Exportación de pedidos por CSV.
- [ ] M-0643 Impresión/vista de comprobante sin valor fiscal declarado.
- [ ] M-0644 Prueba del recorrido completo de estados.
- [ ] M-0645 Prueba de rechazo de transición inválida.
- [ ] M-0646 Prueba de cancelación con liberación de stock.
- [ ] M-0647 Prueba de modificación con diferencia a cobrar.
- [ ] M-0648 Prueba de división por vendedor.
- [ ] M-0649 Prueba de idempotencia de la confirmación.
- [ ] M-0650 Prueba de que el pedido congela precio, impuesto y descuento.

### Pagos

- [ ] M-0651 Módulo `payment` con colecciones y sesiones.
- [ ] M-0652 Colección de pago por pedido con importe requerido.
- [ ] M-0653 Sesión de pago por proveedor con estado propio.
- [ ] M-0654 Proveedor manual (transferencia, efectivo, contra entrega).
- [ ] M-0655 Elegibilidad del método de pago por región, canal y total.
- [ ] M-0656 Autorización de pago con registro de respuesta.
- [ ] M-0657 Captura total y parcial.
- [ ] M-0658 Cancelación de autorización.
- [ ] M-0659 Reembolso total y parcial con motivo.
- [ ] M-0660 Varios pagos sobre un mismo pedido.
- [ ] M-0661 Cálculo del pendiente de cobro en todo momento.
- [ ] M-0662 Estados de pago auditables con transiciones válidas.
- [ ] M-0663 Idempotencia de la captura por clave.
- [ ] M-0664 Registro de todas las respuestas del proveedor sin datos sensibles.
- [ ] M-0665 Prohibición de persistir datos de tarjeta.
- [ ] M-0666 Webhook de pago con verificación de firma y idempotencia.
- [ ] M-0667 Proveedor Stripe u otra pasarela real. **[!]** Requiere credenciales.
- [ ] M-0668 Conciliación entre pagos y totales del pedido.
- [ ] M-0669 Alerta de descuadre entre pago y pedido.
- [ ] M-0670 Prueba del recorrido autorizar → capturar → reembolsar.

### Envío y fulfillment

- [ ] M-0671 Perfiles de envío con productos asignados.
- [ ] M-0672 Conjuntos de fulfillment por tipo (envío, recogida).
- [ ] M-0673 Zonas de servicio por conjunto con países y provincias.
- [ ] M-0674 Opciones de envío con precio fijo o calculado.
- [ ] M-0675 Reglas de elegibilidad por peso, total, zona y perfil.
- [ ] M-0676 Envío gratis por umbral de total.
- [ ] M-0677 Cálculo de envío por peso con tramos.
- [ ] M-0678 Cálculo de envío por número de artículos.
- [ ] M-0679 Recogida en tienda con ubicación seleccionable.
- [ ] M-0680 Método de envío del pedido con precio congelado.
- [ ] M-0681 Fulfillment con líneas, cantidades y paquete.
- [ ] M-0682 Estados de fulfillment con transiciones.
- [ ] M-0683 Número de seguimiento y transportista.
- [ ] M-0684 Envío parcial con varios fulfillments.
- [ ] M-0685 Cancelación de fulfillment con reposición de stock.
- [ ] M-0686 Etiqueta de envío como documento local sin proveedor.
- [ ] M-0687 Integración con transportista real. **[!]** Requiere credenciales.
- [ ] M-0688 Estimación de plazo de entrega por zona.
- [ ] M-0689 Instrucciones de entrega del cliente.
- [ ] M-0690 Prueba de elegibilidad de opciones de envío.

### Devoluciones, cambios y reclamaciones

- [ ] M-0691 Motivos de devolución como catálogo.
- [ ] M-0692 Solicitud de devolución con líneas y cantidades.
- [ ] M-0693 Aprobación o rechazo de la devolución con motivo.
- [ ] M-0694 Recepción de la devolución con inspección por línea.
- [ ] M-0695 Reposición de stock según el estado recibido.
- [ ] M-0696 Reembolso asociado a la devolución.
- [ ] M-0697 Coste de envío de devolución configurable.
- [ ] M-0698 Cambio (exchange) con líneas de reemplazo.
- [ ] M-0699 Diferencia a cobrar o reembolsar en el cambio.
- [ ] M-0700 Reclamación (claim) con tipo y evidencias.
- [ ] M-0701 Imágenes adjuntas a la reclamación.
- [ ] M-0702 Resolución de reclamación: reemplazo, reembolso o rechazo.
- [ ] M-0703 Plazo de devolución configurable por región.
- [ ] M-0704 Bloqueo de devolución fuera de plazo.
- [ ] M-0705 Historial de devolución en el pedido.
- [ ] M-0706 Métricas de devoluciones por motivo y producto.
- [ ] M-0707 Alerta de producto con tasa de devolución alta.
- [ ] M-0708 Prueba del recorrido de devolución con reembolso.
- [ ] M-0709 Prueba del cambio con diferencia a cobrar.
- [ ] M-0710 Prueba de bloqueo fuera de plazo.

### Checkout

- [ ] M-0711 Pasos de checkout declarados y validados en orden.
- [ ] M-0712 Checkout de invitado con estrategia reemplazable.
- [ ] M-0713 Validación de dirección antes de calcular envío.
- [ ] M-0714 Cálculo de opciones de envío disponibles para el carrito.
- [ ] M-0715 Cálculo de impuestos antes del pago.
- [ ] M-0716 Resumen final antes de confirmar.
- [ ] M-0717 Confirmación como workflow con compensación por paso.
- [ ] M-0718 Compensación: liberar stock si falla el pago.
- [ ] M-0719 Compensación: anular pedido si falla la reserva.
- [ ] M-0720 Reintento seguro del checkout con la misma clave de idempotencia.
- [ ] M-0721 Registro completo del recorrido del checkout.
- [ ] M-0722 Página de confirmación con acceso por código.
- [ ] M-0723 Notificación de pedido confirmado (registro local).
- [ ] M-0724 Aviso claro de que el checkout está desactivado en modo `AFFILIATE`.
- [ ] M-0725 Prueba del checkout completo con proveedor manual.
- [ ] M-0726 Prueba de compensación al fallar el pago.
- [ ] M-0727 Prueba de que el checkout no existe en modo `AFFILIATE`.
- [ ] M-0728 Prueba de idempotencia del checkout.
- [ ] M-0729 Prueba de que el stock queda asignado tras confirmar.
- [ ] M-0730 Prueba de que un carrito confirmado no se puede modificar.

### Conversión afiliada como pedido externo

- [ ] M-0731 La conversión afiliada se modela como pedido externo, no como venta propia.
- [ ] M-0732 Nunca aparece en el ingreso propio ni en los totales de tienda.
- [ ] M-0733 Estados de conversión: `pending`, `approved`, `rejected`, `paid`.
- [ ] M-0734 Transiciones de conversión validadas.
- [ ] M-0735 Comisión creada al aprobar la conversión.
- [ ] M-0736 Estados de comisión separados de la conversión.
- [ ] M-0737 Pago de comisión (`payout`) con período y comprobante.
- [ ] M-0738 Conciliación entre comisiones aprobadas y pagos recibidos.
- [ ] M-0739 Alerta de comisión aprobada sin pago tras un plazo.
- [ ] M-0740 Atribución de la conversión al clic por `clickId`.
- [ ] M-0741 Ventana de atribución configurable.
- [ ] M-0742 Conversión sin clic coincidente marcada para revisión.
- [ ] M-0743 Rechazo de `networkConversionId` duplicado.
- [ ] M-0744 Importación de conversiones con informe por fila.
- [ ] M-0745 Registro de cada importación con su origen y resultado.
- [ ] M-0746 Reversión de una importación completa.
- [ ] M-0747 Postback de conversión en tiempo real. **[!]** Requiere secreto por red.
- [ ] M-0748 Detección de clics duplicados en ventana corta.
- [ ] M-0749 Marca de fraude en el clic con motivo.
- [ ] M-0750 Exclusión de clics marcados de las métricas de conversión.
- [ ] M-0751 Métricas de calidad de tráfico por fuente.
- [ ] M-0752 EPC por producto, programa, campaña y fuente.
- [ ] M-0753 Embudo afiliado completo con las cinco etapas.
- [ ] M-0754 Comparación de períodos en el embudo.
- [ ] M-0755 Exportación del embudo.
- [ ] M-0756 Prueba de que la conversión afiliada no altera el ingreso propio.
- [ ] M-0757 Prueba del rechazo de conversión duplicada.
- [ ] M-0758 Prueba de la ventana de atribución.
- [ ] M-0759 Prueba de exclusión de clics fraudulentos.
- [ ] M-0760 Prueba de la separación entre comisión y pago.

## Fase 7 · Promociones · M-0761 … M-0860

- [ ] M-0761 Módulo `promotion` con tipo estándar y automático.
- [ ] M-0762 Método de aplicación: importe fijo o porcentaje.
- [ ] M-0763 Objetivo: pedido completo, líneas concretas o envío.
- [ ] M-0764 Asignación del descuento entre líneas objetivo.
- [ ] M-0765 Reglas con atributo, operador y valores.
- [ ] M-0766 Operadores `eq`, `ne`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`.
- [ ] M-0767 Condición: total mínimo del pedido.
- [ ] M-0768 Condición: contiene productos concretos.
- [ ] M-0769 Condición: contiene variantes concretas.
- [ ] M-0770 Condición: pertenece a un grupo de cliente.
- [ ] M-0771 Condición: tiene valores de faceta.
- [ ] M-0772 Condición: pertenece a una categoría o colección.
- [ ] M-0773 Condición: cantidad mínima de artículos.
- [ ] M-0774 Condición: primera compra del cliente.
- [ ] M-0775 Condición: región, canal o moneda.
- [ ] M-0776 Condición: rango de fechas y días de la semana.
- [ ] M-0777 Condición compuesta buy-x-get-y.
- [ ] M-0778 Acción: descuento porcentual sobre el pedido.
- [ ] M-0779 Acción: descuento fijo sobre el pedido.
- [ ] M-0780 Acción: descuento fijo sobre la línea.
- [ ] M-0781 Acción: descuento porcentual por producto.
- [ ] M-0782 Acción: descuento porcentual por faceta.
- [ ] M-0783 Acción: envío gratis.
- [ ] M-0784 Acción: buy-x-get-y con el artículo más barato gratis.
- [ ] M-0785 Acción: regalo añadido al carrito.
- [ ] M-0786 Prioridad de promoción y orden de evaluación.
- [ ] M-0787 Promoción exclusiva que impide apilar otras.
- [ ] M-0788 Límite de descuento máximo por promoción.
- [ ] M-0789 Códigos de cupón con formato configurable.
- [ ] M-0790 Generación masiva de códigos únicos.
- [ ] M-0791 Límite de usos global del cupón.
- [ ] M-0792 Límite de usos por cliente.
- [ ] M-0793 Registro de cada uso con pedido y cliente.
- [ ] M-0794 Cupón de un solo uso por cliente nuevo.
- [ ] M-0795 Vigencia del cupón con inicio y fin.
- [ ] M-0796 Desactivación inmediata de un cupón.
- [ ] M-0797 Campañas que agrupan promociones.
- [ ] M-0798 Presupuesto de campaña por gasto.
- [ ] M-0799 Presupuesto de campaña por número de usos.
- [ ] M-0800 Consumo de presupuesto registrado por uso.
- [ ] M-0801 Bloqueo de la promoción al agotar el presupuesto.
- [ ] M-0802 Alerta al alcanzar el 80 % del presupuesto.
- [ ] M-0803 Métricas por campaña: usos, descuento, pedidos, ticket medio.
- [ ] M-0804 Simulador de promoción sobre un carrito de prueba.
- [ ] M-0805 Explicación legible de por qué una promoción no aplica.
- [ ] M-0806 Registro de promociones evaluadas por carrito.
- [ ] M-0807 Tarjetas regalo con saldo y moneda.
- [ ] M-0808 Emisión, consumo parcial y consulta de saldo.
- [ ] M-0809 Caducidad de tarjeta regalo configurable.
- [ ] M-0810 Registro de movimientos de la tarjeta regalo.
- [ ] M-0811 Tarjeta regalo aplicada como pago, no como descuento.
- [ ] M-0812 Bloqueo de tarjeta regalo por sospecha.
- [ ] M-0813 Prueba de descuento porcentual sobre el pedido.
- [ ] M-0814 Prueba de descuento fijo repartido entre líneas.
- [ ] M-0815 Prueba de envío gratis por umbral.
- [ ] M-0816 Prueba de buy-x-get-y.
- [ ] M-0817 Prueba de límite de usos del cupón.
- [ ] M-0818 Prueba de presupuesto agotado.
- [ ] M-0819 Prueba de promoción exclusiva.
- [ ] M-0820 Prueba del reparto con restos.
- [ ] M-0821 Promoción aplicada solo en canales elegidos.
- [ ] M-0822 Promoción aplicada solo a grupos de cliente elegidos.
- [ ] M-0823 Promoción con tope de unidades bonificadas.
- [ ] M-0824 Promoción escalonada por total del pedido.
- [ ] M-0825 Promoción de segunda unidad con descuento.
- [ ] M-0826 Promoción por combinación de productos (paquete).
- [ ] M-0827 Promoción por cantidad de artículos del mismo producto.
- [ ] M-0828 Promoción con exclusión de productos concretos.
- [ ] M-0829 Promoción con exclusión de productos ya rebajados.
- [ ] M-0830 Promoción visible u oculta en el catálogo.
- [ ] M-0831 Etiqueta de promoción mostrada en la ficha.
- [ ] M-0832 Cuenta atrás de promoción en la ficha.
- [ ] M-0833 Registro de impresiones de la etiqueta de promoción.
- [ ] M-0834 Métrica de conversión atribuida a la promoción.
- [ ] M-0835 Comparación de rendimiento entre promociones.
- [ ] M-0836 Exportación de promociones y sus usos.
- [ ] M-0837 Duplicado de promoción con sus reglas.
- [ ] M-0838 Plantillas de promoción reutilizables.
- [ ] M-0839 Vista previa del efecto sobre el catálogo.
- [ ] M-0840 Historial de cambios de la promoción.
- [ ] M-0841 Promoción programada con activación automática.
- [ ] M-0842 Desactivación automática al vencer.
- [ ] M-0843 Trabajo programado que activa y desactiva promociones.
- [ ] M-0844 Alerta de promoción vencida aún marcada como activa.
- [ ] M-0845 Validación de que la promoción tiene al menos una acción.
- [ ] M-0846 Validación de que el descuento no deja el total negativo.
- [ ] M-0847 Prueba de que el total nunca queda negativo.
- [ ] M-0848 Prueba de la promoción programada.
- [ ] M-0849 Promoción sobre el enlace afiliado: nunca modifica la URL.
- [ ] M-0850 Promoción informativa afiliada: solo texto, sin alterar destino.
- [ ] M-0851 Cupón del comercio mostrado como dato, no aplicado por Ndivepa.
- [ ] M-0852 Registro de la fuente del cupón del comercio.
- [ ] M-0853 Antigüedad del cupón del comercio visible.
- [ ] M-0854 Aviso de cupón del comercio posiblemente caducado.
- [ ] M-0855 Nunca prometer un descuento afiliado no verificado.
- [ ] M-0856 Prueba de que la promoción afiliada no toca la URL.
- [ ] M-0857 Prueba de que el cupón del comercio no altera el total propio.
- [ ] M-0858 Métrica de clics sobre cupones del comercio.
- [ ] M-0859 Exportación de cupones del comercio con su antigüedad.
- [ ] M-0860 Documentación del modelo de promoción y sus límites.

## Fase 8 · API pública y de administración · M-0861 … M-0940

- [ ] M-0861 API de tienda: catálogo con filtros, orden y paginación.
- [ ] M-0862 API de tienda: ficha de producto con variantes y precio calculado.
- [ ] M-0863 API de tienda: categorías, colecciones y facetas.
- [ ] M-0864 API de tienda: búsqueda con facetas.
- [ ] M-0865 API de tienda: regiones y monedas.
- [ ] M-0866 API de tienda: carrito completo (crear, líneas, direcciones, envío, cupón).
- [ ] M-0867 API de tienda: opciones de envío del carrito.
- [ ] M-0868 API de tienda: sesiones de pago y confirmación.
- [ ] M-0869 API de tienda: pedido por código.
- [ ] M-0870 API de tienda: cuenta de cliente y direcciones.
- [ ] M-0871 API de tienda: registro, acceso y restablecimiento de contraseña.
- [ ] M-0872 API de tienda: devoluciones solicitadas por el cliente.
- [ ] M-0873 API de tienda: eventos de vista y clic con consentimiento.
- [ ] M-0874 API de tienda: `commerceMode` expuesto para que el cliente se adapte.
- [ ] M-0875 API de administración: CRUD completo de todos los recursos.
- [ ] M-0876 API de administración: `expand` de relaciones declarado por recurso.
- [ ] M-0877 API de administración: `fields` para proyección.
- [ ] M-0878 API de administración: filtros por cualquier campo indexado.
- [ ] M-0879 API de administración: orden por varios campos.
- [ ] M-0880 API de administración: paginación con total.
- [ ] M-0881 API de administración: operaciones en lote.
- [ ] M-0882 API de administración: importación y exportación por recurso.
- [ ] M-0883 API de administración: métricas y analítica.
- [ ] M-0884 API de administración: cola de trabajos y eventos fallidos.
- [ ] M-0885 API de administración: diagnóstico del sistema.
- [ ] M-0886 API de administración: auditoría consultable.
- [ ] M-0887 Versionado de la API en la ruta (`/api/v1`).
- [ ] M-0888 Compatibilidad de las rutas sin versión con la v1.
- [ ] M-0889 Documento OpenAPI 3.1 generado desde las rutas.
- [ ] M-0890 `/api/docs` que renderiza el contrato sin dependencias externas.
- [ ] M-0891 Ejemplos de petición y respuesta por ruta.
- [ ] M-0892 Códigos de error documentados por ruta.
- [ ] M-0893 Permisos documentados por ruta.
- [ ] M-0894 `X-Request-Id` en toda respuesta.
- [ ] M-0895 `ETag` en respuestas de lectura cacheables.
- [ ] M-0896 `304` con `If-None-Match`.
- [ ] M-0897 `Retry-After` y `X-RateLimit-*` al limitar.
- [ ] M-0898 CORS configurable por origen.
- [ ] M-0899 CSRF en mutaciones basadas en cookie.
- [ ] M-0900 Autenticación por clave de API con permisos.
- [ ] M-0901 Autenticación por sesión con cookie HttpOnly.
- [ ] M-0902 Token de canal para la API de tienda.
- [ ] M-0903 Límite de tamaño de cuerpo por ruta.
- [ ] M-0904 Límite de profundidad y tamaño del JSON de entrada.
- [ ] M-0905 Rechazo de tipos de contenido no soportados.
- [ ] M-0906 `HEAD` y `OPTIONS` correctos en toda la API.
- [ ] M-0907 `405` con `Allow` cuando el método no aplica.
- [ ] M-0908 `404` con `code` estable y sin filtrar existencia sensible.
- [ ] M-0909 `409` en conflictos de unicidad y de estado.
- [ ] M-0910 `422` con la lista completa de campos inválidos.
- [ ] M-0911 `429` con la ventana y el límite aplicados.
- [ ] M-0912 `500` sin pila ni rutas internas en producción.
- [ ] M-0913 `/api/health` con estado de almacenamiento y cola.
- [ ] M-0914 `/api/ready` que solo responde tras migrar y sembrar.
- [ ] M-0915 Métricas internas por ruta y por dominio.
- [ ] M-0916 Registro de acceso estructurado con duración y estado.
- [ ] M-0917 Correlación de eventos de dominio con el `requestId`.
- [ ] M-0918 Prueba de contrato de todas las rutas de tienda.
- [ ] M-0919 Prueba de contrato de todas las rutas de administración.
- [ ] M-0920 Prueba de que ninguna ruta administrativa es pública.
- [ ] M-0921 Prueba de que el OpenAPI generado es válido.
- [ ] M-0922 Prueba de paginación en los límites.
- [ ] M-0923 Prueba de filtros con operadores.
- [ ] M-0924 Prueba de `expand` y `fields`.
- [ ] M-0925 Prueba de `ETag` y `304`.
- [ ] M-0926 Prueba de CSRF en mutación con cookie.
- [ ] M-0927 Prueba de clave de API con permisos insuficientes.
- [ ] M-0928 Prueba de token de canal inválido.
- [ ] M-0929 Prueba de límite de tamaño de cuerpo.
- [ ] M-0930 Prueba de rechazo de JSON demasiado profundo.
- [ ] M-0931 Prueba de `405` con `Allow`.
- [ ] M-0932 Prueba de `409` por unicidad.
- [ ] M-0933 Prueba de `422` con varios campos.
- [ ] M-0934 Prueba de `429` con `Retry-After`.
- [ ] M-0935 Prueba de `/api/health` y `/api/ready`.
- [ ] M-0936 SDK JavaScript mínimo para consumir la API.
- [ ] M-0937 Colección de ejemplos ejecutables por recurso.
- [ ] M-0938 Guía de la API en la documentación.
- [ ] M-0939 Cambios de contrato registrados en un `CHANGELOG` de API.
- [ ] M-0940 Política de obsolescencia con aviso por cabecera.

## Fase 9 · Interfaz · M-0941 … M-1000

- [ ] M-0941 Dividir `public/app.js` en vistas por dominio.
- [ ] M-0942 Enrutador de la SPA con historial y enlaces profundos.
- [ ] M-0943 Estado de la SPA centralizado y observable.
- [ ] M-0944 Cliente de API único con manejo de errores uniforme.
- [ ] M-0945 Indicadores de carga y estados vacíos por vista.
- [ ] M-0946 Mensajes de error legibles y accionables.
- [ ] M-0947 Panel: catálogo con lista, filtros y edición.
- [ ] M-0948 Panel: editor de variantes con matriz de opciones.
- [ ] M-0949 Panel: gestor de activos con orden y texto alternativo.
- [ ] M-0950 Panel: categorías, colecciones y facetas.
- [ ] M-0951 Panel: precios y listas de precios.
- [ ] M-0952 Panel: inventario por ubicación con ajustes.
- [ ] M-0953 Panel: pedidos con detalle, historial y acciones.
- [ ] M-0954 Panel: devoluciones, cambios y reclamaciones.
- [ ] M-0955 Panel: pagos y conciliación.
- [ ] M-0956 Panel: envíos y fulfillment.
- [ ] M-0957 Panel: promociones, cupones y campañas.
- [ ] M-0958 Panel: clientes y grupos.
- [ ] M-0959 Panel: usuarios, roles e invitaciones.
- [ ] M-0960 Panel: claves de API y sesiones.
- [ ] M-0961 Panel: ajustes, regiones, impuestos y canales.
- [ ] M-0962 Panel: trabajos, eventos fallidos y diagnóstico.
- [ ] M-0963 Panel: auditoría consultable.
- [ ] M-0964 Panel afiliado: comercios, redes, programas y enlaces.
- [ ] M-0965 Panel afiliado: conversiones, comisiones y pagos.
- [ ] M-0966 Panel afiliado: cola de revisión de enlaces.
- [ ] M-0967 Panel: analítica con comparación de períodos.
- [ ] M-0968 Panel: series temporales de vistas, clics y conversiones.
- [ ] M-0969 Panel: separación explícita entre venta atribuida e ingreso.
- [ ] M-0970 Panel: descarga de informes filtrados.
- [ ] M-0971 Tienda: ficha con variantes y selector de opciones.
- [ ] M-0972 Tienda: carrito y checkout solo en modo `HYBRID`/`DIRECT`.
- [ ] M-0973 Tienda: cuenta de cliente con pedidos y direcciones.
- [ ] M-0974 Tienda: búsqueda con facetas y filtros.
- [ ] M-0975 Tienda: favoritos locales sin cuenta.
- [ ] M-0976 Tienda: comparador de productos.
- [ ] M-0977 Tienda: divulgación de afiliado siempre visible.
- [ ] M-0978 Tienda: banner de consentimiento con decisión persistida.
- [ ] M-0979 Tienda: guías y comparativas editoriales.
- [ ] M-0980 Accesibilidad: foco visible en todo elemento interactivo.
- [ ] M-0981 Accesibilidad: navegación completa por teclado.
- [ ] M-0982 Accesibilidad: modales con semántica de diálogo y cierre con Escape.
- [ ] M-0983 Accesibilidad: `aria-live` para mensajes dinámicos.
- [ ] M-0984 Accesibilidad: etiquetas asociadas a todo campo.
- [ ] M-0985 Accesibilidad: contraste mínimo AA en texto y controles.
- [ ] M-0986 Accesibilidad: `skip link` al contenido principal.
- [ ] M-0987 Accesibilidad: orden de tabulación coherente.
- [ ] M-0988 Accesibilidad: tablas con encabezados asociados.
- [ ] M-0989 Accesibilidad: alternativa textual en todo gráfico.
- [ ] M-0990 Rendimiento: CSS crítico en línea y resto diferido.
- [ ] M-0991 Rendimiento: imágenes con dimensiones declaradas.
- [ ] M-0992 Rendimiento: carga diferida de imágenes fuera de pantalla.
- [ ] M-0993 Rendimiento: sin bloqueo de render por scripts.
- [ ] M-0994 Rendimiento: presupuesto de tamaño por vista.
- [ ] M-0995 Tema oscuro respetando `prefers-color-scheme`.
- [ ] M-0996 Respeto de `prefers-reduced-motion`.
- [ ] M-0997 Diseño responsive verificado en tres anchos.
- [ ] M-0998 Idioma de la interfaz seleccionable.
- [ ] M-0999 Prueba de renderizado de las plantillas de vista.
- [ ] M-1000 Prueba de accesibilidad de las reglas críticas.

## Fase 10 · Operación y cierre · M-1001 … M-1040

- [ ] M-1001 `scripts/migrate.js` que aplica migraciones pendientes.
- [ ] M-1002 `scripts/seed.js` idempotente por módulo.
- [ ] M-1003 `scripts/verify.js` de integridad referencial.
- [ ] M-1004 `scripts/doctor.js` con diagnóstico completo.
- [ ] M-1005 `scripts/reindex.js` para el índice de búsqueda.
- [ ] M-1006 `scripts/openapi.js` que exporta el contrato.
- [ ] M-1007 `scripts/backup-data.js` con rotación por antigüedad.
- [ ] M-1008 `scripts/restore-data.js` con verificación de checksum.
- [ ] M-1009 Copia previa automática antes de migrar.
- [ ] M-1010 Registro de cada migración aplicada con fecha.
- [ ] M-1011 Prueba de restauración desde copia.
- [ ] M-1012 Prueba de migración desde una base v0.1 real.
- [ ] M-1013 `npm run dev` sin cambios de comportamiento.
- [ ] M-1014 `npm test` como puerta única de calidad.
- [ ] M-1015 Cobertura declarada por dominio.
- [ ] M-1016 Pruebas de framework independientes del servidor HTTP.
- [ ] M-1017 Pruebas de dominio sin arrancar el servidor.
- [ ] M-1018 Pruebas HTTP contra el servidor real.
- [ ] M-1019 Datos de prueba aislados del `data/db.json` de trabajo.
- [ ] M-1020 Restauración del estado tras cada suite.
- [ ] M-1021 Ejecución de pruebas en paralelo sin interferencia.
- [ ] M-1022 Tiempo total de pruebas bajo un umbral declarado.
- [ ] M-1023 Dockerfile que incluye `src/` y las nuevas carpetas.
- [ ] M-1024 `docker-compose.yml` con volúmenes para datos, índices y copias.
- [ ] M-1025 Variables de entorno documentadas en `.env.example`.
- [ ] M-1026 Arranque que falla claro si falta configuración obligatoria.
- [ ] M-1027 Apagado ordenado con vaciado de la cola de escritura.
- [ ] M-1028 Señales `SIGTERM` y `SIGINT` manejadas.
- [ ] M-1029 Registro de arranque con versión, esquema y módulos.
- [ ] M-1030 Métrica de tiempo de arranque.
- [ ] M-1031 README actualizado con la arquitectura nueva.
- [ ] M-1032 `Operaciones_Locales.md` actualizado con los comandos nuevos.
- [ ] M-1033 `Pasos_A_Seguir.md` alineado con el plan maestro.
- [ ] M-1034 `Registro_De_Cambios.md` con lo ejecutado y su fecha.
- [ ] M-1035 Guía de contribución con el contrato de módulo.
- [ ] M-1036 Guía de despliegue con lo que falta por acceso externo.
- [ ] M-1037 Inventario de bloqueos externos revisado y fechado.
- [ ] M-1038 Revisión de que ningún documento contiene credenciales.
- [ ] M-1039 Revisión de que ningún dato de ejemplo se presenta como real.
- [ ] M-1040 Cierre: `npm test` verde y diagnóstico sin incidencias.

---

## Bloqueados por acceso externo

Estos ocho puntos quedan marcados `[!]` y **no se simulan**:

| Ítem | Requisito |
| --- | --- |
| M-0228 | Credenciales de proveedor de impuesto |
| M-0263 | Credenciales OAuth (Google/GitHub/OIDC) |
| M-0333 | Credenciales de S3 o CDN |
| M-0560 | Credenciales de feed/API de la red de afiliación |
| M-0667 | Credenciales de pasarela de pago |
| M-0687 | Credenciales de transportista |
| M-0747 | Secreto de postback por red |
| — | Dominio, HTTPS, PostgreSQL, Redis, correo transaccional, GA4 |
