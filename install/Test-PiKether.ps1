[CmdletBinding()]
param(
  [switch]$Installed,
  [string]$TargetHome = $HOME,
  [string]$WslDistro = 'Ubuntu-24.04',
  [switch]$SkipWsl
)
$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
$failures = [Collections.Generic.List[string]]::new()
function Check([bool]$Ok, [string]$Name) {
  if ($Ok) { Write-Host "[PASS] $Name" -ForegroundColor Green }
  else { Write-Host "[FAIL] $Name" -ForegroundColor Red; $failures.Add($Name) }
}
try { $manifest = Get-Content -LiteralPath (Join-Path $packageRoot 'portable.manifest.json') -Raw | ConvertFrom-Json; Check ($manifest.containsCredentials -eq $false) 'portable manifest' } catch { Check $false 'portable manifest' }
$payloadPlugin = Join-Path $packageRoot 'payload\pi-dispatch'
try { $pluginManifest = Get-Content -LiteralPath (Join-Path $payloadPlugin '.codex-plugin\plugin.json') -Raw | ConvertFrom-Json; Check ($pluginManifest.name -eq 'pi-dispatch') 'Codex plugin manifest' } catch { Check $false 'Codex plugin manifest' }

$policy = Get-Content -LiteralPath (Join-Path $packageRoot 'templates\AGENTS.kether.md') -Raw
foreach ($link in [regex]::Matches($policy, '\]\((agent-references/[^)]+)\)')) {
  Check (Test-Path -LiteralPath (Join-Path $packageRoot ('templates/' + $link.Groups[1].Value)) -PathType Leaf) ('policy reference: ' + $link.Groups[1].Value)
}
$scanFiles = Get-ChildItem -LiteralPath $packageRoot -Recurse -File | Where-Object { $_.FullName -notmatch '[\\/](release|\.test|\.git|node_modules)[\\/]' -and $_.FullName -ne $PSCommandPath -and $_.Extension -notin '.zip','.sha256' }
$hostUserPath = 'C:' + '\Users\' + 'asus'
$hostRepoPath = 'E:' + '\Projects\' + 'DeepSeekHarness'
$oldTunnel = 'tunnel_' + '6a9aa889406481918ef6a135c41493c7'
$forbidden = '(?i)' + [regex]::Escape($hostUserPath) + '|' + [regex]::Escape($hostRepoPath) + '|' + [regex]::Escape($oldTunnel) + '|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|sk-[A-Za-z0-9_-]{20,}'
$hits = foreach ($file in $scanFiles) { Select-String -LiteralPath $file.FullName -Pattern $forbidden -ErrorAction SilentlyContinue }
$hits = @($hits | Where-Object { $_.Line -notmatch 'sk-super-secret-123456789|sk-request-secret-12345678' })
Check (-not $hits) 'no credentials or host-specific paths in distributable files'
$backups = $scanFiles | Where-Object { $_.Name -match '\.bak$|\.backup$' }
Check (-not $backups) 'no backup files in payload'

if ($Installed) {
  $plugin = Join-Path $TargetHome 'plugins\pi-dispatch'
  Check (Test-Path -LiteralPath (Join-Path $plugin 'node_modules\@modelcontextprotocol\sdk')) 'plugin dependencies installed'
  Check (Test-Path -LiteralPath (Join-Path $TargetHome '.codex\AGENTS.md')) 'Kether policy installed'
  foreach ($link in [regex]::Matches($policy, '\]\((agent-references/[^)]+)\)')) {
    Check (Test-Path -LiteralPath (Join-Path $TargetHome ('.codex/' + $link.Groups[1].Value)) -PathType Leaf) ('installed policy reference: ' + $link.Groups[1].Value)
  }
  Check (Test-Path -LiteralPath (Join-Path $TargetHome '.agents\skills\kether-governance\SKILL.md')) 'Kether skills installed'
  try {
    $mcp = Get-Content -LiteralPath (Join-Path $plugin '.mcp.json') -Raw | ConvertFrom-Json
    Check ([bool]$mcp.mcpServers.'pi-kether-gateway'.env.PI_GATEWAY_ROOTS) 'MCP workspace scope configured'
  } catch { Check $false 'MCP workspace scope configured' }
  if (-not $SkipWsl) {
    $probe = & wsl.exe -d $WslDistro -u root -- /usr/local/libexec/pi-kether-sandbox --probe
    $probeObject = try { $probe | ConvertFrom-Json } catch { $null }
    Check ($LASTEXITCODE -eq 0 -and $probeObject.ok -eq $true -and $probeObject.resourceLimits -eq $true) 'WSL isolation and cgroup resource limits'
    & wsl.exe -d $WslDistro -u root -- sh -c 'command -v pyright-langserver typescript-language-server clangd jdtls csharp-ls >/dev/null'
    Check ($LASTEXITCODE -eq 0) 'six-language LSP command set'
  }
  $auth = Join-Path $TargetHome '.pi\agent\auth.json'
  if (Test-Path -LiteralPath $auth) { Write-Host '[PASS] Pi provider login present' -ForegroundColor Green }
  else { Write-Host '[ACTION] Run Pi login before model heartbeat tests.' -ForegroundColor Yellow }
}
if ($failures.Count) { Write-Error ("Self-test failed: " + ($failures -join ', ')); exit 1 }
Write-Host '[PASS] Pi Kether portable self-test complete.' -ForegroundColor Green
$global:LASTEXITCODE = 0
