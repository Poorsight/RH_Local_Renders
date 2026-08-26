$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$serverFile = Join-Path $projectRoot "server.cjs"
$localFolder = Join-Path $projectRoot "local"
$logFolder = Join-Path $localFolder "logs"
$pidFile = Join-Path $localFolder "server.pid"
$stdoutLog = Join-Path $logFolder "server.log"
$stderrLog = Join-Path $logFolder "server-error.log"

$existing = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 5500 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) {
  Set-Content -LiteralPath $pidFile -Value ([string]$existing.OwningProcess) -Encoding ascii
  exit 0
}

$node = Get-Command "node.exe" -ErrorAction Stop
if (-not (Test-Path -LiteralPath $serverFile -PathType Leaf)) {
  throw "RH Local Renders server was not found: $serverFile"
}

# A process started before these variables were set does not have them, so read the
# persisted values directly rather than trusting whatever this process inherited.
foreach ($name in "RH_ACCESS_KEY", "RH_ALLOWED_ORIGINS") {
  if (-not [Environment]::GetEnvironmentVariable($name, "Process")) {
    $value = [Environment]::GetEnvironmentVariable($name, "User")
    if (-not $value) { $value = [Environment]::GetEnvironmentVariable($name, "Machine") }
    if ($value) { [Environment]::SetEnvironmentVariable($name, $value, "Process") }
  }
}

New-Item -ItemType Directory -Path $logFolder -Force | Out-Null
$process = Start-Process -FilePath $node.Source -ArgumentList $serverFile -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
Set-Content -LiteralPath $pidFile -Value ([string]$process.Id) -Encoding ascii
