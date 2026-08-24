# Ndivepa · Inteligencia de afiliación

Ndivepa administra productos afiliados, comercios, programas, enlaces, clics, conversiones y comisiones desde un único panel. La plataforma es **AFFILIATE-first**: nunca procesa la compra ni cobra al cliente; el botón de oferta deriva al comercio externo y registra el interés internamente.

## Iniciar localmente

Requiere Node.js 20 o superior.

- Haz doble clic en `iniciar-ndivepa.cmd`, o ejecuta:

```powershell
cd D:\Proyectos\MarketingdeAfiliados\Ndivepa
npm run dev
```

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

## API local

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/api/products` | Productos afiliados publicados |
| POST | `/api/events/view` | Registra una visualización |
| GET | `/go/:linkId` | Registra clic y redirige al comercio |
| GET | `/api/affiliate-summary` | Dashboard administrativo |
| GET/POST/PATCH/DELETE | `/api/admin/*` | Gestión de dominios afiliados |
| POST | `/api/admin/links/validate` | Valida un enlace antes de guardarlo |

## Integraciones pendientes de credenciales

Las APIs de Amazon, Impact, Hotmart, PartnerStack, GA4, webhooks/postbacks, feeds de precio, pagos de comisión, correo y alertas reales requieren credenciales oficiales y la autorización de cada programa. Ndivepa deja su modelo de datos preparado para conectarlas sin mezclar la lógica de afiliación con marketplace o venta directa.

## Reiniciar los datos de demostración

```powershell
npm run reset-data
```

## Operación sin credenciales externas

```powershell
npm run maintenance
npm run import-products -- .\productos.csv
npm run import-conversions -- .\conversiones.csv
npm run export-report
```

Consulta [.context/Operaciones_Locales.md](.context/Operaciones_Locales.md), la [hoja de ruta](.context/Tareas_A_Realizar.md) y [Pasos_A_Seguir.md](Pasos_A_Seguir.md) para los formatos, prioridades y conexiones externas.
