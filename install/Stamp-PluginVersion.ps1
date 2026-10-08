#Requires -Version 7.0
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$SourceRepositoryRoot,
  [Parameter(Mandatory)][string]$StagingPackageRoot
)
$ErrorActionPreference = 'Stop'
# Builds and source installs share one identity calculation; source manifests stay unchanged.
$source = [IO.Path]::GetFullPath($SourceRepositoryRoot)
$stage = [IO.Path]::GetFullPath($StagingPackageRoot)
$sourcePrefix = $source.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if ($stage.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) -eq $source.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) -or $stage.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Staging root must not equal or be inside the source repository.'
}
$identity = & (Join-Path $PSScriptRoot 'Get-PluginBuildIdentity.ps1') -PackageRoot $source
$pluginPath = Join-Path $stage 'payload/pi-dispatch/.codex-plugin/plugin.json'
$portablePath = Join-Path $stage 'portable.manifest.json'
if (!(Test-Path -LiteralPath $pluginPath -PathType Leaf) -or !(Test-Path -LiteralPath $portablePath -PathType Leaf)) { throw 'Staging manifests are missing.' }
$plugin = Get-Content -LiteralPath $pluginPath -Raw | ConvertFrom-Json
$portable = Get-Content -LiteralPath $portablePath -Raw | ConvertFrom-Json
if ([string]$plugin.version -notmatch '^(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)(?:\+.*)?$') { throw 'Invalid base plugin version.' }
$pluginVersion = $identity.pluginVersion
$plugin.version = $pluginVersion
$portable.components.piDispatch = $pluginVersion
$plugin | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $pluginPath -Encoding utf8NoBOM
$portable | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $portablePath -Encoding utf8NoBOM
$identity | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $stage 'build-provenance.json') -Encoding utf8NoBOM
Write-Output $pluginVersion
