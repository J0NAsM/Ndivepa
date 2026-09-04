$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$port = 4300
$origin = "http://localhost:$port"
$logFile = Join-Path $PSScriptRoot 'arranque.log'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js no está instalado. Instala Node.js 20 o superior y vuelve a ejecutar este archivo.' -ForegroundColor Red
  Read-Host 'Pulsa Enter para cerrar'
  exit 1
}

$major = [int](( & node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" ))
if ($major -lt 20) {
  Write-Host "Ndivepa necesita Node.js 20 o superior. Tienes la versión $major." -ForegroundColor Red
  Read-Host 'Pulsa Enter para cerrar'
  exit 1
}

# Sin dependencias instaladas, `node server.js` fallaba al importar `graphql` y el
# mensaje que veía la persona era solo «no pudo iniciar». Se instalan aquí.
if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules'))) {
  Write-Host 'Instalando dependencias por primera vez. Puede tardar un minuto...' -ForegroundColor Cyan
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'No se pudieron instalar las dependencias. Revisa tu conexión y vuelve a intentarlo.' -ForegroundColor Red
    Read-Host 'Pulsa Enter para cerrar'
    exit 1
  }
}

$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  Start-Process $origin
  Write-Host "Ndivepa ya estaba iniciado. Se abrió $origin" -ForegroundColor Green
  exit 0
}

# La salida del servidor se guarda en un fichero: si el arranque falla, el motivo
# real queda a la vista en vez de perderse en una ventana oculta.
$server = Start-Process -FilePath node -ArgumentList 'server.js' `
  -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.error"

# El primer arranque migra, siembra y crea el catálogo de demostración: en un
# equipo lento eso pasa de los seis segundos que esperaba la versión anterior.
$ready = $false
for ($attempt = 1; $attempt -le 100; $attempt++) {
  if ($server.HasExited) { break }
  Start-Sleep -Milliseconds 300
  try {
    Invoke-WebRequest -Uri "$origin/healthz" -UseBasicParsing -TimeoutSec 2 | Out-Null
    $ready = $true
    break
  } catch { }
}

if (-not $ready) {
  if (-not $server.HasExited) { Stop-Process -Id $server.Id -ErrorAction SilentlyContinue }
  Write-Host 'Ndivepa no pudo iniciar. Motivo:' -ForegroundColor Red
  foreach ($file in @("$logFile.error", $logFile)) {
    if (Test-Path $file) { Get-Content $file -Tail 15 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkYellow } }
  }
  Write-Host "`nRegistro completo en $logFile" -ForegroundColor DarkGray
  Read-Host 'Pulsa Enter para cerrar'
  exit 1
}

Start-Process $origin
Write-Host "Ndivepa está funcionando en $origin" -ForegroundColor Green
Write-Host 'No cierres esta ventana mientras estés usando la aplicación.' -ForegroundColor Yellow
Wait-Process -Id $server.Id
