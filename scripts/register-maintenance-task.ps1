param(
  [string]$TaskName = 'Ndivepa-Mantenimiento',
  [string]$At = '03:00'
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $projectRoot 'scripts\affiliate-maintenance.js'
$action = New-ScheduledTaskAction -Execute $node -Argument ('"{0}"' -f $script) -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $At
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Description 'Mantenimiento local de enlaces, precios y programas de Ndivepa.' -Force | Out-Null
Write-Host "Tarea '$TaskName' registrada para las $At."
