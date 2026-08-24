# Hoja de ruta de Ndivepa

Este archivo es el checklist operativo del proyecto. Cada mejora se marca al terminarse y se acompaña de una nota breve para que el estado no dependa de la conversación.

## Prioridad actual · conversión y confianza

- [x] Rediseñar la portada pública para explicar el modelo afiliado con claridad.
  - Completado: hero editorial, principios de confianza, pie con divulgación y diseño responsive.
- [x] Incorporar descubrimiento de catálogo.
  - Completado: búsqueda, filtros por categoría, ordenamiento y estado vacío.
- [x] Incorporar favoritos locales sin pedir una cuenta al visitante.
- [x] Crear ficha informativa previa a la salida al comercio.
  - Completado: detalle con precio, comercio, validación del enlace y divulgación afiliada.
- [x] Eliminar el autocompletado de las credenciales iniciales en el acceso administrativo.
- [x] Añadir edición completa de productos, enlaces, precios y estado desde el panel.
- [x] Añadir carga de imagen propia por producto con validación de tipo, tamaño y almacenamiento seguro.
  - Completado: carga autenticada de PNG/JPEG/WebP, firma binaria validada, máximo 700 KB y volumen Docker persistente para `public/uploads`.
- [x] Añadir guías editoriales que enlacen a los productos recomendados.
  - Completado: `public/guias.html` incluye guías de tecnología y formación con enlaces a fichas públicas.
- [ ] **No realizable actualmente:** añadir comparativas editoriales. Motivo: faltan alternativas reales comparables y criterio editorial aprobado.

## SEO y adquisición orgánica

- [x] Crear páginas públicas indexables por producto con URL legible, metadatos, canonical y Open Graph dinámicos.
- [x] Crear sitemap XML dinámico e incluirlo en `robots.txt`.
- [x] Añadir datos estructurados JSON-LD de `Product`, `Offer` y divulgación afiliada cuando corresponda.
- [ ] **No realizable actualmente:** configurar dominio público, HTTPS y URL base. Motivo: no existe `.env`, dominio ni acceso a DNS/hosting en el proyecto.
- [ ] **No realizable actualmente:** medir Core Web Vitals de campo. Motivo: requiere una URL pública desplegada; las optimizaciones locales ya están aplicadas.
  - Parcial: imágenes propias limitadas a 700 KB y caché prudente para recursos estáticos implementadas localmente; falta medición real de campo/laboratorio tras el despliegue.

## Analítica y operación

- [x] Añadir filtro temporal y comparación de períodos al dashboard.
- [x] Añadir métricas por comercio, programa, campaña, ubicación y fuente de tráfico.
- [x] Añadir gráficos de evolución de clics, conversiones y comisiones sin confundir ventas atribuidas con ingresos propios.
  - Completado: evolución diaria con barras diferenciadas para vistas, clics y conversiones; las comisiones conservan su estado financiero separado en el panel.
- [x] Permitir descargar informes filtrados desde el panel.
- [x] Programar el mantenimiento local y mostrar la fecha de la última ejecución.
  - Completado: tarea de Windows `Ndivepa-Mantenimiento` registrada diariamente a las 03:00; el panel muestra el último registro de mantenimiento.
- [ ] **No realizable actualmente:** integrar feeds o APIs oficiales. Motivo: faltan credenciales y autorización de cada red de afiliación.
- [x] Añadir detección de precio desactualizado y reglas configurables de alertas.
  - Completado: mantenimiento local configurable con `LINK_STALE_DAYS` y `PRICE_STALE_DAYS`.

## Marketing, privacidad y seguridad

- [x] Añadir consentimiento de analítica y una política de privacidad antes de instalar píxeles o GA4.
  - Completado: consentimiento explícito para analítica interna, redirección sin tracking al rechazarla y aviso técnico en `privacidad.html`. Requiere validación legal antes de producción.
- [x] Añadir páginas de campaña específicas.
  - Completado: rutas dinámicas `/campana/:codigo` para las campañas activas; los UTM (`utm_source`, `utm_medium`, `utm_campaign`) se conservan en el tracking interno sin modificar el destino afiliado.
- [ ] **No realizable actualmente:** incorporar newsletter. Motivo: falta proveedor, configuración de doble opt-in y política de datos aprobada.
- [x] Implementar rate limiting para inicio de sesión, eventos y redirecciones afiliadas.
- [x] Añadir cabeceras de seguridad, cookie `Secure` en producción y gestión de secretos con variables de entorno.
  - Completado: CSP, anti-clickjacking, restricciones de permisos, límite de tamaño y `.env.example`; las cookies se vuelven `Secure` con `NODE_ENV=production`.
- [x] Añadir copias de seguridad verificadas del almacenamiento y un procedimiento de restauración.
  - Completado: `npm run backup` crea JSON con checksum SHA-256 y `Operaciones_Locales.md` explica la restauración.
- [x] Añadir pruebas automatizadas de API, redirección, validación de enlaces y permisos de administrador.
  - Completado: `npm test` cubre API pública, permisos, validación SSRF, carga de imágenes, SEO, rate limiting y redirecciones válidas e inválidas; restaura los datos locales tras ejecutarse.

## Criterios para publicar

- [ ] **No realizable actualmente:** cambiar la contraseña inicial y retirar credenciales de demostración. Motivo: requiere la cuenta y contraseña definitiva del titular.
- [ ] **No realizable actualmente:** revisar reglas y términos de los programas. Motivo: faltan los acuerdos, paneles o enlaces oficiales de cada programa.
- [ ] **No realizable actualmente:** configurar observabilidad, dominio, HTTPS y cuenta administradora real. Motivo: falta infraestructura, acceso al proveedor y datos del responsable.
- [x] Realizar una revisión de accesibilidad móvil y de navegación por teclado.
  - Completado: foco visible, modales con semántica de diálogo, foco inicial y cierre con Escape; layouts responsive validados por las reglas CSS.

## Dependencias que requieren decisión o acceso externo

Estas tareas permanecen sin marcar deliberadamente. No deben simularse con datos, credenciales o textos legales ficticios.

| Pendiente | Información o autorización necesaria |
| --- | --- |
| Comparativas editoriales | Productos alternativos reales por categoría y criterio editorial de comparación. |
| Dominio, HTTPS y observabilidad | Dominio elegido, acceso al proveedor DNS/hosting y herramienta de monitoreo. |
| Core Web Vitals | URL pública desplegada para mediciones de laboratorio y de campo. |
| Feeds, APIs y postbacks | Credenciales oficiales y términos autorizados de cada red de afiliación. |
| Privacidad, consentimiento y newsletter | Jurisdicción aplicable, texto legal aprobado y proveedor de correo con doble opt-in. |
| Páginas de campaña | Objetivo, audiencia, oferta, mensaje y canales autorizados por campaña. |
| Cuenta administradora y contraseña final | Correo del responsable y contraseña inicial elegida por el titular. |
