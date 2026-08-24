# Plan maestro · paso a paso

Ruta de ejecución de la v0.1 (monolito afiliado) a la v0.2 (plataforma modular con paridad
Medusa + Vendure). Cada fase es independiente y verificable: al terminarla `npm test` pasa y la
aplicación sigue arrancando.

El backlog numerado vive en [Backlog_Mejoras.md](Backlog_Mejoras.md) (M-0001 … M-1040). Aquí
está el **orden**; allí está el **detalle**. El registro de lo ya ejecutado está en
[Registro_De_Cambios.md](Registro_De_Cambios.md).

---

## Regla de oro de cada paso

```text
1. Escribir o ajustar la prueba          -> test/
2. Implementar el módulo                 -> src/
3. Ejecutar `npm test`                   -> todo verde
4. Marcar el rango en Backlog_Mejoras.md
5. Anotar la fecha en Registro_De_Cambios.md
```

Nunca se avanza de fase con pruebas en rojo. Nunca se borra un dato existente sin migración.

---

## Fase 0 · Preparación (M-0001 … M-0020)

1. Copia de seguridad verificada: `npm run backup` y comprobar el checksum.
2. Congelar el contrato heredado: las 12 pruebas actuales pasan a ser el **contrato de
   regresión**; ninguna se modifica durante la refactorización.
3. Crear el árbol `src/framework`, `src/modules`, `src/api`.
4. Añadir `scripts/verify.js`: arranque, migración, integridad referencial y salida distinta de 0
   si algo falla.
5. Documentar la arquitectura (`Arquitectura.md`) y la paridad
   (`Paridad_Medusa_Vendure.md`). **Hecho.**

**Verificación:** `npm test` (12/12) y `node scripts/verify.js` en verde.

---

## Fase 1 · Framework base (M-0021 … M-0140)

Orden estricto, porque cada pieza depende de la anterior:

1. `errors.js` — jerarquía tipada con `code`, `status` y `details`.
2. `ids.js` — identificadores con prefijo y orden temporal.
3. `strings.js` — `slug`, `escapeHtml`, `escapeXml`, `truncate`.
4. `money.js` — unidades mínimas, porcentaje, reparto con restos.
5. `dates.js` — rangos, comparación de períodos, cálculo de vigencia.
6. `validate.js` — validador declarativo (tipos, requeridos, enums, longitudes, anidado).
7. `logger.js` — niveles y salida JSON con `requestId`.
8. `config.js` — env + valores por defecto + estrategias sustituibles.
9. `store.js` — persistencia atómica (`tmp` + `rename`), transacciones, migraciones.
10. `repository.js` — filtros con operadores, orden, paginación, `select`, soft delete.
11. `events.js` — bus con suscriptores, reintentos y cola de fallos.
12. `jobs.js` — cola con reintentos, backoff y programación.
13. `locks.js`, `cache.js`.
14. `workflow.js` — pasos con compensación e idempotencia.
15. `container.js` — registro, resolución, orden topológico y ciclo de vida.
16. `rbac.js`, `i18n.js`, `customfields.js`, `search.js`, `files.js`, `notifications.js`,
    `analytics.js`, `webhooks.js`, `ratelimit.js`, `plugins.js`, `telemetry.js`.
17. `http/router.js`, `http/pipeline.js`, `http/context.js`, `http/respond.js`,
    `http/middlewares.js`, `http/openapi.js`.

**Verificación:** pruebas unitarias por fichero en `test/framework.test.js`.

---

## Fase 2 · Migración del monolito (M-0141 … M-0200)

1. Migración `1 -> 2`: `schema: 'affiliate-v1'` pasa a `schemaVersion: 2` **conservando todos
   los datos**; los importes se normalizan a unidades mínimas.
2. Mover el dominio afiliado a `src/modules/affiliate/**` sin cambiar su comportamiento.
3. Sustituir el monkey-patch de `Server.prototype.emit` por el pipeline explícito.
4. `server.js` queda como arranque: 20 líneas legibles que componen el pipeline.
5. Mantener `src/api/legacy/` con **todas** las rutas v0.1 apuntando a los módulos nuevos.

**Verificación:** las 12 pruebas de regresión pasan sin haber sido tocadas.

---

## Fase 3 · Fundamentos de comercio (M-0201 … M-0320)

1. `settings` y `store` — ajustes globales, `commerceMode`, monedas soportadas.
2. `currency` — catálogo con decimales y símbolo.
3. `region` — regiones, países, provincias, zonas.
4. `tax` — categorías, tasas, resolución por zona y cálculo.
5. `channel` — canales de venta con visibilidad de catálogo y precio.
6. `seller` — vendedores para marketplace.
7. `role` + `user` + `invite` + `api-key` + `session` + `auth` — RBAC real.
8. `customer` + `customer-group` + `address`.

**Verificación:** `test/commerce-foundation.test.js`.

---

## Fase 4 · Catálogo (M-0321 … M-0460)

1. `asset` — activos con almacenamiento local y orden.
2. `product` — producto, variantes, opciones, valores, matriz de variantes.
3. `collection` y `category` — manual, por reglas y jerárquica.
4. `facet` + `facet-value` — filtrado.
5. `translation` — traducciones de catálogo.
6. `search` — índice invertido con facetas y sinónimos.

**Verificación:** `test/catalog.test.js`.

---

## Fase 5 · Precios e inventario (M-0461 … M-0580)

1. `pricing` — conjuntos de precios, reglas, precio calculado.
2. `price-list` — listas con vigencia y tipo.
3. `stock-location` — ubicaciones.
4. `inventory` — artículos, niveles, reservas, movimientos.

**Verificación:** `test/pricing-inventory.test.js`.

---

## Fase 6 · Carrito, pedido y checkout (M-0581 … M-0760)

1. `cart` — líneas, ajustes, impuestos, totales, fusión.
2. `order` — máquina de estados, totales, transacciones, historial.
3. `draft-order`.
4. `payment` — colecciones, sesiones, autorización, captura, reembolso.
5. `fulfillment` + `shipping` — perfiles, zonas, opciones, envíos, seguimiento.
6. `return` + `exchange` + `claim` + `refund`.

**Verificación:** `test/checkout.test.js` (recorrido completo con proveedor manual).

---

## Fase 7 · Promociones (M-0761 … M-0860)

1. `promotion` — método de aplicación, reglas, objetivos.
2. Condiciones y acciones equivalentes a las de Vendure.
3. `campaign` — presupuesto y consumo.
4. Cupones con límites de uso.
5. `gift-card`.

**Verificación:** `test/promotions.test.js`.

---

## Fase 8 · API pública y de administración (M-0861 … M-0940)

1. `src/api/store/**` — catálogo, carrito, pedido, cliente, pago, envío.
2. `src/api/admin/**` — gestión completa con paginación, filtros y `expand`.
3. OpenAPI generado en `/api/openapi.json` y `/api/docs`.
4. Versionado (`/api/v1`), `X-Request-Id`, `ETag` y `If-None-Match`.

**Verificación:** `test/api.test.js` + validación del documento OpenAPI.

---

## Fase 9 · Interfaz (M-0941 … M-1000)

1. Dividir `public/app.js` en vistas por dominio.
2. Panel de comercio: catálogo, inventario, pedidos, promociones, clientes.
3. Tienda: variantes, carrito y checkout, activos solo en modo `HYBRID`/`DIRECT`.
4. Accesibilidad: navegación por teclado, foco, `aria-live`, contraste.

**Verificación:** `test/ui.test.js` (renderizado de plantillas) y revisión manual.

---

## Fase 10 · Operación y cierre (M-1001 … M-1040)

1. `scripts/`: migrar, sembrar, verificar, indexar, reindexar, exportar OpenAPI, doctor.
2. Copias de seguridad rotativas y restauración probada.
3. Observabilidad: `/api/health`, `/api/ready`, métricas internas.
4. Documentación final y guía de despliegue.

**Verificación:** `npm test` completo y `node scripts/doctor.js` en verde.

---

## Lo que este plan no hace

No incluye pasos que requieran algo que el proyecto no tiene. Cada uno queda anotado con lo que
falta, para retomarlo cuando exista el acceso:

| Bloqueado | Requisito |
| --- | --- |
| Pasarela de pago real | Credenciales de Stripe/Adyen y contrato firmado |
| Envío con transportista | Cuenta y credenciales de API |
| Correo transaccional | Proveedor SMTP/API y política de doble opt-in |
| Feeds y APIs de afiliación | Credenciales y términos de cada red |
| Postbacks de conversión | Secreto y URL firmada por red |
| GA4 o píxeles | Texto legal aprobado y propiedad configurada |
| PostgreSQL / Redis | Infraestructura disponible |
| Dominio, HTTPS, CDN | Proveedor y acceso DNS |
| Core Web Vitals de campo | URL pública desplegada |
| Cuenta administradora real | Correo y contraseña del titular |
