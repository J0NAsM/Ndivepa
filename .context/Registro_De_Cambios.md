# Registro de cambios de Ndivepa

Este documento registra trabajo efectivamente realizado. Las tareas que dependen
de cuentas, credenciales, infraestructura o decisiones del propietario se separan
de forma explícita y nunca se presentan como completadas.

## 2026-09-04 · Revisión integral y descubrimiento afiliado

### Objetivos recibidos

1. Analizar el sistema completo e implementar al menos 50 mejoras significativas.
2. Continuar el endurecimiento y la verificación sin perder cambios existentes.
3. Incorporar dentro del sistema una opción que detecte demanda reciente y permita
   agregar oportunidades al catálogo con afiliación correctamente configurada.
4. Registrar el resultado completo en `.context`.

### Resultado general

- Se implementaron y documentaron 112 mejoras significativas. El detalle numerado
  está en [Auditoria_112_Mejoras.md](Auditoria_112_Mejoras.md).
- Se añadió **Panel administrativo → Descubrimiento**.
- Se corrigió una pérdida silenciosa de objetos extensibles en el validador que
  afectaba metadatos y otros campos con `allowUnknown`.
- Se actualizaron interfaz, configuración, API, pruebas, documentación y operación.
- No se modificaron ni eliminaron intencionalmente cambios ajenos presentes en el
  árbol de trabajo.

### Descubrimiento de oportunidades

#### Fuente y comportamiento

- Fuente implementada: RSS oficial de Google Trends en
  `https://trends.google.com/trending/rss?geo=XX`.
- El país se expresa como código ISO de dos letras y por defecto es `PY`.
- La respuesta se limita a 2 MB y 100 elementos.
- La solicitud usa timeout, rechaza redirecciones y solo puede dirigirse al endpoint
  fijo de Google Trends, evitando que la entrada del usuario se convierta en SSRF.
- Existe caché por país durante diez minutos y el refresco forzado se limita para
  evitar solicitudes repetidas.
- Se extraen consulta, tráfico aproximado, fecha y hasta tres titulares de contexto.
- Una clasificación prudente señala posible intención de producto. No convierte una
  tendencia general en producto ni afirma que sea un artículo más vendido.
- Los resultados con mayor probabilidad de producto y tráfico aparecen primero.

#### Requisitos del programa afiliado

Se añadieron al programa los campos `approvalStatus`, `credentialsVerifiedAt` y
`autoDiscovery`. Para poder importar, el sistema exige conjuntamente:

1. Programa activo.
2. Afiliación marcada como aprobada.
3. Fecha de verificación de credenciales.
4. Descubrimiento habilitado expresamente.
5. `trackingId` y `requiredTrackingKey` configurados.
6. Comercio activo y dominio permitido.
7. Red de afiliación activa.

La pantalla de Descubrimiento enumera los programas bloqueados y las razones, sin
ocultar una configuración incompleta.

#### API incorporada

- `GET /api/v1/admin/affiliate-opportunities`: consulta oportunidades, marca las ya
  existentes y devuelve programas habilitados/bloqueados.
- `POST /api/v1/admin/affiliate-opportunities/import`: valida una oportunidad vigente
  y crea el producto junto con el enlace afiliado.
- Ambas operaciones son administrativas. La lectura exige `product:create`; la
  importación exige además `affiliateLink:create` y protección CSRF para sesiones.
- `geo`, `limit` y `refresh` tienen esquema y límites declarativos.
- La importación rechaza nombres duplicados, destinos fuera del comercio, protocolos
  inseguros, tracking ausente o ambiguo y programas no preparados.
- Si falla la creación del enlace, el producto recién creado se revierte mediante
  borrado lógico para no dejar una oportunidad incompleta visible.
- El producto nace como borrador y solo cambia a publicado si el administrador lo
  solicita después de pasar todas las validaciones.
- Los metadatos guardan fuente, consulta, país, tráfico aproximado, fecha de la
  tendencia y fecha de importación.
- La URL afiliada se conserva exactamente; Ndivepa no agrega ni reemplaza parámetros.

#### Interfaz incorporada

- Nueva entrada **Descubrimiento** en la navegación administrativa.
- Selector de país y botón para consultar tendencias.
- Tarjetas con tráfico, fecha, contexto, clasificación y estado de catálogo.
- Formulario de preparación con programa aprobado, categoría, tipo, publicación,
  descripción editorial, precio, URL del producto y URL afiliada exacta.
- Vista de Programas ampliada con aprobación, tracking y estado de descubrimiento.
- Formulario para editar credenciales, comisión, aprobación, fecha de verificación,
  habilitación de descubrimiento y estado del programa.
- Estilos responsive específicos y contenido escapado antes de insertarlo en HTML.

### Corrección del validador de objetos extensibles

El modo `allowUnknown: true` aceptaba objetos de metadatos pero devolvía un objeto
vacío. Se añadió una copia recursiva segura que conserva los datos y rechaza las
claves `__proto__`, `prototype` y `constructor`. Esto protege contra contaminación
de prototipos y evita perder metadatos de descubrimiento, opciones o precios
heredados. Existe una prueba de regresión específica.

### Configuración incorporada

```dotenv
FEATURE_TREND_DISCOVERY=true
GOOGLE_TRENDS_GEO=PY
DISCOVERY_TIMEOUT_MS=10000
DISCOVERY_CACHE_TTL_MS=600000
```

La configuración valida el país, los tiempos y el interruptor antes de arrancar.
El estado seguro de integraciones incluye la fuente de tendencias sin exponer
secretos.

### Investigación y decisiones externas

- Google documenta que “Trending now” admite exportación RSS y se actualiza con
  frecuencia. Referencia: https://support.google.com/trends/answer/3076011?hl=es
- La API completa de Trends continúa con acceso alfa limitado. Referencia:
  https://developers.google.com/search/apis/trends
- Se comprobó que el RSS para Paraguay respondía, pero sus resultados incluían
  consultas generales. Por ello la solución conserva revisión humana y no presenta
  el feed como un ranking de productos.
- No se implementó scraping de comercios ni alta automática en programas.

### Evidencia final de verificación

| Comando o comprobación | Resultado |
| --- | --- |
| `node --check public/app.js` | Correcto. |
| `node --check src/modules/affiliate/trends.js` | Correcto. |
| `node --check src/modules/affiliate/index.js` | Correcto. |
| `npm run lint` | 85 archivos, sin incidencias. |
| `npm run verify` | 0 incidencias de integridad, invariantes o conformidad. |
| `npm test` | 78/78 pruebas aprobadas. |
| `npm run audit:dependencies` | 0 vulnerabilidades encontradas. |
| `npm run check:full` | Correcto. |
| `git diff --check` | Sin errores de espacios; existe un aviso LF/CRLF del lanzador. |
| Prueba HTTP autenticada de consulta | Respuesta 200, país y atribución correctos. |
| Prueba aislada de importación completa | Producto publicado, enlace válido, tracking válido y metadatos conservados. |

Las pruebas HTTP usan un `DATA_DIR` temporal y las pruebas manuales de importación
se realizaron sobre datos aislados. No alteraron el catálogo real del propietario.

### Estado externo que permanece pendiente

- No hay una cuenta afiliada real aprobada configurada en los datos revisados.
- No se importó ningún producto real al catálogo del propietario.
- Los programas y tracking de demostración son ficticios y quedan bloqueados para
  descubrimiento automático.
- Cada red o comercio debe aprobar la cuenta y emitir el identificador/enlace real.
- La comisión solo existe cuando la red atribuye, confirma y finalmente paga la
  conversión; una validación local no garantiza ese pago.
- Siguen pendientes dominio, HTTPS, hosting, PostgreSQL gestionado, correo, secretos
  de redes, firmas de webhooks y revisión legal.
- Docker no pudo ejecutarse localmente por no estar instalado.

### Archivos de referencia de esta intervención

- Servicio de tendencias: `src/modules/affiliate/trends.js`.
- Dominio, elegibilidad y rutas: `src/modules/affiliate/index.js`.
- Configuración: `src/framework/config.js` y `.env.example`.
- Conservación segura de metadatos: `src/framework/validate.js`.
- Interfaz: `public/app.js` y `public/styles.css`.
- Pruebas: `test/hardening.test.js`, `test/http.test.js` y
  `test/framework.test.js`.
- Uso funcional: [Descubrimiento_Afiliado.md](Descubrimiento_Afiliado.md).
- Estado consolidado: [Estado_Implementacion.md](Estado_Implementacion.md).

### Próxima acción necesaria del propietario

Obtener la aprobación de al menos un programa real y cargar en **Programas** el
comercio, dominios, red, ID de afiliado, tracking ID, parámetro requerido y fecha de
verificación. Después se podrá usar **Descubrimiento** para preparar la primera
oportunidad real como borrador y comprobar su atribución en el panel oficial de la
red antes de publicar.
