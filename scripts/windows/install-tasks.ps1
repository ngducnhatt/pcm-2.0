#requires -Version 5.1
#Requires -RunAsAdministrator
# PCM OpsFlow - register Windows Scheduled Tasks (run as Administrator).
# Creates:
#   PCM OpsFlow - Watchdog : at startup + every 5 minutes (start/restart if unhealthy)
#   PCM OpsFlow - Backup   : daily at 02:00 (mysqldump + checksum + retention)
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

if (-not (Test-Path ".env.local") -and -not (Test-Path ".env")) {
    Write-Error "Missing .env.local (or .env). Configure DATABASE_URL before installing tasks."
    exit 1
}
if (-not (Test-Path ".next\BUILD_ID")) {
    Write-Error "Missing production build. Run: npm run build"
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "node.exe is not in PATH. Install Node.js 22 LTS first."
    exit 1
}

$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$watchdogScript = Join-Path $Root "scripts\windows\watchdog-pcm.ps1"
$backupScript = Join-Path $Root "scripts\windows\backup-pcm.ps1"

$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

# --- Watchdog: start at boot, then check every 5 minutes -------------------
$watchdogAction = New-ScheduledTaskAction `
    -Execute $powershell `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$watchdogScript`"" `
    -WorkingDirectory $Root

$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$repeatTrigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$watchdogSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
    -TaskName "PCM OpsFlow - Watchdog" `
    -Description "Starts and health-checks the PCM OpsFlow production server on 127.0.0.1:3000." `
    -Action $watchdogAction `
    -Trigger @($startupTrigger, $repeatTrigger) `
    -Settings $watchdogSettings `
    -Principal $principal `
    -Force | Out-Null

# --- Backup: daily at 02:00 ------------------------------------------------
$backupAction = New-ScheduledTaskAction `
    -Execute $powershell `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$backupScript`"" `
    -WorkingDirectory $Root

$backupTrigger = New-ScheduledTaskTrigger -Daily -At "02:00"
$backupSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask `
    -TaskName "PCM OpsFlow - Backup" `
    -Description "Daily verified mysqldump backup for PCM OpsFlow." `
    -Action $backupAction `
    -Trigger $backupTrigger `
    -Settings $backupSettings `
    -Principal $principal `
    -Force | Out-Null

Write-Host ""
Write-Host "Scheduled tasks installed:"
Write-Host "  PCM OpsFlow - Watchdog  (at startup, then every 5 minutes)"
Write-Host "  PCM OpsFlow - Backup    (daily 02:00)"
Write-Host ""
Write-Host "Start the server now:  Start-ScheduledTask -TaskName 'PCM OpsFlow - Watchdog'"
Write-Host "Check status:          Get-ScheduledTaskInfo -TaskName 'PCM OpsFlow - Watchdog'"
Write-Host "Health check:          npm run health"
Write-Host "Stop the server:       powershell -ExecutionPolicy Bypass -File scripts\\windows\\stop-pcm.ps1"
