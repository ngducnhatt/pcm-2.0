#requires -Version 5.1
# PCM OpsFlow - watchdog: start the runner if it is down or unhealthy.
# Intended to run every 5 minutes from Task Scheduler and at system startup.
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

$logDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$watchdogLog = Join-Path $logDir "watchdog.log"

function Write-WatchdogLog([string]$message) {
    $line = "[{0}] {1}" -f (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"), $message
    Add-Content -Path $watchdogLog -Value $line -Encoding utf8
}

# Keep the watchdog log small without touching application logs.
try {
    if ((Get-Item $watchdogLog -ErrorAction Stop).Length -gt 5MB) {
        Move-Item $watchdogLog "$watchdogLog.old" -Force
    }
} catch {
    # No log yet.
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Write-WatchdogLog "ERROR: node.exe not found in PATH."
    exit 1
}

$envFile = Join-Path $Root ".env.local"
$buildFile = Join-Path $Root ".next\BUILD_ID"
if (-not (Test-Path $envFile) -or -not (Test-Path $buildFile)) {
    Write-WatchdogLog "ERROR: missing .env.local or .next\BUILD_ID. Run npm run build first."
    exit 1
}

& $node "scripts\healthcheck.mjs" *> $null
if ($LASTEXITCODE -eq 0) {
    exit 0
}

Write-WatchdogLog "Health check failed; restarting PCM OpsFlow."

$pidFile = Join-Path $logDir "pcm-opsflow.pid"
$serverPid = $null
if (Test-Path $pidFile) {
    $raw = (Get-Content $pidFile -Raw).Trim()
    $parsed = 0
    if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -gt 0) {
        $serverPid = $parsed
    }
}

if ($serverPid) {
    $process = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
    if ($null -ne $process -and $process.ProcessName -match '^node$') {
        Write-WatchdogLog "Stopping unhealthy runner PID $serverPid."
        & taskkill.exe /PID $serverPid /T /F | Out-Null
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

$runnerPath = Join-Path $Root "scripts\server-runner.mjs"
Start-Process -FilePath $node -ArgumentList "`"$runnerPath`"" -WorkingDirectory $Root -WindowStyle Hidden
Write-WatchdogLog "Runner start requested."
exit 0
