#requires -Version 5.1
param([ValidateSet('OpenAI','Claude')][string]$Provider='OpenAI')
$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'installation.json') -Raw | ConvertFrom-Json
$env:PATH = (Split-Path -Parent $settings.node) + ';' + $env:PATH
if ($Provider -eq 'Claude') {
  & (Join-Path $settings.package 'install/Set-ClaudeApiKey.ps1') -TargetHome $settings.home
  exit 0
} else {
  $cli = Join-Path $settings.home '.pi\agent\npm\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js'
  Write-Host 'Use /login for OpenAI. Claude reviewer API setup uses Configure-Claude-API.cmd. Credentials remain on this Windows account.'
  & $settings.node $cli
}
exit $LASTEXITCODE
