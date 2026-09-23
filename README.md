<!-- BEGIN ECOSYSTEM ENTRY -->
Entrada vigente: [Ndivepa — contexto](<.context/contexto.md>). Identidad, alcance, reglas y comandos se consultan desde esa entrada. La documentación histórica se conserva; sus fotografías de estado no acreditan la situación actual.
<!-- END ECOSYSTEM ENTRY -->

# Ndivepa · Marketplace local + inteligencia de afiliación

Desde la v4, Ndivepa es un **marketplace multivendedor y comunidad de comercio local**, pensado para
empezar en Carapeguá y crecer por localidades a todo Paraguay. En un único catálogo conviven cuatro
modelos comerciales:

| Modelo | Quién vende / despacha | Botón del comprador |
| --- | --- | --- |
| `LOCAL` | una tienda aprobada del marketplace | Agregar al carrito |
| `PROPIO` | la plataforma | Agregar al carrito |
| `DROPSHIPPING` | la plataforma vende; despacha un proveedor | Agregar al carrito |
| `AFILIADO` | un comercio externo (programa de afiliación) | Ver oferta ↗ (con aviso de salida) |

El módulo de afiliación original se conserva completo (panel clásico en `/panel.html`). El marketplace
necesita `COMMERCE_MODE=HYBRID` (o ajustarlo en *Administración → Configuración*); en `AFFILIATE`
carrito y checkout siguen apagados, como antes.

### Marketplace: rutas principales

- Público: `/` portada, `/buscar`, `/categoria/:handle`, `/producto/:handle`, `/tienda/:código`, `/tiendas`,
  `/ofertas`, `/explorar` (mapa), `/comunidad`, `/carrito`, `/checkout`.
- Cuenta (comprador, vendedor y proveedor con la misma cuenta): `/ingresar`, `/cuenta/...`, `/vender`,
  `/mi-tienda/:id/...`, `/cuenta/proveedor/:id`.
- Personal (RBAC): `/admin/...`. Roles nuevos: `moderator` y `marketplace_manager`.
- API: `/api/v1/store/marketplace/*`, `/api/v1/store/community/*`, `/api/v1/store/dropshipping/portal/*`,
  `/api/v1/admin/marketplace/*`, `/api/v1/admin/community/*`, `/api/v1/admin/dropshipping/*`, anuncios en
  `/api/v1/admin/ad-campaigns`. Contrato completo en `/api/docs`.

### Instalable y con mala conexión

La tienda pública es una PWA: se puede instalar en el celular y, sin conexión, sigue mostrando la
aplicación y las páginas públicas ya visitadas. Nada de `/api`, carrito, cuenta, «mi tienda» ni
administración se guarda en la caché.

### Cuentas de demostración (solo desarrollo, `SEED_DEMO`)

Tiendas `hamacas@demo.ndivepa.local`, `sabores@demo.ndivepa.local`, `moda@demo.ndivepa.local` y comprador
`comprador@demo.ndivepa.local`, con la contraseña de `DEMO_ACCOUNT_PASSWORD` o, si falta,
`Demo-Ndivepa-2026!`. Las tiendas y productos demo están marcados «(demo)» y no se crean en producción.

---

La parte de afiliación mantiene su regla original: en los productos `AFILIADO` Ndivepa nunca procesa la
compra ni cobra al cliente; el botón de oferta deriva al comercio externo y registra el interés internamente.

## Iniciar localmente

Requiere Node.js 20 o superior.

- Haz doble clic en `iniciar-ndivepa.cmd`, o ejecuta:

```powershell
cd <carpeta-del-repositorio>
npm install
npm run dev
```

El primer arranque aplica las migraciones, siembra los datos base y crea un
catálogo afiliado de demostración: comercios, redes, programas, campañas,
productos publicados con su enlace validado y un embudo de vistas, clics y
conversiones para que el panel no aparezca vacío. Ese catálogo de ejemplo solo
se crea si no hay ningún producto, y **no** se crea con `NODE_ENV=production`
(se puede forzar con `SEED_DEMO=true`).

Abre `http://localhost:4300`. El acceso de administrador inicial es:

```text
admin@ndivepa.local
Ndivepa2026!
```

Cambia esa contraseña antes de publicar el proyecto.

Por seguridad, el formulario de acceso no completa las credenciales iniciales. Úsalas solo para el primer acceso local y define una contraseña única de al menos 12 caracteres antes de exponer el panel.

En una instalación nueva de producción, define `INITIAL_ADMIN_EMAIL` e
`INITIAL_ADMIN_PASSWORD` en el entorno antes del primer arranque. La aplicación no
crea una cuenta administradora en producción sin esa contraseña propia.

## Incluido

- Productos afiliados con categoría, tipo, comercio, programa, campaña, precio y estado de publicación.
- Separación explícita de URL normal y URL de afiliado.
- Catálogo de comercios, redes, programas, campañas y ubicaciones de tracking.
- Validación de enlaces: formato, protocolo, host seguro, dominio del comercio, programa y tracking ID configurado.
- Protección SSRF: bloquea `localhost`, IPs directas, hosts `.local`/`.internal` y protocolos inseguros. No realiza scraping ni modifica parámetros de enlaces.
- Redirección `/go/:linkId` que registra `affiliate_click` y genera un `CLK-...` sin alterar el enlace de la red.
- Registro de vistas de producto, clics, conversiones, comisiones, alertas y auditoría administrativa.
- Dashboard con embudo, CTR, conversión, EPC, comisiones por estado y rendimiento por producto.
- Estados de comisión separados: pendiente, aprobada/confirmada y pagada. Las ventas atribuidas nunca se presentan como ingreso propio.
- Descubrimiento administrativo con Google Trends por país, revisión de contexto e importación solo mediante programas afiliados aprobados y tracking validado.

## API local

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/api/products` | Productos afiliados publicados |
| POST | `/api/events/view` | Registra una visualización |
| GET | `/go/:linkId` | Registra clic y redirige al comercio |
| GET | `/api/affiliate-summary` | Dashboard administrativo |
| GET/POST/PATCH/DELETE | `/api/admin/*` | Gestión de dominios afiliados |
| POST | `/api/admin/links/validate` | Valida un enlace antes de guardarlo |
| POST | `/api/graphql` | Lectura pública de catálogo y configuración |
| POST | `/api/v1/admin/graphql` | Resumen administrativo autenticado |
| GET | `/api/v1/admin/*` · `/api/v1/store/*` | API modular v1 |
| GET | `/api/v1/admin/affiliate-opportunities` | Consulta tendencias para revisión administrativa |
| POST | `/api/v1/admin/affiliate-opportunities/import` | Importa una oportunidad con un programa afiliado verificado |
| GET | `/api/openapi.json` · `/api/docs` | Contrato generado y documentación |
| GET | `/healthz` · `/api/ready` · `/metrics` | Sonda, estado de arranque y métricas |
| GET | `/producto/:slug` · `/campana/:code` · `/sitemap.xml` · `/robots.txt` | Páginas indexables |

La superficie GraphQL se puede apagar con `FEATURE_GRAPHQL=false`, y en ese caso
las dos rutas no se registran ni aparecen en el contrato OpenAPI.

## Integraciones pendientes de credenciales

Las APIs de Amazon, Impact, Hotmart, PartnerStack, GA4, webhooks/postbacks, feeds de precio, pagos de comisión, correo y alertas reales requieren credenciales oficiales y la autorización de cada programa. Ndivepa deja su modelo de datos preparado para conectarlas sin mezclar la lógica de afiliación con marketplace o venta directa.

## Comprobaciones

```powershell
npm run check        # estática + integridad + pruebas
npm run check:full   # todo lo anterior + auditoría de dependencias
npm run lint         # sintaxis, importaciones y dependencias declaradas
npm run verify       # integridad referencial, invariantes y conformidad
npm test             # 102 pruebas (HTTP de extremo a extremo, marketplace y hardening)
npm run test:ui      # 8 recorridos en navegador sin cabeza (se omite si no hay Edge/Chrome)
npm run audit:dependencies # vulnerabilidades altas/críticas de producción
npm run doctor       # diagnóstico con recuento por colección
```

`npm run check` funciona sobre un repositorio recién clonado: no hace falta
ningún fichero de datos previo. La suite HTTP arranca el servidor con su propio
`DATA_DIR` en una carpeta temporal, así que no toca los datos de desarrollo.

## Reiniciar los datos de demostración

```powershell
npm run reset-data
```

Borra `data/db.json`. El siguiente arranque vuelve a migrar y sembrar.

## Operación sin credenciales externas

```powershell
npm run maintenance
npm run import-products -- .\productos.csv [--dry-run]
npm run import-conversions -- .\conversiones.csv [--dry-run]
npm run export-report
npm run backup && npm run verify-backup
npm run seed          # semilla idempotente sin arrancar el servidor
npm run migrate       # aplica migraciones pendientes con snapshot previo
npm run reindex       # reconstruye el índice de búsqueda
npm run openapi       # exporta exports/openapi.json
```

Los formatos están en [examples/](examples/) y ambos importadores funcionan
contra el catálogo de demostración tal cual. Los importes del CSV van en
decimales; el sistema los guarda en unidades mínimas. En las conversiones el
producto se puede indicar con `product_id` o con `product_handle`, y si no
llega la columna `commission` se estima con las reglas del programa y queda
marcada como estimada, nunca como informada por la red.

## Despliegue con Docker

```powershell
docker compose up --build
```

`INITIAL_ADMIN_EMAIL` e `INITIAL_ADMIN_PASSWORD` son obligatorias: en
producción la aplicación no crea ninguna cuenta con contraseña por defecto. La
imagen corre sin privilegios, declara su propia sonda de vida contra `/healthz`
y guarda datos, copias y subidas en volúmenes separados.

Consulta [.context/Operaciones_Locales.md](.context/Operaciones_Locales.md), la [hoja de ruta](.context/Tareas_A_Realizar.md) y [Pasos_A_Seguir.md](Pasos_A_Seguir.md) para los formatos, prioridades y conexiones externas.

La configuración y los límites del descubrimiento están en
[.context/Descubrimiento_Afiliado.md](.context/Descubrimiento_Afiliado.md).
