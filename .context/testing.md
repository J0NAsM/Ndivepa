# Testing — Ndivepa

[Comandos declarados](ejecucion.md). La presencia de pruebas no acredita una ejecución reciente.

Usar DB/archivos temporales por prueba o una copia aislada; comprobar que los datos locales existentes no se modifiquen.

## Suites localizadas
- [test/framework.test.js](<../test/framework.test.js>)
- [test/hardening.test.js](<../test/hardening.test.js>)
- [test/http.test.js](<../test/http.test.js>)
- [test/marketplace.test.js](<../test/marketplace.test.js>) — marketplace de extremo a extremo (v4, 24 pruebas): alta de tienda, compra multivendedor, subpedidos, entrega, reseña verificada, comisión, dropshipping, afiliados, publicidad, envío por tienda, devoluciones con reverso contable, caché con ETag, sinónimos de búsqueda editables, exportaciones CSV, entrega estimada en ficha y carrito, rescate y recordatorio de carrito abandonado, avisos de reposición, vista previa social y catálogo para Facebook, diagnóstico de publicaciones y controles de seguridad. Usa su propio `DATA_DIR` temporal y `AFFILIATE_POSTBACK_SECRET` de prueba.

- [scripts/test-ui.mjs](<../scripts/test-ui.mjs>) — `npm run test:ui`: 8 recorridos de interfaz con Edge/Chrome sin cabeza por CDP (portada, búsqueda con errores de tipeo, agregar al carrito, carrito agrupado por tienda, checkout con entrega por tienda, coste y plazo en la ficha, página de tienda y funcionamiento sin conexión). Arranca su propio servidor con `DATA_DIR` temporal y un perfil de navegador temporal; si no hay navegador disponible se omite sin fallar.

Registrar comando, fecha, revisión y resultado real; consultar proyecto.json y el informe del cambio.
