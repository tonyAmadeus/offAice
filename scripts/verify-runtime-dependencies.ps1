param([Parameter(Mandatory = $true)][string]$AppRoot)
$ErrorActionPreference = 'Stop'
# Native child processes may inherit a PowerShell 7-only module path.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
$AppRoot = [IO.Path]::GetFullPath($AppRoot).TrimEnd('\')
$lockPath = Join-Path $AppRoot 'package-lock.json'
$manifest = Get-Content -LiteralPath (Join-Path $AppRoot 'dist\runtime-dependencies.json') -Raw | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash -ne $manifest.lockSha256) { throw 'Runtime lockfile hash mismatch.' }
# Windows PowerShell 5.1 cannot represent the lockfile's empty root-package key.
# Rename that unused key in the parsing copy; the hash checks the original bytes.
$lock = ((Get-Content -LiteralPath $lockPath -Raw) -replace '""\s*:', '"__airoom_lock_root__":') | ConvertFrom-Json
$records = @{}
foreach ($record in $manifest.packages) { $records[$record.path] = $record }
$excluded = @{}
foreach ($record in $manifest.excluded) { $excluded[$record.path] = $true }
function Supports-Platform($Values, [string]$Current) {
    if (-not $Values) { return $true }
    if ($Values -contains "!$Current") { return $false }
    $positive = @($Values | Where-Object { -not $_.StartsWith('!') })
    return ($positive.Count -eq 0 -or $positive -contains $Current)
}
function Resolve-Dependency([string]$Name) {
    if (-not $Name.StartsWith('node_modules/') -or $Name.Contains('\') -or @($Name.Split('/') | Where-Object { $_ -eq '..' -or $_ -eq '.' }).Count) { throw 'Invalid dependency manifest path.' }
    $file = [IO.Path]::GetFullPath((Join-Path $AppRoot $Name))
    if (-not $file.StartsWith($AppRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Dependency escaped app root.' }
    return $file
}
$failures = @()
foreach ($entry in $lock.packages.PSObject.Properties) {
    $name = $entry.Name; $package = $entry.Value
    if (-not $name.StartsWith('node_modules/') -or $package.dev -or -not (Supports-Platform $package.os $manifest.platform) -or -not (Supports-Platform $package.cpu $manifest.arch)) { continue }
    $record = $records[$name]
    if (-not $record -and $package.optional -and $excluded[$name]) { continue }
    try {
        if (-not $record) { throw 'missing inventory' }
        $file = Join-Path (Resolve-Dependency $name) 'package.json'
        $actual = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
        if ($actual.version -ne $package.version -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $record.packageJsonSha256) { throw 'version or hash mismatch' }
    } catch { $failures += "$name : $($_.Exception.Message)" }
}
foreach ($record in $manifest.equivalentFiles) {
    if ((Get-FileHash -LiteralPath (Resolve-Dependency $record.path) -Algorithm SHA256).Hash -ne $record.sha256) { $failures += "$($record.path) : executable hash mismatch" }
}
if ($failures.Count) { throw ("Production dependencies incomplete:`n" + ($failures -join "`n")) }
Write-Host "Runtime dependency check passed: $($records.Count) exact production package paths."
