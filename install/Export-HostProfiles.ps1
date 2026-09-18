#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputDirectory,[string]$Hosts='all',[string]$TargetHome=$HOME)
$ErrorActionPreference='Stop'
$plugin=Join-Path $TargetHome 'plugins/pi-dispatch'
$mcp=Join-Path $plugin '.mcp.json'
$installed=Get-Content -LiteralPath $mcp -Raw|ConvertFrom-Json
$node=$installed.mcpServers.'pi-kether-gateway'.command
& $node (Join-Path $plugin 'scripts/host-profiles.mjs') $mcp $OutputDirectory $Hosts
if($LASTEXITCODE -ne 0){throw 'Host profile export failed.'}
