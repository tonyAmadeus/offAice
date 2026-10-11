param([Parameter(Mandatory=$true)][string]$Configuration)
$ErrorActionPreference = 'Stop'

try {
  $assembly = Join-Path $PSScriptRoot 'windows-job.dll'
  if (-not (Test-Path -LiteralPath $assembly)) { $assembly = Join-Path $PSScriptRoot '..\dist\windows-job.dll' }
  if (-not (Test-Path -LiteralPath $assembly)) { throw 'Missing precompiled process guard. Run npm run build.' }
  # Load the build-owned assembly as bytes; CLR LoadFrom rejects low-integrity
  # development paths even when the process may read them. No runtime compilation.
  [void][Reflection.Assembly]::Load([IO.File]::ReadAllBytes($assembly))
  $spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Configuration)) | ConvertFrom-Json
  $result = [AiroomWindowsJob]::Run([string]$spec.command,[string[]]$spec.args,[string]$spec.cwd,[uint32]$spec.parentPid)
  exit $result
} catch {
  [Console]::Error.WriteLine('[AIROOM process guard] ' + $_.Exception.Message)
  exit 125
}
