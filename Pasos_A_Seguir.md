# Pasos a seguir para completar Ndivepa

Esta guía indica qué debes preparar tú para conectar las redes externas. No envíes contraseñas, claves privadas ni tokens por chat ni los pegues dentro de productos, CSV o el repositorio. Guárdalos en un gestor de secretos o variables de entorno del servidor.

## 1. Preparar tu sitio antes de solicitar programas

1. Inicia Ndivepa y cambia la contraseña inicial en **Seguridad**.
2. Publica una página de privacidad, términos, contacto y divulgación de afiliados.
3. Añade contenido editorial original: reseñas, comparativas, criterios de recomendación y fechas de actualización.
4. Anota el dominio exacto y los perfiles sociales desde los que promocionarás. Cada red suele exigir que esos sitios estén declarados y aprobados.
5. En cada producto usa un precio solo si procede de una fuente autorizada y tiene fecha de actualización; en caso contrario muestra “Consultar precio”.

## 2. Cómo entregarme información de un programa

Para cada programa completa esta ficha. Puedes copiarla en un archivo privado y compartir solo los campos no secretos en esta conversación:

```text
Red / programa:
Comercio:
País o marketplace:
URL del panel de afiliado:
Estado: activo / pendiente / suspendido
ID de afiliado o Tracking ID:
Formato de enlace de ejemplo (sin claves secretas):
Dominio(s) permitido(s):
¿Permite SubID?: sí / no / no confirmado
¿Permite UTM?: sí / no / no confirmado
¿Permite redirección propia?: sí / no / no confirmado
¿Tiene API?: sí / no / no confirmado
¿Tiene webhook/postback?: sí / no / no confirmado
Enlace a la documentación oficial:
```

Cuando haya claves, indícame únicamente el **nombre de la variable** que crearás, por ejemplo `PARTNERSTACK_API_KEY`; no el valor. Luego se configura en el servidor donde se desplegará Ndivepa.

## 3. Amazon Associates

1. Regístrate en el portal del marketplace que usarás. Amazon requiere una URL de sitio incluso para pruebas y entrega un **Associate Tag** para ese marketplace. Las cuentas son específicas por marketplace. [Guía oficial de alta y Creators API](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/onboarding/sign-up-as-an-amazon-associate)
2. Declara tu web y redes sociales reales durante la solicitud. Amazon revisa la solicitud tras ventas calificadas; su ayuda actual menciona tres ventas en los primeros 180 días y contenido original público. [Proceso de revisión oficial](https://affiliate-program.amazon.com/help/node/topic/G8TW5AE9XL2VX9VM?os=av)
3. Genera el enlace desde Associates Central y pega en Ndivepa la **URL completa generada por Amazon**. El tag debe estar incluido como parámetro, por ejemplo `tag=tu-tag-20`; no lo añadas manualmente si Amazon te proporciona un enlace oficial distinto. [Políticas sobre Special Links](https://affiliate-program.amazon.com/help/operating/policies?ac-ms-src=ac-nav)
4. En Ndivepa crea:
   - Comercio: Amazon y los dominios del marketplace concreto.
   - Red: Amazon Associates, sin redirección propia ni parámetros no autorizados.
   - Programa: tu Associate Tag.
   - Producto: URL normal y URL de afiliado original.
5. Para sincronización autorizada de catálogo, solicita acceso a Creators API después de ser Associate. Amazon indica que la API requiere una clave pública/privada y el Associate Tag. Nunca compartas la clave privada en el chat.

## 4. Hotmart

1. Crea o inicia sesión en tu cuenta de negocio en `app.hotmart.com`.
2. Ve a **Products → Affiliate to a product**, encuentra la oferta y solicita afiliación si requiere aprobación. Solo promuevas cuando la afiliación esté activa. [Proceso oficial para afiliados](https://help.hotmart.com/en/article/215829028/how-do-i-become-an-affiliate-of-a-product-on-hotmart-)
3. Una vez aprobada, abre el producto en **I'm an affiliate** y copia el HotLink desde los enlaces promocionales. Hotmart explica que esos enlaces identifican la promoción y atribuyen la comisión. [Hotlinks oficiales](https://help.hotmart.com/en/article/215829088/what-are-promotional-links-and-how-to-share-them-)
4. Pega el HotLink íntegro como URL de afiliado; no agregues parámetros sin confirmar que el programa los permita.
5. Envíame la ficha del programa, un HotLink de ejemplo y la documentación de reporte/API/webhooks disponible para tu cuenta. La automatización se hará solo con el mecanismo aprobado por Hotmart.

## 5. PartnerStack

1. Acepta la relación con el partner desde el panel de PartnerStack y obtén los enlaces asignados a esa relación.
2. Para API, en PartnerStack ve a **Settings → API** y crea/revela la API key. La documentación actual usa autenticación `Bearer` contra su Partner REST API. [Autenticación oficial](https://docs.partnerstack.com/reference/partner-api-authentication)
3. Crea la variable privada `PARTNERSTACK_API_KEY` en el servidor; no incluyas la clave en un mensaje ni en un archivo Markdown.
4. Envíame: dominio de API, documentación oficial aplicable, ID de partnership, ejemplo de enlace y si tu instancia tiene habilitado tracking S2S. PartnerStack aclara que S2S debe habilitarse con soporte o tu especialista de integración. [Tracking S2S oficial](https://docs.partnerstack.com/docs/server-to-server-s2s-tracking)

## 6. Impact y otras redes

1. Solicita acceso como partner/affiliate directamente ante cada anunciante o desde tu cuenta Impact.
2. Pide a tu contact manager o soporte: acceso de reportes/API, documentación de conversiones, método de postback/webhook, secreto de firma y reglas de SubIDs.
3. Entrega la ficha del paso 2 con la URL de la documentación oficial. Sin documentación y autorización explícita, Ndivepa no alterará enlaces ni intentará consultar datos.
4. Para cualquier red nueva, empieza con importación CSV: descarga el informe desde la red, conserva el original y usa el formato de `examples/conversiones-ejemplo.csv`.

## 7. Importar conversiones sin API

1. Inicia Ndivepa al menos una vez.
2. Descarga un CSV de conversiones desde la red.
3. Ajusta los encabezados a:

```text
network_conversion_id,click_id,product_id,type,sale_amount,sale_currency,commission,commission_currency,status,date
```

4. Ejecuta:

```powershell
cd <carpeta-del-repositorio>
npm run import-conversions -- .\tu-reporte.csv
```

5. Revisa Conversiones y Comisiones. Los duplicados por `network_conversion_id` se omiten para evitar doble contabilización.

## 7.1 Importar productos en masa

1. Descarga [el modelo de productos](examples/productos-ejemplo.csv) o cópialo a un archivo propio.
2. Completa `merchant_id` y `program_id` con los IDs que ya existan en Ndivepa.
3. Usa solamente URLs de afiliado entregadas por la red.
4. Ejecuta:

```powershell
npm run import-products -- .\productos.csv
```

5. Revisa la validación de cada enlace antes de cambiar su estado a publicado.

## 8. Activar mantenimiento local

Ejecuta semanalmente:

```powershell
npm run maintenance
```

Este proceso crea alertas para enlaces con advertencias, programas inactivos, precios antiguos y productos publicados sin clics. No hace scraping ni peticiones a comercios externos.

## 9. Para desplegar y activar webhooks

Necesitarás elegir: dominio, proveedor de hosting, base de datos PostgreSQL, sistema de correo y gestor de secretos. Una vez elegido, proporciona:

```text
Dominio público:
Proveedor de hosting:
Proveedor de PostgreSQL:
Proveedor de correo/alertas:
Redes que deben conectar primero:
```

Con una URL HTTPS pública se podrán registrar endpoints de webhook/postback con cada red. Primero se verificará la firma de cada proveedor y se probará con eventos de prueba; no se deben aceptar webhooks sin firma ni importar pagos automáticamente sin conciliación.

## 10. Verificación local antes de conectar servicios

La auditoría técnica y el inventario de 112 mejoras implementadas están en
[`.context/Auditoria_112_Mejoras.md`](.context/Auditoria_112_Mejoras.md). Antes de
desplegar o cargar credenciales, ejecuta:

```powershell
npm run check:full
npm run doctor
```

No continúes con integraciones externas si alguna comprobación termina con un
código distinto de cero.

## 11. Activar el descubrimiento de oportunidades

Ndivepa ya incluye **Panel → Descubrimiento** para consultar tendencias de Google
por país y preparar productos afiliados. Antes de poder importar, cada programa
debe estar aprobado por la red, tener su tracking real verificado y estar marcado
como habilitado para descubrimiento.

La guía completa, las variables de entorno y los límites de esta automatización
están en [`.context/Descubrimiento_Afiliado.md`](.context/Descubrimiento_Afiliado.md).

El sistema no puede crear por sí solo una cuenta afiliada ni un identificador que
genere comisiones: esos datos los entrega cada comercio después de aprobar tu
solicitud. Una vez configurados, Ndivepa valida y agrega la oportunidad desde una
sola pantalla.
