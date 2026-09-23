# Marketplace multivendedor (v4)

Fecha: 2026-09-22. Estado: implementado y probado en local (ver «Verificación»). Despliegue: NO DETERMINADO.

## Objetivo

Convertir Ndivepa en el punto de encuentro digital de comercios, emprendedores, artesanos y compradores de
Carapeguá, preparado para crecer por localidades a todo Paraguay. El comprador percibe un único marketplace;
internamente cada producto conserva su **modelo comercial**.

## Principio de integración

No se creó una arquitectura paralela. El marketplace se apoya en los módulos existentes:

| Necesidad | Se reutiliza | Se agregó |
| --- | --- | --- |
| Tienda del vendedor | recurso `seller` (módulo `channel`) | campos de perfil público/privado, estados `rejected`, `publicView()` |
| Productos | `catalog` (producto, variante, activos, etiquetas) | `commercialModel`, `sellerId`, `supplierId`, `localityId`, `deliveryModes`, `shippingInfo`; registro extensible `COMMERCIAL_MODELS` |
| Precios y stock | `pricing`, `inventory` | ubicación de stock por tienda (`store`) y por proveedor (`dropship`) |
| Búsqueda | `SearchIndex` | plurales, Damerau-Levenshtein acotado, cobertura de términos, filtros sobre listas, sinónimos locales, `useReranker` (IA futura), enriquecedor del documento |
| Carrito / checkout / pago | `cart`, `checkout` (workflow), `payment` | la línea lleva `sellerId`/`supplierId`/`commercialModel` |
| Pedido | `order` (sin cambios de contrato) | subpedidos `vendorOrders` creados al confirmar |
| Envíos | `fulfillment` | el subpedido crea y despacha su fulfillment; consumo de stock y transición del pedido siguen en el módulo existente |
| Promociones | `promotion` | promoción de tienda = `targetRules` sobre `sellerId` + `metadata.sellerId` |
| Afiliados | `affiliate`, `/go/:linkId` | postback firmado; ficha del marketplace con canonical a la ficha editorial |
| Roles de personal | `rbac` | `moderator`, `marketplace_manager` |

## Módulos nuevos

- `src/modules/marketplace/` — localidades, membresías y alta de tiendas, publicaciones, reglas de comisión,
  subpedidos, libro contable, liquidaciones, planes, bandeja de avisos, descubrimiento, reputación,
  recomendaciones y contratos de integración (`adapters.js`).
- `src/modules/community/` — favoritos, me gusta, seguidores, reseñas verificadas, preguntas, publicaciones,
  feed, reportes y moderación, mensajería comprador ↔ tienda con antispam.
- `src/modules/dropshipping/` — proveedores, costos/márgenes, sincronización por CSV, pedidos al proveedor,
  portal del proveedor.
- `src/modules/advertising/` — anuncios pagados separados del ranking orgánico.
- `src/api/seo/marketplace.js` — SSR de metadatos, Open Graph, canonical y JSON-LD sobre el shell de la SPA.
- `public/mp/` — SPA pública mobile-first (módulos ES sin compilación). El panel clásico sigue en `public/panel.html`.

## Decisiones

1. **Capacidades, no roles fijos.** Comprador, vendedor y proveedor son capacidades de la misma cuenta de
   cliente, deducidas de `sellerMembers`/`supplierMembers`. Administración y moderación siguen siendo
   `users` con RBAC.
2. **Códigos internos en inglés, etiquetas en español** (convención del proyecto). Tienda: `pending`
   (PENDIENTE), `active` (APROBADO), `rejected` (RECHAZADO), `suspended` (SUSPENDIDO). Subpedido: `created`,
   `payment_pending`, `paid`, `preparing`, `ready_to_ship`, `shipped`, `in_transit`, `delivered`,
   `cancelled`, `returned`. Los modelos comerciales usan los códigos pedidos: `LOCAL`, `PROPIO`,
   `DROPSHIPPING`, `AFILIADO`.
3. **Comisiones sin porcentajes en código.** `commissionRules` con alcance producto › tienda › campaña ›
   categoría (hereda del árbol) › modelo comercial › global. La semilla crea una regla global del 10 %
   editable. El importe se congela en cada línea del subpedido.
4. **Quién financia el descuento.** Promoción con `metadata.sellerId` de la tienda: la paga la tienda y la
   comisión se calcula sobre el importe con descuento. Promoción de la plataforma: la paga la plataforma
   (asiento `platform_discount`) y no reduce lo que cobra la tienda.
5. **Libro contable por flujos** (`ledgerEntries`): ventas del marketplace (GMV), comisiones, ventas propias,
   publicidad, suscripciones, descuentos de plataforma, pagable a tiendas, costo y margen de dropshipping.
   Estados `accrued` → `confirmed` (entregado) → `paid`; cancelado/devuelto → `reversed` (con asiento negativo
   si ya se había liquidado). Los ingresos de afiliados se leen de `commissions` por moneda, sin mezclarse.
6. **Pago contra entrega/en tienda** permite preparar antes del cobro; transferencia exige pago confirmado.
7. **Privacidad.** La tienda pública nunca expone RUC, razón social, correo, teléfono de contacto ni dirección;
   las coordenadas solo si la tienda las publica. La tienda ve de su comprador nombre, teléfono y dirección
   solo si debe entregar; en retiro no ve la dirección. El proveedor recibe solo los datos de despacho.
8. **Reseñas verificadas.** Solo con subpedido entregado del producto (configurable). Afiliados no se valoran:
   no se puede verificar la compra.
9. **Publicidad** servida en su propia lista (`/marketplace/sponsored`), siempre etiquetada «Patrocinado»,
   solo si está aprobada, cobrada y vigente.
10. **Escala geográfica por datos.** `localities` (país › departamento › ciudad) con `launchStatus`. No hay
    lógica del tipo `if ciudad == ...`: Carapeguá es la localidad predeterminada en ajustes.
11. **Afiliados y SEO.** La ficha `/producto/:handle` de un afiliado declara canonical a la ficha editorial
    existente (`/producto/<slug>-<id>`) y no entra al sitemap; enlaces salientes `sponsored nofollow noopener`.
12. **Integraciones sin simulación.** Pasarelas, transportistas, APIs de proveedores e IA tienen contratos y
    adaptadores nulos/manuales; los externos responden `integration_not_configured`.
13. **Modo de comercio.** El marketplace requiere `HYBRID`. `COMMERCE_MODE` del entorno ahora sí se aplica
    (antes lo tapaba el valor por defecto de ajustes). La semilla de demostración (solo desarrollo) pasa a
    `HYBRID`.

## Defectos previos corregidos durante el trabajo

- `COMMERCE_MODE` no tenía efecto (lo anulaba `DEFAULT_SETTINGS.commerceMode`).
- `BaseService.seed` no aplicaba los valores por defecto del esquema: zonas, regiones y ubicaciones sembradas
  quedaban sin `active` y ninguna opción de envío resultaba elegible. Corregido en la semilla, en la
  resolución de zonas y con un relleno en la migración v4.
- `/api/v1/admin/audits` exigía `audit:read` sin que el permiso estuviera declarado.
- `respond.list` descartaba campos extra (facetas, correcciones, contadores no leídos).
- `/api/products` (contrato v0.1 «catálogo afiliado») habría devuelto productos locales etiquetados como
  afiliados: ahora filtra por modelo `AFILIADO`.

## Mejoras aplicadas (2026-09-22, segunda tanda)

1. **Rendimiento.** Indexado incremental por producto en lugar de reindexar el catálogo entero en cada
   cambio, caché con invalidación por evento en las lecturas públicas y `ETag` con 304 en portada,
   categorías, ofertas, ficha, tienda y localidades. La portada solo arma las tarjetas que muestra.
   Medido con 513 productos: reindexado 580 ms → 1 ms por producto; portada 277 ms → 49 ms sin caché y
   ~0 ms con caché; ficha 6,8 ms → 0,3 ms.
2. **Devoluciones y reembolsos de punta a punta.** El comprador solicita la devolución desde su pedido,
   la tienda la ve en su panel, administración aprueba, registra la recepción con inspección y el
   reembolso, y el subpedido totalmente devuelto revierte sus asientos. El stock vuelve a la ubicación
   desde la que se vendió (antes siempre al depósito principal) y ahora se puede devolver lo ya
   entregado aunque otra tienda del mismo pedido siga preparando.
3. **Envío por tienda.** Cada grupo del carrito (tienda, proveedor o plataforma) elige su propia opción
   y tarifa; el subpedido guarda su `groupKey`, su envío y su modo de entrega. Si un grupo no declara
   método, el envío del pedido se reparte en proporción, como antes.
4. **PWA y límites.** Service worker (archivos de la aplicación y páginas públicas ya vistas; nada de
   `/api`, carrito, cuenta, mi tienda ni administración), manifiesto instalable con accesos directos, y
   límite de escrituras por cuenta de cliente en vez de por IP (una conexión compartida ya no se
   penaliza a sí misma).

Defectos adicionales corregidos: la recepción de una devolución no emitía evento (no se auditaba ni
disparaba nada) y `approve`/`reject` tampoco.

## Mejoras aplicadas (2026-09-22, tercera tanda)

1. **Sinónimos de búsqueda editables.** Colección `searchSynonyms` con CRUD de administración
   (`/api/v1/admin/search-synonyms`); el índice los recarga al arrancar y con cada evento
   `searchSynonym.*`, así que una palabra nueva cambia la búsqueda sin tocar código ni reiniciar.
   `/api/v1/admin/marketplace/search-tuning` muestra los sinónimos activos junto a las búsquedas que
   no devolvieron nada, que es de donde salen los sinónimos que faltan.
2. **Exportaciones CSV.** `/api/v1/admin/marketplace/exports/:dataset` para pedidos, contabilidad,
   liquidaciones, productos y tiendas, con importes en unidades mínimas y su moneda en columna aparte;
   botones en la vista general y en liquidaciones del panel de administración.
3. **Imágenes más livianas.** `prepareImage` redimensiona en el navegador antes de subir (lado máximo y
   recompresión), tanto en las fotos de producto y tienda como en el avatar del comprador. Evita subir
   fotos de móvil de varios megabytes a una persistencia en JSON.
4. **Accesibilidad de las pestañas.** `mountTabs` relaciona cada pestaña con su panel (`role="tab"`,
   `aria-controls`, `aria-selected`, foco y flechas ←/→) en la ficha de producto y en la página de
   tienda; se quitó el `role="listbox"` que las sugerencias del buscador declaraban sin serlo.
5. **Pruebas de interfaz en el repositorio.** `npm run test:ui` ejecuta siete recorridos reales con
   Edge sin cabeza por CDP (portada, búsqueda con errores de tipeo, agregar al carrito, carrito
   agrupado por tienda, checkout con entrega por tienda, página de tienda y funcionamiento sin
   conexión). Si no hay navegador, se omite sin fallar; `check:full` lo incluye.

Defecto adicional corregido: **`PATCH` exigía los campos obligatorios del recurso**, de modo que en
cualquier CRUD genérico no se podía modificar un solo campo (p. ej. desactivar un sinónimo con
`{ active: false }` daba 422). El perímetro HTTP valida el cuerpo de `PATCH` en modo parcial
(`route.bodyPartial`): sigue rechazando campos desconocidos y tipos inválidos, pero no exige lo que
no se envía.

## Conversión: vender al entrar (2026-09-22, cuarta tanda)

Punto de partida documentado (investigación externa): el coste de envío que aparece tarde explica cerca de la
mitad de los carritos abandonados, y le siguen la cuenta obligatoria, el checkout confuso y el plazo de
entrega poco claro; el abandono medio del comercio electrónico ronda el 70 %. Todo lo aplicado usa datos
reales del sistema: no hay urgencia falsa, contadores inventados ni promesas que la configuración no
respalde.

1. **El coste y el plazo, antes de decidir.** La ficha muestra la entrega estimada a una ciudad con las
   mismas opciones que después se cobran (`DeliveryEstimateService`), con su plazo en palabras («hoy o
   mañana») y el umbral real de envío gratis (`free_over`). El carrito estima el envío por tienda aunque
   todavía no haya dirección, y dice para qué ciudad lo estimó. Si no hay ninguna opción configurada, se
   dice que no se puede estimar en vez de inventar un importe.
2. **Invitado por delante.** El checkout dice primero que no hace falta crear cuenta y deja el acceso como
   atajo, no como requisito. Se añadieron `inputmode` en correo y teléfono para el teclado del móvil.
3. **Bloqueos y avisos donde se decide.** El checkout ya muestra los avisos del carrito y los `blockers`
   del backend (stock insuficiente, línea no disponible), las instrucciones reales del medio de pago y las
   garantías junto al botón de confirmar.
4. **Confianza con datos de la configuración.** `/marketplace/config` expone un bloque `trust` (medios de
   pago activos, días de devolución, si las reseñas exigen compra, contacto). De ahí salen la caja «Tu
   compra está protegida» de la ficha, el bloque «cómo funciona» de la portada y la cinta del pie.
5. **Prueba social real.** La portada suma pedidos entregados y la media de reseñas publicadas; si todavía
   no hay, no se muestra nada. Las tarjetas muestran modos de entrega, unidades vendidas y «últimas
   unidades» solo cuando el inventario lo dice.
6. **La visita que no compra, no se pierde.** Producto agotado: aviso de reposición (`stockAlerts`) que se
   dispara con `inventory.adjusted` cuando vuelve el stock, una sola vez por pedido de aviso. Carrito
   abandonado: recordatorio con el enlace firmado y la pantalla `/carrito/recuperar`, que **antes no
   existía** (el enlace que generaba el backend terminaba en 404, así que la recuperación no funcionaba).
7. **Más para comprar y menos para perderse.** Sugerencias de la misma tienda en el carrito, filtro por
   valoración mínima, filtros activos visibles con salida en un clic y el canje de puntos que faltaba en el
   resumen de totales.

Defectos previos corregidos en esta tanda: el enlace de recuperación de carrito no tenía pantalla ni
endpoint (función muerta); `loyaltyTotal` no se mostraba en los totales, así que el total podía no cuadrar
a la vista; y `eligible()` no devolvía el umbral de envío gratis, de modo que no se podía decir cuánto
faltaba para alcanzarlo.

Añadido para poder comprobarlo: `GET /api/v1/admin/notifications` (qué avisos salieron y cuáles fallaron),
sin el cuerpo del mensaje porque puede llevar enlaces firmados.

## Difusión: compartir y vender fuera del sitio (2026-09-22, quinta tanda)

En comercio local, la mayoría del tráfico llega por enlaces pegados en WhatsApp y Facebook. Un enlace sin
vista previa no se abre, y un catálogo que no se puede exportar no llega a esas plataformas.

1. **Vista previa correcta del enlace.** El SSR de la ficha declara `og:type=product` con
   `product:price:amount`, `product:price:currency`, `product:availability`, marca y tienda, además de
   `og:site_name`, `og:locale=es_PY` y `og:image:alt`. Al pegar el enlace en WhatsApp o Facebook se ve foto,
   precio y si hay stock.
2. **Compartir donde está la gente.** El botón «Compartir» usa el menú del sistema en móvil y, en
   escritorio, ofrece WhatsApp, Facebook y copiar enlace.
3. **Catálogo exportable.** `/feeds/catalogo.csv` y `/feeds/catalogo.xml` (RSS con el espacio de nombres de
   Google Merchant) publican el catálogo real para las tiendas de Facebook e Instagram. Con
   `?tienda=<código>`, el catálogo de una sola tienda, enlazado desde su panel. Los productos afiliados
   quedan fuera: se compran en otro sitio y anunciarlos como propios sería engañoso. `/feeds/` no se cachea
   en el service worker, para no publicar precios viejos.
4. **Diagnóstico de publicaciones.** El panel de la tienda dice qué fichas activas están sin foto, con
   descripción demasiado corta, sin stock, sin forma de entrega o sin categoría, nombrando los productos
   concretos. Son comprobaciones sobre el catálogo real, no consejos genéricos.

## Verificación (2026-09-22, local)

- `npm run lint`: 109 ficheros sin incidencias. `npm run verify` sin incidencias. Conformidad de rutas contra
  el router: 0 hallazgos. `npm run audit:dependencies`: 0 vulnerabilidades.
- `npm test`: 102/102 (78 previas + 24 de `test/marketplace.test.js`, incluidas envío por tienda,
  devolución con reverso contable, `ETag`, sinónimos editables, exportaciones CSV, entrega estimada en la
  ficha, envío estimado en el carrito, rescate de carrito con firma, recordatorio único y aviso de
  reposición de stock, Open Graph de producto con precio y disponibilidad, catálogo CSV/RSS global y por
  tienda, y diagnóstico de publicaciones mejorables).
- `npm run test:ui`: 8/8 recorridos, incluida la comprobación de que la ficha muestra coste, plazo y
  garantías, y de que el carrito ya no dice «se calcula en el checkout».
- Interfaz en Edge sin cabeza con emulación móvil (375–390 px) y escritorio (1280 px), claro y oscuro, sin
  desborde horizontal; flujos por clics: compra de invitado completa, alta de vendedor hasta solicitud enviada,
  publicación de producto y avance de subpedido, checkout multitienda con una entrega por tienda y
  solicitud de devolución. Service worker registrado y ficha servida desde caché con la red apagada.
  Sin errores de JavaScript en consola.

## Pendientes reales

- Programa de afiliados propio (referidos de usuarios con capacidad `affiliate`): la capacidad existe, el
  programa de referidos no.
- Pasarela de pago en línea, transportistas con API, APIs de proveedores y proveedor de IA: solo contratos.
- Correo/SMS: las notificaciones se registran (bandeja interna + registro de envío) sin proveedor de envío.
- Mapa esquemático en SVG (sin teselas externas por la CSP); un mapa con calles requiere un proveedor.
- Combos/ofertas del día como entidades propias; hoy se cubren con promociones y precio anterior.
- Rendimiento: el `Store` en JSON clona el documento por transacción; las lecturas ya están cacheadas,
  pero para volumen real conviene migrar la persistencia (el repositorio ya la abstrae).
- Tarifas de envío propias por tienda (hoy elige entre las opciones configuradas por la plataforma).
- Textos de la interfaz solo en español; el framework de i18n está disponible.
- Zonas generales de Carapeguá sembradas como genéricas («Centro», «Zona urbana», «Zona rural»): reemplazar
  por las reales desde *Administración → Localidades*.
