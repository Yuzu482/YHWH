[CmdletBinding()]
param(
  [switch]$Installed,
  [string]$TargetHome = $HOME,
  [string]$WslDistro = 'Ubuntu-24.04',
  [string[]]$Hosts = @('codex'),
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
foreach($headlessFile in @('scripts/headless-host.mjs','scripts/headless-adapters.mjs','scripts/headless-job.ps1','scripts/headless-acceptance.mjs','workflow/headless.example.json','workflow/catalog.json')) {
  Check (Test-Path -LiteralPath (Join-Path $payloadPlugin $headlessFile) -PathType Leaf) ('headless CLI payload: '+$headlessFile)
  if($Installed) {
    $installedFile=Join-Path (Join-Path $TargetHome 'plugins/pi-dispatch') $headlessFile
    Check ((Test-Path -LiteralPath $installedFile -PathType Leaf) -and ((Get-FileHash -LiteralPath $installedFile).Hash -eq (Get-FileHash -LiteralPath (Join-Path $payloadPlugin $headlessFile)).Hash)) ('headless CLI installed parity: '+$headlessFile)
  }
}
try { $pluginManifest = Get-Content -LiteralPath (Join-Path $payloadPlugin '.codex-plugin\plugin.json') -Raw | ConvertFrom-Json; Check ($pluginManifest.name -eq 'pi-dispatch') 'Codex plugin manifest' } catch { Check $false 'Codex plugin manifest' }

$policy = Get-Content -LiteralPath (Join-Path $packageRoot 'templates\AGENTS.kether.md') -Raw
foreach ($link in [regex]::Matches($policy, '\]\((agent-references/[^)]+)\)')) {
  Check (Test-Path -LiteralPath (Join-Path $packageRoot ('templates/' + $link.Groups[1].Value)) -PathType Leaf) ('policy reference: ' + $link.Groups[1].Value)
}
function Get-DistributableFiles([string]$Directory) {
  foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
    if ($item.PSIsContainer) {
      if ($item.Name -in @('release','.test','.git','node_modules','__pycache__')) { continue }
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing distribution scan through a link: $($item.FullName)" }
      Get-DistributableFiles $item.FullName
    } elseif ($item.FullName -ne $PSCommandPath -and $item.Extension -notin '.zip','.sha256','.pyc') { $item }
  }
}
$scanFiles = @(Get-DistributableFiles $packageRoot)
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
  $piEntry = Join-Path $TargetHome '.pi\agent\npm\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js'
  Check (Test-Path -LiteralPath $piEntry -PathType Leaf) 'host Pi entry installed'
  Check (Test-Path -LiteralPath (Join-Path $plugin 'workflow\catalog.json')) 'host-neutral workflow catalog installed'
  if($Hosts -contains 'codex'){
  Check (Test-Path -LiteralPath (Join-Path $TargetHome '.codex\AGENTS.md')) 'Kether policy installed'
  foreach ($link in [regex]::Matches($policy, '\]\((agent-references/[^)]+)\)')) {
    Check (Test-Path -LiteralPath (Join-Path $TargetHome ('.codex/' + $link.Groups[1].Value)) -PathType Leaf) ('installed policy reference: ' + $link.Groups[1].Value)
  }
  Check (Test-Path -LiteralPath (Join-Path $TargetHome '.agents\skills\kether-governance\SKILL.md')) 'Kether skills installed'
  }
  $hostState=Get-Content -LiteralPath (Join-Path $TargetHome '.local\state\pi-kether\installation-hosts.json') -Raw|ConvertFrom-Json
  foreach($hostId in $Hosts){Check (Test-Path -LiteralPath (Join-Path $hostState.profiles "$hostId/connection.json")) ("host profile: $hostId")}
  try {
    $mcp = Get-Content -LiteralPath (Join-Path $plugin '.mcp.json') -Raw | ConvertFrom-Json
    Check ([bool]$mcp.mcpServers.'pi-kether-gateway'.env.PI_GATEWAY_ROOTS) 'MCP workspace scope configured'
    Check ($mcp.mcpServers.'pi-kether-gateway'.env.PI_DISPATCH_PI_ENTRY -eq $piEntry) 'MCP resolves the installed host Pi entry'
  } catch { Check $false 'MCP workspace scope configured' }
  if (-not $SkipWsl) {
    $probe = & wsl.exe -d $WslDistro -u root -- /usr/local/libexec/pi-kether-sandbox --probe
    $probeObject = try { $probe | ConvertFrom-Json } catch { $null }
    Check ($LASTEXITCODE -eq 0 -and $probeObject.ok -eq $true -and $probeObject.resourceLimits -eq $true) 'WSL isolation and cgroup resource limits'
    & wsl.exe -d $WslDistro -u root -- sh -c 'export PATH=/opt/node/bin:/opt/pi-kether/node_modules/.bin:/usr/local/bin:/usr/bin:/bin; for tool in pyright-langserver typescript-language-server clangd jdtls csharp-ls; do command -v "$tool" >/dev/null || exit 1; done'
    Check ($LASTEXITCODE -eq 0) 'six-language LSP command set'
    & wsl.exe -d $WslDistro -u root --exec sh -c 'test -x /opt/pi-kether/go/bin/go && test -x /opt/pi-kether/gopls/gopls && test -x /opt/pi-kether/rust/bin/rustc && test -x /opt/pi-kether/rust/bin/rust-analyzer && test -d /opt/pi-kether/rust/lib/rustlib/src/rust/library'
    Check ($LASTEXITCODE -eq 0) 'Go and Rust compiler, analyzer and standard-library source installed'
    $multilspyVersion = & wsl.exe -d $WslDistro -u root --exec /opt/pi-kether/multilspy-venv/bin/python -I -c 'from importlib.metadata import version; import sys; print(version(sys.argv[1]))' multilspy
    Check ($LASTEXITCODE -eq 0 -and "$multilspyVersion".Trim() -eq $manifest.components.multilspy) 'pinned multilspy runtime installed'
    & wsl.exe -d $WslDistro -u root --exec test -f /opt/pi-kether/node_modules/typescript-lsp/lib/tsserver.js
    Check ($LASTEXITCODE -eq 0) 'separate TypeScript LSP server installed'
  }
  $auth = Join-Path $TargetHome '.pi\agent\auth.json'
  if (Test-Path -LiteralPath $auth) { Write-Host '[INFO] Pi credential file exists; validity and model access have not been checked.' -ForegroundColor Yellow }
  else { Write-Host '[ACTION] Run Pi login before model heartbeat tests.' -ForegroundColor Yellow }
}
if ($failures.Count) { Write-Error ("Self-test failed: " + ($failures -join ', ')); exit 1 }
Write-Host '[PASS] Pi Kether portable self-test complete.' -ForegroundColor Green
$global:LASTEXITCODE = 0
