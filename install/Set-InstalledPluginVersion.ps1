#Requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$PackageRoot,[Parameter(Mandatory)][string]$PluginRoot)
$ErrorActionPreference = 'Stop'
$identity = & (Join-Path $PSScriptRoot 'Get-PluginBuildIdentity.ps1') -PackageRoot $PackageRoot
$manifestPath = Join-Path $PluginRoot '.codex-plugin/plugin.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$manifest.version = $identity.pluginVersion
$manifest | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM
$identity | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $PluginRoot 'build-provenance.json') -Encoding utf8NoBOM
Write-Output $identity.pluginVersion
