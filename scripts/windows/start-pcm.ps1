#requires -Version 5.1
# PCM OpsFlow - start the production runner in the foreground.
# For Task Scheduler use watchdog-pcm.ps1 instead (it starts the runner hidden).
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

if (-not (Test-Path ".env.local")) {
    Write-Error "Missing .env.local. Copy .env.example to .env.local and fill in DATABASE_URL."
    exit 1
}
if (-not (Test-Path ".next\BUILD_ID")) {
    Write-Error "Missing production build. Run: npm run build"
    exit 1
}

New-Item -ItemType Directory -Force -Path "logs" | Out-Null

$node = (Get-Command node -ErrorAction Stop).Source
& $node "scripts\server-runner.mjs"
exit $LASTEXITCODE
