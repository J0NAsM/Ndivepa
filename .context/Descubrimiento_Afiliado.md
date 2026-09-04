# Descubrimiento de productos afiliados

Actualizado: 2026-09-04

Ndivepa puede consultar el RSS oficial de Google Trends, mostrar oportunidades
por país y convertir una tendencia revisada en un producto con su enlace afiliado.
La función está en **Panel administrativo → Descubrimiento**.

## Qué automatiza

- Consulta `https://trends.google.com/trending/rss` para el país elegido.
- Limita la respuesta, aplica timeout y usa caché local durante diez minutos.
- Muestra volumen aproximado, fecha y contexto periodístico de cada consulta.
- Señala posibles consultas con intención de producto sin ocultar las generales.
- Comprueba que el programa, comercio y red estén activos.
- Exige afiliación aprobada, credenciales verificadas, tracking ID y parámetro de tracking.
- Valida dominio, URL normal, URL afiliada y tracking antes de guardar.
- Crea juntos el producto y su enlace; opcionalmente publica después de validar.
- Conserva en los metadatos la consulta, país, volumen y fecha de la tendencia.

## Configurar un programa

1. Solicita y recibe la aprobación del programa en el sitio oficial del comercio o red.
2. Copia desde ese panel tu ID de afiliado, tracking ID y nombre exacto del parámetro.
3. En Ndivepa abre **Programas**, crea o edita el programa.
4. Selecciona **Aprobada**, indica cuándo verificaste las credenciales y cambia Descubrimiento a **Habilitado**.
5. Guarda una URL afiliada de prueba y confirma que la red muestra tu identificador.

Un programa incompleto aparece en la pantalla de descubrimiento con las razones
por las que está bloqueado. Los programas de demostración no vienen aprobados ni
habilitados.

## Agregar una oportunidad

1. Abre **Descubrimiento**.
2. Indica el país ISO, por ejemplo `PY`, y pulsa **Buscar tendencias ahora**.
3. Revisa si la consulta representa realmente un producto disponible en uno de tus programas.
4. Pulsa **Preparar producto**.
5. Completa una descripción editorial propia, la URL normal del producto y la URL afiliada exacta emitida por la red.
6. Guarda como borrador o solicita publicación. Si el tracking no coincide, Ndivepa rechaza la operación.

## Límites intencionales

Google Trends muestra consultas que crecen frente a su nivel habitual; no es un
ranking de productos más vendidos ni garantiza intención de compra. Ndivepa no se
registra automáticamente en programas, no inventa IDs, no modifica enlaces y no
afirma que una comisión exista hasta recibir la conversión de la red.

La API completa de Trends continúa siendo de acceso alfa limitado. Por eso esta
implementación utiliza el mecanismo RSS documentado por Google:

- https://support.google.com/trends/answer/3076011?hl=es
- https://developers.google.com/search/apis/trends

## Configuración

```dotenv
FEATURE_TREND_DISCOVERY=true
GOOGLE_TRENDS_GEO=PY
DISCOVERY_TIMEOUT_MS=10000
DISCOVERY_CACHE_TTL_MS=600000
```

Desactiva `FEATURE_TREND_DISCOVERY` si la instalación no debe realizar esta
consulta saliente.
