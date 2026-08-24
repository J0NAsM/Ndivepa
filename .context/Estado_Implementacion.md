# Estado de implementación local

Actualizado: 2026-08-24

## Capacidades incorporadas

- Fidelización: programas, cuentas, libro mayor, reservas de puntos, canje y acumulación por pedido.
- Crédito de tienda: saldo monetario por cliente, movimientos auditables y ajustes administrativos.
- B2B: organizaciones, miembros, roles, órdenes de compra y aprobación previa al checkout.
- Suscripciones: contratos, periodos, prueba gratuita, pausa, reanudación, cancelación y renovaciones idempotentes.
- API: GraphQL de tienda (`/api/graphql`) y GraphQL administrativo protegido (`/api/v1/admin/graphql`).
- Operación: `GET /healthz`, métricas Prometheus en `GET /metrics`, diagnóstico y estado seguro de integraciones en `GET /api/v1/admin/integrations`.
- Seguridad: sesiones opacas de cliente, CSRF, validación HTTP estricta y corrección de reparto entre varias tarjetas regalo.

## Verificación

- `npm run verify`: integridad referencial, invariantes y conformidad de módulos sin incidencias.
- `node --test test/http.test.js`: 20 pruebas correctas.
- Repositorio sincronizado con `origin/main`.

## Excepción acordada: conectores externos

No se activan pagos, SMTP, S3/CDN, búsqueda externa ni conectores empresariales sin credenciales oficiales. El código y `.env.example` están preparados para que solo sea necesario completar las variables del proveedor elegido. La API administrativa indica si cada integración está configurada, sin mostrar secretos.
