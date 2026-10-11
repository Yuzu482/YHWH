#Requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$PackageRoot,[Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference='Stop'
$source=[IO.Path]::GetFullPath((Join-Path $PackageRoot 'payload/pi-dispatch'))
$target=[IO.Path]::GetFullPath($Destination)
if($target -eq $source -or $target.StartsWith($source+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or $source.StartsWith($target+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Installation staging must not overlap the source payload.'}
if(Test-Path -LiteralPath $target){throw 'Installation staging destination already exists.'}
$identity=& (Join-Path $PSScriptRoot 'Get-PluginBuildIdentity.ps1') -PackageRoot $PackageRoot
Copy-Item -LiteralPath $source -Destination $target -Recurse
& (Join-Path $PSScriptRoot 'Set-InstalledPluginVersion.ps1') -PackageRoot $PackageRoot -PluginRoot $target | Out-Null
$proof=Get-Content -LiteralPath (Join-Path $target 'build-provenance.json') -Raw | ConvertFrom-Json
if($proof.sourceCommit -cne $identity.sourceCommit -or $proof.pluginVersion -cne $identity.pluginVersion -or $proof.dirty -ne $identity.dirty){throw 'Source identity changed during installation staging.'}
# Keep this private staged copy in the installation backup, including on failure.
# It is the exact source for both copying and the mandatory managed-file baseline.
Write-Output $target
