# Índice de contexto de Ndivepa

Actualizado: 2026-09-04

Esta carpeta es la memoria técnica y operativa del proyecto. Para evitar que una
conversación sea la única fuente de una decisión, todo cambio relevante debe quedar
registrado aquí junto con su evidencia y sus límites.

## Estado resumido

- Arquitectura modular con 24 módulos registrados.
- Auditoría integral con 112 mejoras implementadas y enumeradas.
- Opción administrativa **Descubrimiento** integrada para consultar Google Trends
  por país y preparar productos afiliados con revisión humana.
- Importación permitida únicamente con comercio, red y programa activos, afiliación
  aprobada, credenciales verificadas y tracking válido.
- Verificación local más reciente: 85 archivos analizados, 78/78 pruebas correctas,
  integridad sin incidencias y 0 vulnerabilidades altas o críticas de producción.
- No existen credenciales afiliadas reales ni productos reales importados por esta
  revisión; los identificadores de demostración no generan comisiones.
- Docker no está instalado en el equipo usado para esta revisión. La construcción
  real de la imagen queda cubierta por el trabajo de CI.
- El árbol de trabajo contiene cambios sin confirmar en Git. Deben revisarse y
  guardarse en un commit antes de desplegar.

## Mapa de documentos

| Documento | Fuente de verdad para |
| --- | --- |
| [Contexto_General.md](Contexto_General.md) | Propósito, modelo afiliado, principios y límites del producto. |
| [Estado_Implementacion.md](Estado_Implementacion.md) | Capacidades que existen actualmente y evidencia de ejecución. |
| [Registro_De_Cambios.md](Registro_De_Cambios.md) | Cambios realizados, decisiones, pruebas y trabajo externo pendiente. |
| [Descubrimiento_Afiliado.md](Descubrimiento_Afiliado.md) | Uso y configuración de la función de descubrimiento. |
| [Auditoria_112_Mejoras.md](Auditoria_112_Mejoras.md) | Inventario cerrado de las 112 mejoras de endurecimiento. |
| [Arquitectura.md](Arquitectura.md) | Diseño modular, flujos e invariantes técnicos. |
| [Operaciones_Locales.md](Operaciones_Locales.md) | Inicio, mantenimiento, importación, reportes, copias y operación local. |
| [Tareas_A_Realizar.md](Tareas_A_Realizar.md) | Checklist operativo corto y dependencias externas. |
| [Plan_Maestro.md](Plan_Maestro.md) | Orden histórico de evolución hacia la plataforma modular. |
| [Paridad_Medusa_Vendure.md](Paridad_Medusa_Vendure.md) | Comparación funcional del modelo modular. |
| [Backlog_Mejoras.md](Backlog_Mejoras.md) | Catálogo histórico M-0001…M-1040; no sustituye al estado verificado. |

## Orden recomendado de lectura

1. `Contexto_General.md` para entender qué hace y qué no hace Ndivepa.
2. `Estado_Implementacion.md` para conocer el estado ejecutable actual.
3. `Registro_De_Cambios.md` para revisar la última intervención.
4. La guía específica del área que se vaya a operar.

Cuando un checklist histórico contradiga la ejecución comprobada, prevalecen
`Estado_Implementacion.md`, el registro más reciente y las pruebas automatizadas.
