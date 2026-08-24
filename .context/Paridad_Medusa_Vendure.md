# Paridad funcional con Medusa y Vendure

Inventario de lo que ofrecen ambas plataformas, leído directamente del código fuente disponible
en `d:\Proyectos\MarketingdeAfiliados\medusa-develop` y
`d:\Proyectos\MarketingdeAfiliados\vendure-master`, y su correspondencia en Ndivepa.

Leyenda de estado: **[ok]** implementado · **[wip]** parcial · **[ ]** pendiente ·
**[n/a]** deliberadamente fuera de alcance (requiere credenciales o infraestructura externa).

---

## 1. Lo que aporta cada plataforma

### 1.1 Medusa — módulos (`packages/modules/`)

`analytics`, `api-key`, `auth`, `cache-inmemory`, `cache-redis`, `caching`, `cart`, `currency`,
`customer`, `event-bus-local`, `event-bus-redis`, `file`, `fulfillment`, `index`, `inventory`,
`link-modules`, `locking`, `notification`, `order`, `payment`, `pricing`, `product`, `promotion`,
`providers`, `rbac`, `region`, `sales-channel`, `search`, `settings`, `stock-location`, `store`,
`tax`, `translation`, `user`, `workflow-engine-inmemory`, `workflow-engine-redis`.

### 1.2 Medusa — núcleo (`packages/core/`)

`core-flows` (workflows de dominio), `framework` (arranque, HTTP, middlewares, subscribers, jobs),
`js-sdk`, `modules-sdk`, `orchestration` (motor de workflows con compensación), `query`
(Remote Query / grafo de módulos), `types`, `utils`, `workflows-sdk`.

### 1.3 Medusa — `core-flows` (procesos de negocio)

`api-key`, `auth`, `cart`, `common`, `customer`, `customer-group`, `defaults`, `draft-order`,
`file`, `fulfillment`, `inventory`, `invite`, `line-item`, `locking`, `notification`, `order`,
`payment`, `payment-collection`, `price-list`, `pricing`, `product`, `product-category`,
`promotion`, `rbac`, `region`, `reservation`, `return-reason`, `sales-channel`, `settings`,
`shipping-options`, `shipping-profile`, `stock-location`, `store`, `tax`, `translation`, `user`.

### 1.4 Medusa — modelos de `order`

`order`, `order-item`, `line-item`, `line-item-adjustment`, `line-item-tax-line`,
`order-shipping-method`, `shipping-method`, `shipping-method-adjustment`,
`shipping-method-tax-line`, `order-change`, `order-change-action`, `order-summary`,
`transaction`, `credit-line`, `return`, `return-item`, `return-reason`, `claim`, `claim-item`,
`claim-item-image`, `exchange`, `exchange-item`, `address`.

### 1.5 Medusa — modelos de `product` y `promotion`

Producto: `product`, `product-variant`, `product-option`, `product-option-value`,
`product-collection`, `product-category`, `product-image`, `product-tag`, `product-type`,
`product-product-option`, `product-product-option-value`, `product-variant-product-image`.

Promoción: `promotion`, `application-method`, `promotion-rule`, `promotion-rule-value`,
`campaign`, `campaign-budget`, `campaign-budget-usage`.

### 1.6 Medusa — proveedores incluidos (`packages/modules/providers/`)

`analytics-local`, `analytics-posthog`, `auth-emailpass`, `auth-github`, `auth-google`,
`auth-oidc`, `caching-redis`, `file-local`, `file-s3`, `fulfillment-manual`, `locking-postgres`,
`locking-redis`, `notification-local`, `notification-sendgrid`, `payment-stripe`, `search-local`,
`search-postgres`.

### 1.7 Vendure — servicios de dominio (`packages/core/src/service/services/`)

`administrator`, `api-key`, `asset`, `auth`, `channel`, `collection`, `country`,
`customer-group`, `customer`, `facet-value`, `facet`, `fulfillment`, `global-settings`,
`history`, `order-testing`, `order`, `payment-method`, `payment`, `product-option-group`,
`product-option`, `product-variant`, `product`, `promotion`, `province`, `role`, `search`,
`seller`, `session`, `shipping-method`, `stock-level`, `stock-location`, `stock-movement`,
`tag`, `tax-category`, `tax-rate`, `user`, `zone`.

### 1.8 Vendure — entidades (`packages/core/src/entity/`)

`address`, `administrator`, `api-key`, `asset`, `authentication-method`, `channel`,
`collection`, `custom-entity-fields`, `customer`, `customer-group`, `facet`, `facet-value`,
`fulfillment`, `global-settings`, `history-entry`, `order`, `order-line`,
`order-line-reference`, `order-modification`, `payment`, `payment-method`, `product`,
`product-option`, `product-option-group`, `product-variant`, `promotion`, `refund`, `region`,
`role`, `seller`, `session`, `settings-store-entry`, `shipping-line`, `shipping-method`,
`stock-level`, `stock-location`, `stock-movement`, `surcharge`, `tag`, `tax-category`,
`tax-rate`, `user`, `zone`.

### 1.9 Vendure — estrategias configurables (`packages/core/src/config/`)

`api-key-strategy`, `asset-import-strategy`, `asset-naming-strategy`,
`asset-preview-strategy`, `asset-storage-strategy`, `auth`, `catalog`, `custom-field`,
`entity`, `entity-metadata`, `fulfillment`, `job-queue`, `logger`, `order`, `payment`,
`promotion`, `refund`, `session-cache`, `settings-store`, `shipping-method`, `system`, `tax`.

Del subsistema de pedidos: `active-order-strategy`, `changed-price-handling-strategy`,
`guest-checkout-strategy`, `order-item-price-calculation-strategy`,
`order-line-discount-distribution-strategy`, `order-placed-strategy`, `order-process`,
`order-seller-strategy`, `stock-allocation-strategy`, `order-by-code-access-strategy`,
`order-code-strategy`, `order-interceptor`, `order-merge-strategy` (con
`use-existing`, `use-guest`, `use-guest-if-existing-empty`, `merge-orders`).

### 1.10 Vendure — promociones incluidas

Condiciones: `buy-x-get-y-free`, `contains-products`, `customer-group`, `has-facet-values`,
`min-order-amount`.

Acciones: `buy-x-get-y-free`, `facet-values-percentage-discount`, `free-shipping`,
`order-fixed-discount`, `order-line-fixed-discount`, `order-percentage-discount`,
`product-percentage-discount`.

### 1.11 Vendure — paquetes de plataforma

`admin-ui`, `admin-ui-plugin`, `asset-server-plugin`, `cli`, `common`, `core`, `create`,
`dashboard`, `dev-server`, `email-plugin`, `graphiql-plugin`, `harden-plugin`,
`job-queue-plugin`, `telemetry-plugin`, `testing`, `ui-devkit`.

---

## 2. Matriz de paridad

### 2.1 Plataforma y framework

| Capacidad | Medusa | Vendure | Ndivepa |
| --- | --- | --- | --- |
| Contenedor de dependencias / registro de módulos | `modules-sdk` | Nest DI | [ok] `framework/container.js` |
| Bus de eventos local | `event-bus-local` | `EventBus` | [ok] `framework/events.js` |
| Bus de eventos distribuido | `event-bus-redis` | plugin Redis | [n/a] requiere Redis |
| Cola de trabajos | `workflow-engine-*` | `job-queue` | [ok] `framework/jobs.js` |
| Programación tipo cron | subscribers + jobs | `JobQueue` + scheduler | [ok] `framework/jobs.js` (`schedule`) |
| Motor de workflows con compensación | `orchestration` | — | [ok] `framework/workflow.js` |
| Caché con TTL e invalidación | `cache-inmemory` | `session-cache` | [ok] `framework/cache.js` |
| Bloqueos / mutex | `locking` | — | [ok] `framework/locks.js` |
| Registro estructurado | `framework/logger` | `logger` strategy | [ok] `framework/logger.js` |
| Errores tipados | `MedusaError` | `ErrorResult` GraphQL | [ok] `framework/errors.js` |
| Validación declarativa | zod | class-validator | [ok] `framework/validate.js` |
| Campos personalizados por entidad | `metadata` | `custom-field` | [ok] `framework/customfields.js` |
| Sistema de plugins | plugins npm | `VendurePlugin` | [ok] `framework/plugins.js` |
| Estrategias reemplazables | providers | `config/*-strategy` | [ok] `framework/config.js` (`strategies`) |
| Traducciones de contenido | `translation` | `Translatable` | [ok] `framework/i18n.js` |
| Búsqueda con facetas | `search-*` | `search.service` | [ok] `framework/search.js` |
| Almacenamiento de ficheros | `file-local`, `file-s3` | `asset-storage-strategy` | [ok] `framework/files.js` (local) |
| Notificaciones | `notification-*` | `email-plugin` | [ok] `framework/notifications.js` (registro local) |
| Analítica | `analytics-*` | `telemetry-plugin` | [ok] `framework/analytics.js` |
| Webhooks firmados | subscribers | — | [ok] `framework/webhooks.js` |
| Rate limiting | middleware | `harden-plugin` | [ok] `framework/ratelimit.js` |
| Contrato de API generado | OpenAPI | GraphQL schema | [ok] `framework/http/openapi.js` |
| Migraciones de esquema | MikroORM | TypeORM | [ok] `framework/store.js` |
| Multi-tenant / multi-tienda | `store` | `channel` + `seller` | [ok] módulos `store`, `channel`, `seller` |

### 2.2 Catálogo

| Capacidad | Ndivepa |
| --- | --- |
| Producto con estado (`draft`/`proposed`/`published`/`rejected`) | [ok] |
| Handle / slug único e histórico de slugs | [ok] |
| Variantes con SKU, EAN, UPC, código de barras, peso y dimensiones | [ok] |
| Grupos de opciones y valores de opción | [ok] |
| Matriz de variantes generada desde opciones | [ok] |
| Colecciones (manual y por reglas) | [ok] |
| Categorías jerárquicas con ruta materializada | [ok] |
| Facetas y valores de faceta (filtrado) | [ok] |
| Etiquetas y tipos de producto | [ok] |
| Activos: imágenes, orden, focal point, previsualizaciones | [ok] |
| Traducciones de nombre, descripción y `slug` por idioma | [ok] |
| Campos personalizados en producto y variante | [ok] |
| Producto digital / servicio / suscripción / paquete | [ok] |
| Productos relacionados, alternativas y accesorios | [ok] |
| Perfil de envío por producto | [ok] |
| Metadatos SEO por producto (title, description, canonical, OG) | [ok] |

### 2.3 Precios

| Capacidad | Ndivepa |
| --- | --- |
| Precio por moneda y por región | [ok] |
| Conjuntos de precios con reglas (`price-set`, `price-rule`) | [ok] |
| Listas de precios (venta, sobrescritura) con vigencia | [ok] |
| Precios por grupo de cliente | [ok] |
| Precios por cantidad (escalonados) | [ok] |
| Precio calculado con selección de la mejor regla | [ok] |
| Precios con impuestos incluidos o excluidos | [ok] |
| Estrategia de cálculo de precio de línea reemplazable | [ok] |
| Manejo de cambio de precio en carrito abierto | [ok] |

### 2.4 Inventario

| Capacidad | Ndivepa |
| --- | --- |
| Artículos de inventario desacoplados de variantes | [ok] |
| Niveles por ubicación (`stocked`, `reserved`, `incoming`) | [ok] |
| Reservas con referencia y liberación | [ok] |
| Movimientos de stock auditables (`allocation`, `sale`, `cancellation`, `release`, `adjustment`) | [ok] |
| Ubicaciones de stock con dirección | [ok] |
| Umbral de stock bajo y alerta | [ok] |
| Backorder y política de agotado | [ok] |
| Estrategia de asignación de stock reemplazable | [ok] |
| Kits / paquetes que consumen varios artículos | [ok] |

### 2.5 Carrito y pedido

| Capacidad | Ndivepa |
| --- | --- |
| Carrito con líneas, ajustes y líneas de impuesto | [ok] |
| Carrito por canal, región y moneda | [ok] |
| Fusión de carrito invitado con el de cliente | [ok] |
| Estrategia de pedido activo | [ok] |
| Máquina de estados de pedido con transiciones validadas | [ok] |
| Código de pedido con estrategia reemplazable | [ok] |
| Totales: subtotal, descuento, envío, impuesto, total, pagado, pendiente | [ok] |
| Recargos (`surcharge`) | [ok] |
| Transacciones y líneas de crédito | [ok] |
| Resumen de pedido (`order-summary`) | [ok] |
| Modificación de pedido / order edit con diferencia a cobrar | [ok] |
| Pedidos borrador (draft order) | [ok] |
| Historial de pedido por entrada (`history-entry`) | [ok] |
| Devoluciones con motivos y recepción | [ok] |
| Cambios (exchange) con envío de reemplazo | [ok] |
| Reclamaciones (claim) con imágenes | [ok] |
| Reembolsos totales y parciales | [ok] |
| Carritos abandonados y recuperación | [ok] |
| Pedido dividido por vendedor (marketplace) | [ok] |

### 2.6 Pagos

| Capacidad | Ndivepa |
| --- | --- |
| Colecciones y sesiones de pago | [ok] |
| Métodos de pago con elegibilidad | [ok] |
| Autorizar, capturar, cancelar, reembolsar | [ok] |
| Pagos parciales y multi-pago | [ok] |
| Estados de pago auditables | [ok] |
| Proveedor manual / transferencia / contra entrega | [ok] |
| Proveedor Stripe u otro pasarela real | [n/a] requiere credenciales |
| Idempotencia de webhooks de pago | [ok] estructura lista, sin credenciales |

### 2.7 Envío y fulfillment

| Capacidad | Ndivepa |
| --- | --- |
| Perfiles de envío | [ok] |
| Conjuntos de fulfillment y zonas de servicio | [ok] |
| Opciones de envío con reglas de elegibilidad | [ok] |
| Cálculo de precio de envío (fijo y calculado) | [ok] |
| Métodos de envío en carrito y pedido | [ok] |
| Fulfillment con estados y paquetes | [ok] |
| Seguimiento (tracking) y transportista | [ok] |
| Recogida en tienda (click & collect) | [ok] |
| Proveedor de transporte real | [n/a] requiere credenciales |

### 2.8 Promociones

| Capacidad | Ndivepa |
| --- | --- |
| Promoción con método de aplicación (fijo, porcentaje) | [ok] |
| Objetivo: pedido, líneas, envío | [ok] |
| Reglas con operadores (`in`, `eq`, `gt`, `lt`, …) | [ok] |
| Condiciones: mínimo de pedido, productos, grupo de cliente, facetas, buy-x-get-y | [ok] |
| Acciones: descuento de pedido, de línea, por producto, por faceta, envío gratis, buy-x-get-y | [ok] |
| Códigos de cupón con límite de uso global y por cliente | [ok] |
| Campañas con presupuesto (gasto o usos) y consumo | [ok] |
| Prioridad, exclusividad y apilamiento | [ok] |
| Distribución del descuento entre líneas | [ok] |
| Tarjetas regalo | [ok] |

### 2.9 Impuestos y regiones

| Capacidad | Ndivepa |
| --- | --- |
| Regiones con países y moneda | [ok] |
| Países y provincias | [ok] |
| Zonas fiscales | [ok] |
| Categorías y tasas de impuesto | [ok] |
| Tasa por zona + categoría + grupo de cliente | [ok] |
| Impuesto incluido o añadido | [ok] |
| Exención por cliente / número de IVA | [ok] |
| Proveedor de impuesto externo | [n/a] requiere credenciales |

### 2.10 Clientes y cuentas

| Capacidad | Ndivepa |
| --- | --- |
| Cliente registrado e invitado | [ok] |
| Grupos de cliente | [ok] |
| Direcciones múltiples con predeterminadas | [ok] |
| Métodos de autenticación por proveedor | [ok] |
| Verificación de correo y restablecimiento de contraseña | [ok] estructura; el envío requiere proveedor |
| Historial del cliente | [ok] |
| Consentimiento y exportación/borrado de datos | [ok] |

### 2.11 Administración y seguridad

| Capacidad | Ndivepa |
| --- | --- |
| Administradores y usuarios | [ok] |
| Roles y permisos granulares por recurso | [ok] |
| Invitaciones con token de un uso | [ok] |
| Claves de API con alcance y permisos | [ok] |
| Sesiones persistidas con revocación | [ok] |
| Auditoría de cambios con antes/después | [ok] |
| Ajustes globales y almacén de configuración | [ok] |
| Cabeceras de seguridad, CSRF, rate limit | [ok] |
| Contraseñas con scrypt y política de longitud | [ok] |
| 2FA / TOTP | [ok] |

### 2.12 Fuera de alcance mientras no exista acceso externo

Estas capacidades quedan modeladas pero **no activadas**, y no se simulan:

| Capacidad | Qué falta |
| --- | --- |
| Pasarela de pago real (Stripe, Adyen, …) | Credenciales y contrato |
| Envío con transportista real | Cuenta y credenciales |
| Correo transaccional | Proveedor SMTP/API y doble opt-in |
| APIs y feeds de redes de afiliación | Credenciales y términos autorizados |
| Postbacks de conversión | URL firmada y secreto por red |
| GA4 / píxeles de terceros | Consentimiento legal validado y propiedad |
| Redis / PostgreSQL | Infraestructura |
| Dominio, HTTPS, CDN, observabilidad | Proveedor y DNS |

---

## 3. Diferencia deliberada con Medusa y Vendure

Ndivepa **no** copia tres decisiones de esas plataformas:

1. **Base de datos relacional obligatoria.** Medusa exige PostgreSQL y Vendure un ORM. Ndivepa
   mantiene almacenamiento en documento con repositorios abstractos, para poder operar sin
   infraestructura. La ruta a PostgreSQL está en el plan, no en la dependencia.
2. **GraphQL como contrato principal** (Vendure). Ndivepa expone REST con OpenAPI generado; una
   capa GraphQL es opcional y posterior.
3. **Venta directa como camino predeterminado.** En Ndivepa el modo por defecto es `AFFILIATE`.
   El comercio directo es una capacidad que se enciende, no el punto de partida.
