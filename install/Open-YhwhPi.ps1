#requires -Version 5.1
param([ValidateSet('OpenAI','Claude')][string]$Provider='OpenAI')
$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'installation.json') -Raw | ConvertFrom-Json
$env:PATH = (Split-Path -Parent $settings.node) + ';' + $env:PATH
if ($Provider -eq 'Claude') {
  $cli = Join-Path $settings.home '.pi\agent\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe'
  & $cli auth login --claudeai
} else {
  $cli = Join-Path $settings.home '.pi\agent\npm\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js'
  Write-Host 'Use /login for OpenAI. Claude reviewer login uses Login-Claude.cmd. Credentials remain on this Windows account.'
  & $settings.node $cli
}
exit $LASTEXITCODE
