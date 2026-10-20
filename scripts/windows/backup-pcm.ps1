#requires -Version 5.1
# PCM OpsFlow - run a verified mysqldump backup and append output to logs\backup.log.
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

$logDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$backupLog = Join-Path $logDir "backup.log"

try {
    if ((Get-Item $backupLog -ErrorAction Stop).Length -gt 5MB) {
        Move-Item $backupLog "$backupLog.old" -Force
    }
} catch {
    # No log yet.
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Add-Content -Path $backupLog -Value "[$(Get-Date -Format o)] ERROR: node.exe not found." -Encoding utf8
    exit 1
}

$tsx = Join-Path $Root "node_modules\tsx\dist\cli.mjs"
$script = Join-Path $Root "scripts\backup.ts"
if (-not (Test-Path $tsx) -or -not (Test-Path $script)) {
    Add-Content -Path $backupLog -Value "[$(Get-Date -Format o)] ERROR: tsx or backup.ts is missing. Run npm install." -Encoding utf8
    exit 1
}

$output = & $node $tsx $script 2>&1
$code = $LASTEXITCODE
$header = "[$(Get-Date -Format o)] backup exit=$code"
Add-Content -Path $backupLog -Value $header -Encoding utf8
if ($output) {
    $output | Out-File -FilePath $backupLog -Append -Encoding utf8
}
$output | Write-Output
exit $code
