# Ndivepa: contexto general

## Propósito

Ndivepa es una plataforma de inteligencia de afiliación. Presenta ofertas de terceros, registra el interés y redirige al comercio o plataforma afiliada. No procesa el pago del cliente, no gestiona envíos y no debe presentar el valor de ventas atribuidas como ingreso propio.

Flujo principal:

```text
Visitante → Ndivepa → producto/oferta → enlace afiliado → comercio externo
          → evento de vista                 ↓
                                          clic interno (CLK-...)
                                                   ↓
                              conversión / comisión importada o recibida
```

## Principios de negocio

- `AFFILIATE` es el modo de monetización activo.
- El comercio externo confirma la compra y decide la validez de la comisión.
- Una comisión `pending` no es ganancia definitiva.
- Ventas atribuidas, comisión pendiente, aprobada y pagada son métricas distintas.
- Un enlace jamás se modifica para añadir UTMs, SubIDs o redirecciones sin reglas explícitas del programa.
- Toda oferta muestra una divulgación de afiliado.

## Dominios actuales

| Dominio | Finalidad |
| --- | --- |
| Categorías | Clasifica productos afiliados. |
| Comercios | Define el vendedor y sus dominios autorizados. |
| Redes | Define reglas de tracking permitidas por proveedor. |
| Programas | Relaciona comercio, red, cuenta, tracking ID y comisión estimada. |
| Productos afiliados | Información editorial, precio, tipo, comercio y programa. |
| Enlaces afiliados | URL normal, URL de afiliado, validación y salud. |
| Campañas / placements | Contexto de promoción y atribución permitida. |
| Eventos | Vistas, clics, búsquedas y sesiones. |
| Conversiones | Ventas, leads, reservas o suscripciones reportadas. |
| Comisiones / pagos | Estado financiero separado de la conversión. |
| Alertas / auditoría | Excepciones operativas y cambios administrativos. |

## Seguridad actual

- Administración con sesión HttpOnly y rol administrador.
- Contraseña inicial local: cambiar desde Seguridad antes de publicar.
- La validación local bloquea protocolos inseguros, `localhost`, IPs directas, hosts `.local`, `.internal` e IPv6 directas.
- La comprobación de enlaces no hace solicitudes externas: evita SSRF y scraping no autorizado.
- Los clics se redirigen sin alterar la URL proporcionada por la red de afiliación.

## Métricas disponibles

- Sesiones, usuarios activos locales, vistas y clics afiliados.
- CTR = clics / vistas.
- Conversión = conversiones / clics.
- EPC = comisión / clics.
- Comisión pendiente, aprobada y pagada.
- Embudo y rendimiento por producto / fuente de tráfico.

## Límites deliberados de la versión local

Ndivepa no posee todavía credenciales de redes externas, por lo que no consulta APIs, feeds, precios, postbacks ni GA4. Las integraciones deben conectarse mediante variables de entorno, nunca guardando claves dentro de productos o documentos. El almacenamiento local es JSON; PostgreSQL y despliegue productivo son el siguiente paso cuando exista infraestructura.
