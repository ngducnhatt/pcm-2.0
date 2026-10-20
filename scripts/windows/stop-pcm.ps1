#requires -Version 5.1
# PCM OpsFlow - stop the runner and its Next.js child process.
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$pidFile = Join-Path $Root "logs\pcm-opsflow.pid"
$serverPid = $null

if (Test-Path $pidFile) {
    $raw = (Get-Content $pidFile -Raw).Trim()
    $parsed = 0
    if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -gt 0) {
        $serverPid = $parsed
    }
}

if (-not $serverPid) {
    Write-Host "PCM OpsFlow is not running (no PID file)."
    exit 0
}

$process = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
if ($null -eq $process) {
    Write-Host "Stale PID file found; removing it."
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    exit 0
}
if ($process.ProcessName -notmatch '^node$') {
    Write-Warning "PID $serverPid is '$($process.ProcessName)', not node. Refusing to kill it."
    exit 1
}

Write-Host "Stopping PCM OpsFlow (PID $serverPid) ..."
& taskkill.exe /PID $serverPid /T /F | Out-Null
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
exit 0
