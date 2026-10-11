# Copies the unpacked desktop build to a normal-integrity location for daily use.
# Run from a normal user session, not from inside an agent sandbox: sandboxed writes outside
# the project may never reach the real disk. The target is deliberately outside AppData:
# MSIX-packaged hosts (Claude and Codex desktop apps) silently redirect AppData writes
# into their private package cache, invisible to Explorer.
# -Backup first backs up the user's data; the owner asks for it explicitly (npm run deploy -- -Backup).
param([string]$Target = (Join-Path $env:USERPROFILE 'AIROOM'), [switch]$Backup)
$ErrorActionPreference = 'Stop'
$tokenGroups = & "$env:SystemRoot\System32\whoami.exe" /groups /fo csv /nh
$integrity = [regex]::Matches(($tokenGroups -join "`n"), 'S-1-16-(\d+)\b')
if ($LASTEXITCODE -ne 0 -or $integrity.Count -ne 1 -or [int]$integrity[0].Groups[1].Value -lt 8192) { throw 'Deployment requires a normal-integrity Windows session outside the Codex sandbox.' }
$Target = [IO.Path]::GetFullPath($Target).TrimEnd('\')
$expectedTarget = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'AIROOM')).TrimEnd('\')
if (-not $Target.Equals($expectedTarget, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing mirror outside the daily runtime directory: $expectedTarget" }
if ((Test-Path -LiteralPath $Target) -and ((Get-Item -LiteralPath $Target).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Runtime target must not be a directory junction or symbolic link.' }
$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'release\win-unpacked'
if (-not (Test-Path (Join-Path $source 'AIROOM.exe'))) { throw "Build not found: $source. Run npm run build and node scripts/prepare-deployment.mjs first." }
$manifestPath = Join-Path $source 'build-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'Build manifest missing. Run npm run build and node scripts/prepare-deployment.mjs first.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
foreach ($entry in $manifest.hashes.PSObject.Properties) {
  $file = [IO.Path]::GetFullPath((Join-Path $source $entry.Name))
  if (-not $file.StartsWith(([IO.Path]::GetFullPath($source) + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid manifest path.' }
  if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.Value) { throw "Build hash mismatch: $($entry.Name)" }
}

& (Join-Path $source 'resources\app\dist\verify-runtime-dependencies.ps1') -AppRoot (Join-Path $source 'resources\app')
$running = Get-Process -Name AIROOM -ErrorAction SilentlyContinue
if ($running) { throw 'AIROOM is running. Quit it normally from the tray before updating the shared daily profile.' }
$data = Join-Path $env:USERPROFILE '.airoom\data'
# An interrupted restore is put right by the app's next start; backing up or replacing the program before that
# would capture a half-replaced data folder.
if (Get-ChildItem -LiteralPath (Split-Path -Parent $data) -Filter '.restore-journal-*.json' -Force -ErrorAction SilentlyContinue) { throw 'An unfinished restore is pending. Start AIROOM once so it can recover, then deploy again.' }

# On request, back up the user's data (handoff 12, format v1) with the writer from this build before anything is replaced.
if ($Backup -and (Test-Path -LiteralPath (Join-Path $data 'airoom.sqlite'))) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw 'Node.js is required to back up the data before deployment; nothing was replaced.' }
  & $node.Source (Join-Path $source 'resources\app\dist\backup.mjs') $data deploy | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Backup before deployment failed; nothing was replaced.' }
}

New-Item -ItemType Directory -Force $Target | Out-Null
# /COPY:DAT copies data, attributes and timestamps but not ACLs or integrity labels, so files
# inherit the target's normal permissions. User data, backups, restore leftovers and launcher state are never mirrored away.
. (Join-Path $PSScriptRoot 'copy-runtime.ps1')
Copy-AIROOMRuntime -Source $source -Destination $Target

foreach ($entry in $manifest.hashes.PSObject.Properties) {
  if ((Get-FileHash -LiteralPath (Join-Path $Target $entry.Name) -Algorithm SHA256).Hash -ne $entry.Value) { throw "Deployed hash mismatch: $($entry.Name)" }
}
& (Join-Path $Target 'resources\app\dist\verify-runtime-dependencies.ps1') -AppRoot (Join-Path $Target 'resources\app')
# Reading the audit SACL requires SeSecurityPrivilege, unavailable to normal users.
# Do not require elevation or infer safety from localized icacls output. The app
# checks its actual process token before any profile write on the first launch.
@{ deployedAt = (Get-Date).ToString('o'); sourceCommit = $manifest.sourceCommit; target = $Target; dataDirectory = $data; method = 'direct build deployment'; installerCreated = $false; backupCreated = [bool]$Backup; hashes = $manifest.hashes; userSessionAcceptance = 'pending' } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $Target 'deployment-receipt.json') -Encoding UTF8
Write-Host "Deployed to $Target"
& (Join-Path $PSScriptRoot 'create-shortcuts.ps1') -Runtime $Target
exit 0
