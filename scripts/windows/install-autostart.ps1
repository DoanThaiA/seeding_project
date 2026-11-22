# Registers the "SeedingSys" scheduled task: starts the whole system (scripts/server.mjs) hidden
# every time this Windows user logs on, and restarts it if the supervisor itself fails.
# It runs in the logged-on session, so fb-web browser windows (FB_HEADLESS=false) and `pnpm fb:login` still work.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1           # install / update
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1 -Remove   # uninstall
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$TaskName = 'SeedingSys'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "Removed scheduled task '$TaskName'."
  return
}

$node = (Get-Command node.exe).Source
$vbs = Join-Path $PSScriptRoot 'seedingsys-hidden.vbs'
$root = Split-Path (Split-Path $PSScriptRoot)
$user = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`" `"$node`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'SeedingSys: Postgres + api + workers + web (scripts/server.mjs)' -Force | Out-Null
Write-Output "Registered scheduled task '$TaskName' for $user (node: $node)."
