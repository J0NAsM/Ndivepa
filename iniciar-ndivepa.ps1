$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js no está instalado. Instala Node.js 20 o superior y vuelve a ejecutar este archivo.' -ForegroundColor Red
  Read-Host 'Pulsa Enter para cerrar'
  exit 1
}

$existing = Get-NetTCPConnection -LocalPort 4300 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  Start-Process 'http://localhost:4300'
  Write-Host 'Ndivepa ya estaba iniciado. Se abrió http://localhost:4300' -ForegroundColor Green
  exit 0
}

$server = Start-Process -FilePath node -ArgumentList 'server.js' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
$ready = $false
for ($attempt = 1; $attempt -le 20; $attempt++) {
  Start-Sleep -Milliseconds 300
  try {
    Invoke-WebRequest -Uri 'http://localhost:4300/' -UseBasicParsing -TimeoutSec 1 | Out-Null
    $ready = $true
    break
  } catch { }
}

if (-not $ready) {
  Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
  Write-Host 'Ndivepa no pudo iniciar. Ejecuta npm run dev desde esta carpeta para ver el error.' -ForegroundColor Red
  Read-Host 'Pulsa Enter para cerrar'
  exit 1
}

Start-Process 'http://localhost:4300'
Write-Host 'Ndivepa está funcionando en http://localhost:4300' -ForegroundColor Green
Write-Host 'No cierres esta ventana mientras estés usando la aplicación.' -ForegroundColor Yellow
Wait-Process -Id $server.Id
