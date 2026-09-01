$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$serviceScript = Join-Path $projectRoot "scripts\start-local-service.ps1"
$siteUrl = "http://127.0.0.1:5500/"
$statusUrl = "${siteUrl}api/status"

function Get-RHServerState {
  try {
    $status = Invoke-RestMethod -Uri $statusUrl -TimeoutSec 1
    if ($status.runtime.stale -eq $false) { return "ready" }
    return "stale"
  } catch {
    return "offline"
  }
}

$state = Get-RHServerState
if ($state -eq "stale") {
  $connection = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 5500 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($connection) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)"
    $pidFile = Join-Path $projectRoot "local\server.pid"
    $recordedPid = if (Test-Path -LiteralPath $pidFile -PathType Leaf) { [int](Get-Content -LiteralPath $pidFile -Raw) } else { 0 }
    # The hidden launcher deliberately starts `node server.cjs` from the project working
    # directory, so Windows does not preserve RH_Local_Renders in CommandLine. The PID file,
    # the localhost status response above, and the exact listening port identify that process.
    $belongsToThisService = $recordedPid -eq $connection.OwningProcess -or $process.CommandLine -match "RH_Local_Renders.+server\.cjs"
    if ($process.Name -eq "node.exe" -and $belongsToThisService) {
      Stop-Process -Id $connection.OwningProcess -Force
    }
  }
  for ($attempt = 0; $attempt -lt 20 -and (Get-RHServerState) -ne "offline"; $attempt++) {
    Start-Sleep -Milliseconds 250
  }
  $state = Get-RHServerState
}

if ($state -ne "ready") {
  & $serviceScript
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    Start-Sleep -Milliseconds 250
    $state = Get-RHServerState
    if ($state -eq "ready") { break }
  }
}

if ($state -eq "ready") {
  Start-Process $siteUrl
  exit 0
}

$message = "RH Local Renders could not start.`n`nCheck:`n$projectRoot\local\logs\server-error.log"
(New-Object -ComObject WScript.Shell).Popup($message, 0, "RH Local Renders", 16) | Out-Null
exit 1
