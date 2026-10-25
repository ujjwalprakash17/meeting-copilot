# Meeting Copilot launcher: checks the API keys, builds, then starts the local server.
# Everything shown in this window is also written to copilot-run.log (git-ignored) so it can be reviewed later.
Set-Location -Path $PSScriptRoot
$log = Join-Path $PSScriptRoot 'copilot-run.log'
Set-Content -Path $log -Value "=== Meeting Copilot run $(Get-Date -Format s) ===" -Encoding UTF8

function Write-Log([string]$text, [string]$color = 'Gray') {
  Write-Host $text -ForegroundColor $color
  Add-Content -Path $log -Value $text -Encoding UTF8
}

function Invoke-Step([string]$title, [string]$command) {
  Write-Log "`n=== $title ===" 'Cyan'
  cmd /c "$command 2>&1" | ForEach-Object {
    Write-Host $_
    Add-Content -Path $log -Value $_ -Encoding UTF8
  }
  $code = $LASTEXITCODE
  Write-Log "=== $title finished (exit $code) ===" ($(if ($code -eq 0) { 'Green' } else { 'Red' }))
  return $code
}

Write-Log "node $(node -v), npm $(npm -v)"

if ((Invoke-Step 'STEP 1/3: check API keys' 'npm run check:keys -w server') -ne 0) {
  Write-Log 'STOPPED: the key check failed (see above).' 'Red'
  exit 1
}
if ((Invoke-Step 'STEP 2/3: build server and extension' 'npm run build') -ne 0) {
  Write-Log 'STOPPED: the build failed (see above).' 'Red'
  exit 1
}

$busy = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  Write-Log "NOTE: port 8787 is already in use by process $($busy[0].OwningProcess). Close that server first, or this one will fail to start." 'Yellow'
}

Write-Log "`nSTEP 3/3: starting the server. Keep this window open while you use the extension (Ctrl+C stops it)." 'Cyan'
Invoke-Step 'server (npm run dev:server)' 'npm run dev:server' | Out-Null
