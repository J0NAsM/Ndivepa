# Despliegue — Ndivepa

Dependencias: Node; fuentes y redes de afiliación externas.

Git y disponibilidad de herramientas son observaciones fechadas, no reglas permanentes. Respaldar datos JSON.

## Artefactos de configuración encontrados
- [docker-compose.yml](<../docker-compose.yml>)
- [Dockerfile](<../Dockerfile>)
- [.github/workflows/quality.yml](<../.github/workflows/quality.yml>)

Esto no acredita despliegue efectivo. Host, dominio administrado, certificado, versión desplegada y rollback probado: NO DETERMINADO. Antes de producción comprobar build, datos persistentes, variables privadas, health checks y restauración. No cambiar identidad de volúmenes o redes sin inventariar los existentes.
