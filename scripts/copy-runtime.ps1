function Copy-AIROOMRuntime([string]$Source, [string]$Destination) {
    $Source = [IO.Path]::GetFullPath($Source).TrimEnd('\')
    $Destination = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
    if ($Source.Equals($Destination, [StringComparison]::OrdinalIgnoreCase) -or $Source.StartsWith($Destination + '\', [StringComparison]::OrdinalIgnoreCase) -or $Destination.StartsWith($Source + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime copy roots overlap.' }
    foreach ($base in @($Source, $Destination)) {
        foreach ($relative in @('', 'resources', 'resources\app', 'resources\app\node_modules', 'resources\app\node_modules\npm')) {
            $folder = if ($relative) { Join-Path $base $relative } else { $base }
            if ((Test-Path -LiteralPath $folder) -and ((Get-Item -LiteralPath $folder).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Runtime copy refuses directory links.' }
        }
    }
    # Existing users already acquired these programs. Keep their files at the same paths,
    # including dependencies, so old native session identities still resolve after upgrading.
    robocopy $Source $Destination /MIR /COPY:DAT /DCOPY:DAT /XJ /R:2 /W:1 /NFL /NDL /NJH /NP /XD (Join-Path $Destination 'data') (Join-Path $Destination 'launch-temp') (Join-Path $Destination 'backups') (Join-Path $Destination '.restore-previews') '.restore-rollback-*' 'node_modules' /XF 'Uninstall AIROOM.exe' '__uninstaller*' launch.log '.restore-journal-*' | Out-Host
    if ($LASTEXITCODE -ge 8) { throw "Runtime copy failed: $LASTEXITCODE" }
    $modules = Join-Path $Source 'resources\app\node_modules'
    if (Test-Path -LiteralPath $modules) {
        robocopy $modules (Join-Path $Destination 'resources\app\node_modules') /E /COPY:DAT /DCOPY:DAT /XJ /R:2 /W:1 /NFL /NDL /NJH /NP | Out-Host
        if ($LASTEXITCODE -ge 8) { throw "Dependency copy failed: $LASTEXITCODE" }
        # Only these obsolete help directories are pruned; acquired CLIs and
        # all old dependency paths remain available for native session resume.
        $npmSource = Join-Path $modules 'npm'
        $npmTarget = [IO.Path]::GetFullPath((Join-Path $Destination 'resources\app\node_modules\npm'))
        if (Test-Path -LiteralPath (Join-Path $npmSource 'package.json')) {
            foreach ($help in @('docs', 'man')) {
                $helpTarget = [IO.Path]::GetFullPath((Join-Path $npmTarget $help))
                if (-not $helpTarget.StartsWith($npmTarget + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe documentation cleanup target.' }
                if ((Test-Path -LiteralPath (Join-Path $npmSource $help)) -or -not (Test-Path -LiteralPath $helpTarget)) { continue }
                $info = Get-Item -LiteralPath $helpTarget -Force
                if (-not $info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Runtime documentation cleanup refuses links and non-directories.' }
                if (Get-ChildItem -LiteralPath $helpTarget -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | Select-Object -First 1) { throw 'Runtime documentation cleanup refuses nested links.' }
                Remove-Item -LiteralPath $helpTarget -Recurse -Force
            }
        }
    }
}
