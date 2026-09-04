# Estado de implementación local

Actualizado: 2026-09-04

La revisión integral más reciente implementó y verificó 112 mejoras en
seguridad, HTTP, persistencia, datos, autenticación, afiliación y experiencia.
El inventario comprobable está en [Auditoria_112_Mejoras.md](Auditoria_112_Mejoras.md).

## Capacidades incorporadas

- Descubrimiento afiliado: consulta segura del RSS oficial de Google Trends por país, clasificación prudente e importación de producto+enlace solo para programas aprobados, verificados y habilitados.
- Fidelización: programas, cuentas, libro mayor, reservas de puntos, canje y acumulación por pedido.
- Crédito de tienda: saldo monetario por cliente, movimientos auditables y ajustes administrativos.
- B2B: organizaciones, miembros, roles, órdenes de compra y aprobación previa al checkout.
- Suscripciones: contratos, periodos, prueba gratuita, pausa, reanudación, cancelación y renovaciones idempotentes.
- API: GraphQL de tienda (`/api/graphql`) y GraphQL administrativo protegido (`/api/v1/admin/graphql`), ambos gobernados por `FEATURE_GRAPHQL`.
- Operación: `GET /healthz`, `GET /api/ready`, métricas Prometheus en `GET /metrics`, diagnóstico y estado seguro de integraciones en `GET /api/v1/admin/integrations`.
- Seguridad: sesiones opacas de cliente, CSRF exigido a toda sesión de cookie, validación HTTP estricta y corrección de reparto entre varias tarjetas regalo.
- Catálogo de demostración: comercios, redes, programas, campañas, productos publicados con enlace validado y embudo de vistas, clics, conversiones y comisiones. Apagado en producción (`SEED_DEMO`).

## Correcciones de esta revisión

Todas partían de un defecto observable, no de una preferencia de estilo.

| Área | Defecto | Corrección |
| --- | --- | --- |
| Arranque | Un repositorio recién clonado no tenía catálogo: ningún módulo sembraba productos ni enlaces, así que 8 de las 20 pruebas fallaban y el panel arrancaba vacío. | `src/demo-seed.js` crea el catálogo afiliado pasando por los servicios de dominio: borrador → enlace → publicación, de modo que `assertPublishable` valida la demo igual que valida al panel. |
| Arranque | `bootstrapCli` no sembraba, así que `npm run verify` creaba el documento migrado y vacío; el servidor lo encontraba ya migrado y no sembraba nunca. La instalación quedaba a medias. | La semilla se activa por defecto en los scripts, y un fallo al sembrar detiene el arranque en vez de registrarse y seguir. |
| Pruebas | La suite leía y restauraba `data/db.json` del repositorio: sin ese fichero el `before` fallaba y tumbaba las 20 pruebas; con él, escribía sobre los datos de desarrollo. | Cada ejecución usa su propio `DATA_DIR` temporal. El arranque en frío pasa a ser parte de lo que se prueba. |
| Imagen | El `Dockerfile` copiaba `server.js` pero no `src/`, y no instalaba dependencias. La imagen no arrancaba. | Copia el código completo, instala con `npm ci --omit=dev`, corre como `node` sin privilegios y declara `HEALTHCHECK`. Un trabajo de CI construye la imagen y comprueba `/healthz`. |
| Límites | Las reglas de rate limit se evaluaban antes de autenticar, así que la clave `write:<actorId>` siempre caía en la IP: todo el panel compartía un cupo. | La autenticación va antes del rate limit. |
| CSRF | La comprobación salía por la puerta de atrás cuando faltaba la cookie del token, aunque la sesión fuera válida. | Toda petición autenticada por cookie —panel o cliente de tienda— exige token. |
| Cabeceras | `X-Request-Id` del cliente se devolvía sin sanear y se registraba tal cual. | Se acepta solo `[A-Za-z0-9._-]{1,80}`; cualquier otra cosa se sustituye por un identificador propio. |
| Estáticos | Se cargaba el fichero completo en memoria por petición, incluido lo que un `Range` iba a descartar. Una ruta con porcentaje mal formado daba 500. | Envío en flujo con `stream.pipeline`; codificación inválida y byte nulo devuelven 400. |
| Persistencia | `rename` sin `fsync` previo: un corte podía dejar el nombre nuevo apuntando a contenido incompleto. El temporal era un nombre fijo compartido entre procesos. | `fsync` del fichero y del directorio antes y después del `rename`; el temporal lleva el PID. En producción el documento se guarda compacto. |
| Comisiones | `approve()` usaba `conversion.commission || 0` y nadie rellenaba ese campo: toda comisión nacía con importe cero y el cálculo por tramos del programa no se usaba en ninguna parte. | La conversión resuelve su comisión al crearse y guarda su procedencia (`reported`, `estimated`, `none`) con la regla aplicada. |
| Importación | `import-conversions.js` era el último resto de la v0.1: escribía a mano en `data/db.json`, buscaba los productos en `affiliateProducts` —vacía desde la migración— y omitía todas las filas en silencio. Guardaba importes en decimales donde el sistema usa unidades mínimas. | Reescrito sobre los servicios de dominio: atribución, unicidad, estimación de comisión, auditoría e informe fila por fila con `--dry-run`. Acepta `product_handle` además de `product_id`. |
| Interruptores | `FEATURE_GRAPHQL` y `FEATURE_2FA` existían en la configuración y no los leía nadie: apagarlos no apagaba nada. | GraphQL no registra sus rutas si está apagado; el alta de verificación en dos pasos se rechaza con 409. |
| Lanzador | `iniciar-ndivepa.cmd` no instalaba dependencias y esperaba solo 6 s, así que en un equipo nuevo mostraba «no pudo iniciar» sin decir por qué. | Comprueba la versión de Node, instala si falta `node_modules`, espera 30 s y muestra el motivo real desde el registro. |
| Limpieza | `security.js` (467 líneas) era el monolito v0.1 completo, sin referencias desde ninguna parte, con su propia lógica de sesiones y subidas. | Eliminado. Su historia sigue en Git. |
| Documentación | README y `.context` apuntaban a `D:\Proyectos\MarketingdeAfiliados\Ndivepa`, una ruta de otra máquina. | Rutas relativas al repositorio. |

## Verificación

Desde un repositorio sin `data/db.json`:

- `npm run lint`: 83 ficheros, sin incidencias (sintaxis, importaciones locales, dependencias declaradas, restos de depuración).
- `npm run verify`: integridad referencial, invariantes y conformidad de módulos sin incidencias.
- `npm test`: 41 pruebas correctas — 24 de extremo a extremo sobre HTTP y 17 del framework (almacenamiento, configuración, CSRF, identificador de correlación, estáticos).
- `npm run check` encadena las tres.

La imagen de Docker no se pudo construir en este equipo porque no hay Docker
instalado; se comprobó reproduciendo su manifiesto de ficheros y arrancando el
servidor con `NODE_ENV=production` desde esa copia: responde `/healthz` y
`/api/ready` con 24 módulos y 682 rutas, y no siembra el catálogo de ejemplo. El
trabajo `docker` del flujo de calidad construye y arranca la imagen de verdad.

## Excepción acordada: conectores externos

No se activan pagos, SMTP, S3/CDN, búsqueda externa ni conectores empresariales sin credenciales oficiales. El código y `.env.example` están preparados para que solo sea necesario completar las variables del proveedor elegido. La API administrativa indica si cada integración está configurada, sin mostrar secretos.

Los identificadores de afiliado del catálogo de demostración (`ndivepademo-20`,
`NDIVEPADEMO`, `ndivepademo`) son ficticios y están marcados como tales en las
notas de cada programa. Sustitúyelos por los reales antes de publicar.
