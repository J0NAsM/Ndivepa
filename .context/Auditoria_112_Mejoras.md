# Auditoría integral y 112 mejoras implementadas

Actualizado: 2026-09-04

Esta revisión cubre configuración, servidor HTTP, persistencia, validación,
autenticación, afiliación, archivos, importación/exportación, interfaz,
accesibilidad y operación. Las mejoras siguientes están implementadas; los
servicios que necesitan cuentas o decisiones externas se enumeran aparte.

## Configuración y ciclo de vida

1. Las variables numéricas mal escritas detienen el arranque en vez de usar un valor silencioso.
2. Los booleanos de entorno solo aceptan representaciones explícitas y conocidas.
3. `NODE_ENV` se restringe a entornos soportados.
4. `COMMERCE_MODE` se valida y ya no degrada silenciosamente a otro modo.
5. `PUBLIC_BASE_URL` exige HTTP(S), sin credenciales, consulta ni fragmento.
6. Producción exige una URL pública HTTPS.
7. Los locales se validan, normalizan y no admiten duplicados.
8. El locale predeterminado debe estar entre los locales soportados.
9. La zona horaria debe ser un identificador IANA utilizable.
10. Nombres y prefijos de cookies se validan antes de arrancar.
11. La caducidad absoluta de sesión no puede ser menor que la deslizante.
12. Los parámetros de `scrypt` tienen límites seguros y el coste debe ser potencia de dos.
13. Los límites de cuerpo, URL, query y profundidad JSON se validan centralmente.
14. El servidor aplica tiempos máximos de petición, cabeceras, keep-alive y apagado.
15. El servidor enlaza el `HOST` configurado y propaga errores de `listen`.
16. El apagado cierra conexiones ociosas, espera operaciones y fuerza el cierre tras la gracia configurada.

## Protocolo HTTP y contenido estático

17. La URL se analiza con una base fija; la cabecera `Host` no controla el parser interno.
18. Se rechazan URLs que superan el máximo configurado.
19. `Content-Length` se valida como entero seguro y no negativo.
20. Se rechaza `Content-Encoding` no soportado en cuerpos JSON.
21. Se admiten correctamente `application/json` y los tipos `+json`.
22. Un cuerpo JSON de negocio debe ser un objeto, no un escalar ni un array.
23. La profundidad JSON se limita contra agotamiento de pila y cargas patológicas.
24. La query tiene un máximo de parámetros y preserva duplicados como arrays.
25. Las cookies se decodifican de forma segura y la primera repetida prevalece.
26. La declaración de rutas valida métodos, parámetros, comodines y formato.
27. El router detecta rutas duplicadas al registrar y al fusionar módulos.
28. Un parámetro con percent-encoding roto devuelve 400, no 500.
29. Separadores y bytes nulos codificados no pueden atravesar segmentos de ruta.
30. `OPTIONS` distingue ruta inexistente de método no permitido.
31. `HEAD` conserva estado, cabeceras y longitud de la respuesta `GET`, sin cuerpo.
32. JSON, texto, HTML y XML calculan `Content-Length` en bytes UTF-8.
33. Los valores de cookie se codifican y sus nombres y atributos se validan.
34. El borrado de cookie incluye tanto `Max-Age=0` como una fecha expirada.
35. Se añadieron `Origin-Agent-Cluster` y control de prefetch DNS.
36. CSP solo solicita subir recursos inseguros cuando la aplicación está en producción.
37. CORS acumula `Vary: Origin` y nunca combina credenciales con origen comodín.
38. Los estáticos bloquean dotfiles, salvo el espacio intencional `.well-known`.
39. `realpath` impide escapar del directorio público mediante enlaces simbólicos.
40. `If-None-Match` tiene precedencia correcta sobre `If-Modified-Since`.
41. ETags múltiples y fechas HTTP se interpretan con semántica de caché correcta.
42. Rangos malformados o múltiples devuelven 416 y no cargan el archivo completo.
43. `If-Range` decide correctamente entre respuesta parcial y completa.
44. Las respuestas `HEAD` de estáticos reciben las mismas reglas de caché.

## Persistencia, repositorios y validación

45. Cada instancia usa un temporal de persistencia único por proceso y UUID.
46. El temporal se crea en modo exclusivo para evitar pisadas concurrentes.
47. Un fallo al renombrar limpia su temporal sin ocultar el error original.
48. Las migraciones declaradas deben avanzar exactamente una versión.
49. Se detectan migraciones duplicadas y huecos en la cadena.
50. Un documento con versión futura se rechaza en vez de reinterpretarse.
51. Las migraciones asíncronas se esperan antes de persistir.
52. Un fallo de migración restaura también el estado en memoria.
53. Un documento corrupto sin snapshot válido detiene el arranque; nunca crea datos vacíos en silencio.
54. El archivo corrupto se conserva para diagnóstico y la recuperación verifica el objeto raíz.
55. El checksum de snapshot no filtra rutas absolutas del equipo.
56. Restaurar un borrado lógico comprueba de nuevo las restricciones de unicidad.
57. Restaurar un registro activo produce conflicto explícito.
58. Un cursor de paginación inexistente ya no repite la primera página.
59. Filtros y proyecciones bloquean `__proto__`, `prototype` y `constructor`.
60. Orden, selección, filtros y expansiones se restringen a campos declarados.
61. Un `PATCH` vacío se rechaza como error de validación.
62. La coerción de enteros no acepta prefijos parciales como `12px` o `1.9`.
63. Las fechas ISO se validan también contra el calendario real.
64. Monedas y países se normalizan antes de validar su formato.
65. Los valores predeterminados mutables se clonan y no se comparten entre peticiones.
66. Las listas pueden imponer unicidad y las expresiones regulares reinician su estado.

## Autenticación, afiliación y archivos

67. TOTP usa secretos Base32 compatibles con RFC-6238 y un mínimo de 128 bits.
68. La verificación TOTP exige exactamente seis dígitos y una ventana temporal acotada.
69. Los códigos de recuperación 2FA se almacenan como hashes de un solo uso.
70. El login ejecuta un hash ficticio si el usuario no existe para reducir enumeración temporal.
71. Solo usuarios activos pueden iniciar sesión.
72. El coste de contraseña queda versionado por usuario para permitir endurecimiento gradual.
73. La renovación deslizante nunca supera la caducidad absoluta.
74. Las sesiones vencidas no aparecen en el listado administrativo.
75. Las cookies administrativas usan `SameSite=Strict` y cerrar sesión exige CSRF.
76. Un enlace con comercio inexistente, inactivo o dominio ajeno queda inválido.
77. El programa debe existir, estar activo y pertenecer al mismo comercio.
78. Credenciales embebidas, puertos atípicos y tracking requerido duplicado se detectan.
79. La URL normal del producto también se valida contra protocolo y dominio del comercio.
80. Solo productos publicados y enlaces válidos pueden registrar vistas o redirigir clics.
81. IDs de visitante y tracking se saneían antes de persistir.
82. La analítica requiere consentimiento explícito; omitirlo ya no equivale a aceptar.
83. El proveedor local impide que un nombre de archivo escape de su directorio.
84. Las cargas validan Base64 canónico y tamaño codificado antes de reservar memoria.
85. La aplicación solo admite PNG, JPEG y WebP reales para imágenes.
86. Dimensiones y píxeles máximos frenan bombas de descompresión de imagen.
87. Estrategias de nombres desconocidas se rechazan y un archivo inválido se limpia.

## Datos masivos, experiencia y operación

88. El parser CSV admite BOM, CRLF, comillas, comas y saltos dentro de una celda.
89. Importadores limitan bytes, filas y columnas para evitar consumo ilimitado.
90. Se rechazan encabezados duplicados y filas con columnas extra.
91. Los duplicados de conversión se detectan también en `--dry-run`.
92. La auditoría de importación guarda el nombre base, no la ruta local completa.
93. La exportación neutraliza fórmulas de hoja de cálculo sin alterar números negativos.
94. Los informes salen con BOM/CRLF y sustitución atómica del archivo final.
95. La interfaz tolera `localStorage` bloqueado o favoritos corruptos y limita su crecimiento.
96. El cliente HTTP tiene timeout, mensajes de red claros y lectura segura por tipo de contenido.
97. Editar un producto envía el objeto `price` correcto y sincroniza comercio/programa del enlace.
98. Las categorías públicas se derivan del catálogo aunque el visitante sea anónimo.
99. Las imágenes externas arbitrarias no se insertan; solo se muestran uploads internos permitidos.
100. Las vistas se registran al alcanzar visibilidad real, una vez por sesión y con consentimiento.
101. Mensajes de validación y textos de negocio se escapan antes de insertarlos en HTML.
102. Enlaces externos usan `noopener`, `noreferrer`, `nofollow` y `sponsored`.
103. Los modales tienen nombre accesible, foco inicial, trampa de Tab, Escape y restauración de foco.
104. Los formularios bloquean dobles envíos y vuelven a habilitarse si la operación falla.
105. Resolver una alerta usa la ruta administrativa v1 real.
106. La preferencia de privacidad puede reabrirse y la documentación describe el comportamiento real.
107. Se añadieron salto al contenido, foco visible, etiquetas asociadas, `scope` y estados ARIA.
108. La interfaz respeta movimiento reducido, colores forzados y controles deshabilitados.
109. Se añadieron manifest, favicon, metadatos sociales, referrer policy, estado de carga y `noscript`.
110. Las guías dejaron de depender de IDs de productos de demostración.
111. La suite subió de 41 a 73 pruebas e incluye regresiones de hardening.
112. CI valida Node 20/24, imagen Docker, sonda de vida y vulnerabilidades altas de producción.

## Evidencia de verificación

- `npm run lint`: 84 archivos, sin incidencias.
- `npm test`: 78/78 pruebas superadas.
- `npm run verify`: comprueba integridad referencial, invariantes y conformidad.
- `npm run audit:dependencies`: bloquea vulnerabilidades altas o críticas en dependencias de producción.

Las regresiones nuevas viven en `test/hardening.test.js`; los flujos HTTP de
extremo a extremo siguen en `test/http.test.js` y las pruebas de persistencia y
framework en `test/framework.test.js`.

## Fuera del alcance automático

Siguen requiriendo decisiones o credenciales del propietario: dominio y hosting,
PostgreSQL gestionado, correo transaccional, secretos de Amazon/Impact/Hotmart/
PartnerStack, firmas reales de webhooks y revisión legal del aviso de privacidad.
No se inventaron credenciales ni se activaron conexiones externas sin autorización.
