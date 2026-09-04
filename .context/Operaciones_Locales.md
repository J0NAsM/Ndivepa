# Operaciones locales

## Iniciar

```powershell
cd <carpeta-del-repositorio>
npm run dev
```

También se puede abrir `iniciar-ndivepa.cmd`. La aplicación queda en `http://localhost:4300`.

## Datos de demostración

Los datos se almacenan en `data/db.json`, que se crea en el primer arranque. Para volver a los datos iniciales:

```powershell
npm run reset-data
```

## Mantenimiento interno

Ejecuta una revisión local de enlaces, precios, programas y productos sin clics:

```powershell
npm run maintenance
```

El script no visita sitios externos, no modifica enlaces y crea alertas auditables en el almacenamiento local. Para una revisión programada, usa el Programador de tareas de Windows con ese mismo comando.

Para registrar la tarea diaria local a las 03:00 (puedes cambiar la hora), ejecuta PowerShell como el usuario que operará Ndivepa:

```powershell
.\scripts\register-maintenance-task.ps1 -At 03:00
```

Los umbrales se configuran mediante `LINK_STALE_DAYS` y `PRICE_STALE_DAYS`; consulta `.env.example`.

## Importar conversiones

1. Descarga el informe CSV desde la red de afiliación.
2. Conserva una copia original fuera del repositorio.
3. Mapea las columnas según `examples/conversiones-ejemplo.csv`.
4. Ejecuta:

```powershell
npm run import-conversions -- .\ruta\al\reporte.csv
```

El importador rechaza IDs de conversión repetidos y marca los registros como `source: import_csv`. Revisa los resultados en Conversiones y Comisiones.

## Importar productos en masa

1. Copia `examples/productos-ejemplo.csv` y completa una fila por producto.
2. Usa IDs que ya existan en Comercios y Programas.
3. Ejecuta:

```powershell
npm run import-products -- .\ruta\productos.csv
```

Los productos importados se marcan para revisión de enlace: valida cada enlace desde el panel antes de publicarlo.

## Exportar reportes

```powershell
npm run export-report
```

Genera `exports/rendimiento-productos.csv`, `exports/conversiones.csv` y `exports/comisiones.csv`.

## Copia de seguridad y restauración

Antes de importar datos, actualizar el servidor o publicar cambios, crea una copia verificable:

```powershell
npm run backup
```

Se guardan un JSON y su checksum SHA-256 en `backups/`. Para restaurar, detén Ndivepa, conserva una copia del `data/db.json` actual y reemplázalo por el JSON de respaldo que corresponda. Verifica primero el checksum con `Get-FileHash` y reinicia la aplicación.

La carpeta `backups/` es local y está excluida de Git para no publicar datos,
sesiones ni hashes de usuarios. Antes de restaurar, puedes verificar ambos archivos
con el propio proyecto:

```powershell
npm run verify-backup -- .\backups\db-AAAA-MM-DDTHH-MM-SS-000Z.json
```

## Ejecutar con Docker

Con Docker Desktop instalado:

```powershell
docker compose up --build
```

Los datos y reportes quedan en volúmenes Docker separados del contenedor.
