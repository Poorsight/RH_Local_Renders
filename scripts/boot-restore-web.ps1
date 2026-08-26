<#
  Brings the published page back after a reboot.

    1) starts the local service if it is not listening
    2) reuses a live Quick Tunnel for port 5500, or starts one
    3) if the tunnel address changed, rewrites config.js and re-uploads the page

  A Quick Tunnel gets a new address every time it starts, so publishing that address is
  this script's whole job: the person using the page enters an access key once and never
  touches the address at all.

  Idempotent. Run with -Force to redeploy even when the address has not moved.
#>
param([switch]$Force)

$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$logDir = Join-Path $repoRoot "local\logs"
$logFile = Join-Path $logDir "BootRestore.log"
$stateFile = Join-Path $repoRoot "local\cache\tunnel-state.json"
$tunnelErrLog = Join-Path $logDir "Cloudflared.err.log"
$tunnelOutLog = Join-Path $logDir "Cloudflared.out.log"
$cloudflaredExe = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$bashExe = "C:\Program Files\Git\bin\bash.exe"
$uploadScript = "C:\Users\Dima\.claude\skills\preview-deploy\upload.sh"
$serviceScript = Join-Path $repoRoot "scripts\start-local-service.ps1"
$subfolder = "renders-control"
$publicUrl = "https://preview.3dsource.com/dmitriy.derevyanko/$subfolder/"
$localPort = 5500
$urlPattern = "https://[a-z0-9-]+\.trycloudflare\.com"

New-Item -ItemType Directory -Path $logDir -Force | Out-Null
function Write-Log($message) {
  $line = "{0}  {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $message
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
  Write-Output $line
}
function Test-Http($url, $timeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try { if ((Invoke-WebRequest -Uri $url -TimeoutSec 10 -UseBasicParsing).StatusCode -eq 200) { return $true } } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}
# Only ever touch the tunnel that serves this port. Another project runs its own
# cloudflared, and killing every one of them would take that project down too.
function Get-OurTunnelProcesses {
  Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape("127.0.0.1:$localPort") }
}

try {
  Write-Log "--- boot restore started ---"

  # 1. The service itself. A tunnel to a closed door is worse than no tunnel.
  if (-not (Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $localPort -State Listen -ErrorAction SilentlyContinue)) {
    Write-Log "Service is not listening on $localPort; starting it."
    & $serviceScript
  } else {
    Write-Log "Service already listening on $localPort."
  }
  if (-not (Test-Http "http://127.0.0.1:$localPort/api/status" 60)) { throw "The local service did not answer on port $localPort." }

  # A tunnel makes this service reachable by anyone who learns the address, and the
  # service can start renders and delete batches. If a key is configured but the running
  # service is not enforcing it, publishing would hand out an open door: stop instead.
  $expectsKey = [bool]([Environment]::GetEnvironmentVariable("RH_ACCESS_KEY", "Process") -or
                       [Environment]::GetEnvironmentVariable("RH_ACCESS_KEY", "User") -or
                       [Environment]::GetEnvironmentVariable("RH_ACCESS_KEY", "Machine"))
  $access = (Invoke-RestMethod -Uri "http://127.0.0.1:$localPort/api/status" -TimeoutSec 15).access
  if ($expectsKey -and -not $access.required) {
    throw "RH_ACCESS_KEY is configured but the running service is not asking for it. Restart the service so it picks the key up; refusing to publish an unguarded address."
  }
  if (-not $expectsKey) {
    Write-Log "WARNING: no RH_ACCESS_KEY is configured, so anyone with the address can drive this service."
  }
  Write-Log ("Access gate: " + $(if ($access.required) { "on" } else { "OFF" }))

  # 2. Reuse a tunnel that is already up and actually working.
  $tunnelUrl = $null
  if (Get-OurTunnelProcesses) {
    $found = Select-String -Path $tunnelErrLog -Pattern $urlPattern -ErrorAction SilentlyContinue |
      Select-Object -Last 1
    if ($found) {
      $candidate = $found.Matches[0].Value
      if (Test-Http "$candidate/api/status" 25) { $tunnelUrl = $candidate; Write-Log "Reusing the live tunnel." }
      else { Write-Log "cloudflared is up but $candidate does not answer; restarting the tunnel." }
    }
  }

  if (-not $tunnelUrl) {
    Get-OurTunnelProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $tunnelErrLog -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath $cloudflaredExe -ArgumentList "tunnel", "--url", "http://127.0.0.1:$localPort" `
      -WindowStyle Hidden -RedirectStandardError $tunnelErrLog -RedirectStandardOutput $tunnelOutLog
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline -and -not $tunnelUrl) {
      Start-Sleep -Seconds 2
      $found = Select-String -Path $tunnelErrLog -Pattern $urlPattern -ErrorAction SilentlyContinue | Select-Object -Last 1
      if ($found) { $tunnelUrl = $found.Matches[0].Value }
    }
    if (-not $tunnelUrl) { throw "cloudflared produced no address within 90 seconds." }
  }
  Write-Log "Tunnel: $tunnelUrl"

  # 3. Publishing is only needed when the address moved.
  $deployedUrl = ""
  if (Test-Path -LiteralPath $stateFile) {
    try { $deployedUrl = [string](Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json).deployedTunnelUrl } catch { }
  }
  if (-not $Force -and $deployedUrl -eq $tunnelUrl) {
    Write-Log "The address has not changed; the published page is current."
    return
  }

  # 4. Stage the page with the fresh address in config.js. The repo copy keeps its empty
  #    value so a locally served page stays same-origin.
  $staging = Join-Path $env:TEMP ("rh-web-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory -Path $staging -Force | Out-Null
  try {
    foreach ($file in "index.html", "app.css", "app.js", "favicon.svg") {
      Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination $staging
    }
    @(
      "// Written by scripts/boot-restore-web.ps1 on every boot. Do not edit by hand.",
      "window.RH_API_BASE = `"$tunnelUrl`";"
    ) -join "`n" | Set-Content -LiteralPath (Join-Path $staging "config.js") -Encoding UTF8

    if (-not (Test-Path -LiteralPath $bashExe)) { throw "Git Bash was not found: $bashExe" }
    if (-not (Test-Path -LiteralPath $uploadScript)) { throw "upload.sh was not found: $uploadScript" }
    $output = & $bashExe ($uploadScript -replace "\\", "/") ($staging -replace "\\", "/") $subfolder 2>&1
    if ($LASTEXITCODE -ne 0) {
      $output | Select-Object -Last 10 | ForEach-Object { Write-Log ([string]$_) }
      throw "upload.sh exited with code $LASTEXITCODE."
    }
    Write-Log ([string]($output | Select-Object -Last 1))
  } finally { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }

  # 5. Verify and record, so the next boot can skip the work.
  if (-not (Test-Http $publicUrl 30)) { throw "$publicUrl did not answer 200 after the upload." }
  New-Item -ItemType Directory -Path (Split-Path -Parent $stateFile) -Force | Out-Null
  [ordered]@{ deployedTunnelUrl = $tunnelUrl; deployedAt = [DateTime]::UtcNow.ToString("o") } |
    ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
  Write-Log "Done: the page now points at $tunnelUrl"
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  exit 1
}
