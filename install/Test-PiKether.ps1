[CmdletBinding()]
param(
  [switch]$Installed,
  [string]$TargetHome = $HOME,
  [string]$WslDistro = 'Ubuntu-24.04',
  [string[]]$Hosts = @('codex'),
  [switch]$SkipWsl
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'HostWorkflowDrift.ps1')
$packageRoot = Split-Path -Parent $PSScriptRoot
$failures = [Collections.Generic.List[string]]::new()
function Check([bool]$Ok, [string]$Name) {
  if ($Ok) { Write-Host "[PASS] $Name" -ForegroundColor Green }
  else { Write-Host "[FAIL] $Name" -ForegroundColor Red; $failures.Add($Name) }
}
try { $manifest = Get-Content -LiteralPath (Join-Path $packageRoot 'portable.manifest.json') -Raw | ConvertFrom-Json; Check ($manifest.containsCredentials -eq $false) 'portable manifest' } catch { Check $false 'portable manifest' }
$payloadPlugin = Join-Path $packageRoot 'payload\pi-dispatch'
Check (Test-Path -LiteralPath (Join-Path $packageRoot 'install\Apply-HindsightWrapper.ps1') -PathType Leaf) 'Hindsight wrapper installer included'
Check (Test-Path -LiteralPath (Join-Path $packageRoot 'templates\hindsight-coding-agent\SKILL.md') -PathType Leaf) 'Hindsight wrapper template included'
foreach($headlessFile in @('scripts/headless-host.mjs','scripts/headless-adapters.mjs','scripts/headless-job.ps1','scripts/headless-acceptance.mjs','scripts/worker-enforcement.mjs','scripts/controlled-provider.mjs','workflow/headless.example.json','workflow/catalog.json')) {
  Check (Test-Path -LiteralPath (Join-Path $payloadPlugin $headlessFile) -PathType Leaf) ('headless CLI payload: '+$headlessFile)
  if($Installed) {
    $installedFile=Join-Path (Join-Path $TargetHome 'plugins/pi-dispatch') $headlessFile
    Check ((Test-Path -LiteralPath $installedFile -PathType Leaf) -and ((Get-FileHash -LiteralPath $installedFile).Hash -eq (Get-FileHash -LiteralPath (Join-Path $payloadPlugin $headlessFile)).Hash)) ('headless CLI installed parity: '+$headlessFile)
  }
}
try { $pluginManifestPath = Join-Path $payloadPlugin '.codex-plugin\plugin.json'; $pluginManifest = Get-Content -LiteralPath $pluginManifestPath -Raw | ConvertFrom-Json; Check ($pluginManifest.name -eq 'pi-dispatch' -and $pluginManifest.version -eq $manifest.components.piDispatch) 'Codex plugin manifest and portable version parity' } catch { Check $false 'Codex plugin manifest and portable version parity' }

$policy = Get-Content -LiteralPath (Join-Path $packageRoot 'templates\AGENTS.kether.md') -Raw
foreach ($link in [regex]::Matches($policy, '\]\((agent-references/[^)]+)\)')) {
  Check (Test-Path -LiteralPath (Join-Path $packageRoot ('templates/' + $link.Groups[1].Value)) -PathType Leaf) ('policy reference: ' + $link.Groups[1].Value)
}
Check ($policy.Contains('../.agents/skills/kether-governance/SKILL.md') -and -not $policy.Contains('agent-references/governance.md')) 'direct governance skill entrypoint'
Check ($policy.Contains('agent-references/headless-cli.md')) 'headless CLI trigger in Codex index'
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
  $baselineHashes = @{}
  $baselineValid = $false
  try {
    $baselinePath = Join-Path $TargetHome '.codex/yhwh-managed-hashes.json'
    $baseline = Get-Content -LiteralPath $baselinePath -Raw | ConvertFrom-Json -ErrorAction Stop
    if ($baseline.schemaVersion -eq 1 -and $baseline.files -is [pscustomobject]) {
      $baselineValid = $true
      foreach ($property in $baseline.files.PSObject.Properties) {
        if ([string]$property.Value -notmatch '\A[0-9a-fA-F]{64}\z') { $baselineValid = $false; break }
        $baselineHashes[$property.Name] = [string]$property.Value
      }
    }
  } catch { $baselineValid = $false }
  if (-not $baselineValid) { $baselineHashes = @{} }
  function Get-ArtifactHash([string]$Path, [switch]$ManagedBlock) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    if ($ManagedBlock) {
      $text = [IO.File]::ReadAllText($Path)
      $match = [regex]::Match($text, '(?s)<!-- PI-KETHER:BEGIN -->.*?<!-- PI-KETHER:END -->')
      if (-not $match.Success) {
        $template = [IO.File]::ReadAllText($Path)
        $block = "<!-- PI-KETHER:BEGIN -->`r`n$($template.TrimEnd())`r`n<!-- PI-KETHER:END -->"
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($block)
        return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
      }
      $bytes = [Text.UTF8Encoding]::new($false).GetBytes($match.Value)
      return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  function Report-ArtifactDrift([string]$Key, [string]$SourcePath, [string]$InstalledPath, [switch]$ManagedBlock) {
    $sourceHash = Get-ArtifactHash $SourcePath -ManagedBlock:$ManagedBlock
    $installedHash = Get-ArtifactHash $InstalledPath -ManagedBlock:$ManagedBlock
    $baselineHash = if ($baselineValid -and $baselineHashes.ContainsKey($Key)) { $baselineHashes[$Key] } else { $null }
    $kind = Get-HostWorkflowDriftKind -SourceHash $sourceHash -InstalledHash $installedHash -BaselineHash $baselineHash
    Write-Host "[DRIFT] $kind $Key" -ForegroundColor Yellow
  }
  $plugin = Join-Path $TargetHome 'plugins\pi-dispatch'
  Check (Test-Path -LiteralPath (Join-Path $plugin 'node_modules\@modelcontextprotocol\sdk')) 'plugin dependencies installed'
  $piEntry = Join-Path $TargetHome '.pi\agent\npm\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js'
  Check (Test-Path -LiteralPath $piEntry -PathType Leaf) 'host Pi entry installed'
  $installedCatalog = Join-Path $plugin 'workflow\catalog.json'
  $sourceCatalog = Join-Path $payloadPlugin 'workflow\catalog.json'
  $catalogParity = (Test-Path -LiteralPath $installedCatalog -PathType Leaf) -and ((Get-FileHash -LiteralPath $sourceCatalog -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $installedCatalog -Algorithm SHA256).Hash)
  Check $catalogParity 'host-neutral workflow catalog installed'
  if (-not $catalogParity) { Report-ArtifactDrift 'plugins/pi-dispatch/workflow/catalog.json' $sourceCatalog $installedCatalog }
  if($Hosts -contains 'codex'){
  $installedPluginManifest = Join-Path $TargetHome 'plugins\pi-dispatch\.codex-plugin\plugin.json'
  $pluginManifestParity = (Test-Path -LiteralPath $installedPluginManifest -PathType Leaf) -and ((Get-FileHash -LiteralPath $pluginManifestPath -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $installedPluginManifest -Algorithm SHA256).Hash)
  Check $pluginManifestParity 'installed plugin manifest parity'
  if (-not $pluginManifestParity) { Report-ArtifactDrift 'plugins/pi-dispatch/.codex-plugin/plugin.json' $pluginManifestPath $installedPluginManifest }
  $agentsInstalled = Join-Path $TargetHome '.codex\AGENTS.md'
  Check (Test-Path -LiteralPath $agentsInstalled -PathType Leaf) 'Kether policy installed'
  if (Test-Path -LiteralPath $agentsInstalled -PathType Leaf) {
    $agentsText = [IO.File]::ReadAllText($agentsInstalled)
    $markers = [regex]::Match($agentsText, '(?s)<!-- PI-KETHER:BEGIN -->\s*(.*?)\s*<!-- PI-KETHER:END -->')
    $normalize = { param($text) ([string]$text -replace "`r`n|`r|`n", "`n").Trim() }
    $expectedBlock = & $normalize $policy
    $actualBlock = if ($markers.Success) { & $normalize $markers.Groups[1].Value } else { '' }
    $agentsParity = $markers.Success -and $actualBlock -ceq $expectedBlock
    Check $agentsParity 'managed Codex policy block parity'
    if (-not $agentsParity) { Report-ArtifactDrift '.codex/AGENTS.md#PI-KETHER' (Join-Path $packageRoot 'templates/AGENTS.kether.md') $agentsInstalled -ManagedBlock }
  }
  $referenceSource = Join-Path $packageRoot 'templates\agent-references'
  if (Test-Path -LiteralPath $referenceSource -PathType Container) {
    foreach ($reference in Get-ChildItem -LiteralPath $referenceSource -File -Filter '*.md') {
      $installedReference = Join-Path $TargetHome ('.codex\agent-references\' + $reference.Name)
      $matches = (Test-Path -LiteralPath $installedReference -PathType Leaf) -and ((Get-FileHash -LiteralPath $reference.FullName -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $installedReference -Algorithm SHA256).Hash)
      Check $matches ('installed policy reference parity: ' + $reference.Name)
      if (-not $matches) { Report-ArtifactDrift ('.codex/agent-references/' + $reference.Name) $reference.FullName $installedReference }
    }
    $retiredGovernanceReference = Join-Path $TargetHome '.codex\agent-references\governance.md'
    $sourceGovernanceReference = Join-Path $referenceSource 'governance.md'
    Check ((-not (Test-Path -LiteralPath $sourceGovernanceReference -PathType Leaf)) -and (-not (Test-Path -LiteralPath $retiredGovernanceReference))) 'retired governance reference absent from installed references'
  } else { Check $false 'installed policy references source directory' }
  $workflowSource = Join-Path $packageRoot 'payload\workflow-skills'
  if (Test-Path -LiteralPath $workflowSource -PathType Container) {
    $workflowSkills = Get-ChildItem -LiteralPath $workflowSource -Directory
    $governanceSkill = $workflowSkills | Where-Object { $_.Name -eq 'kether-governance' } | Select-Object -First 1
    if ($governanceSkill) {
      $sourceFiles = @(Get-ChildItem -LiteralPath $governanceSkill.FullName -File -Recurse)
      foreach ($sourceFile in $sourceFiles) {
        $relative = [IO.Path]::GetRelativePath($governanceSkill.FullName, $sourceFile.FullName)
        $installedFile = Join-Path (Join-Path $TargetHome '.agents\skills\kether-governance') $relative
        $matches = (Test-Path -LiteralPath $installedFile -PathType Leaf) -and ((Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $installedFile -Algorithm SHA256).Hash)
        Check $matches ('installed managed skill parity: kether-governance/' + $relative)
        if (-not $matches) { Report-ArtifactDrift ('.agents/skills/kether-governance/' + $relative.Replace('\\','/')) $sourceFile.FullName $installedFile }
      }
    } else { Check $false 'kether-governance source skill exists' }
    foreach ($retiredSkill in @($workflowSkills | Where-Object { $_.Name -ne 'kether-governance' })) {
      $installedRetiredSkill = Join-Path (Join-Path $TargetHome '.agents\skills') $retiredSkill.Name
      Check (-not (Test-Path -LiteralPath $installedRetiredSkill)) ('retired YHWH skill absent from installed skills: ' + $retiredSkill.Name)
    }
  } else { Check $false 'installed managed workflow skills source directory' }
  }
  $activePiSkill = Join-Path $TargetHome 'plugins\pi-dispatch\skills\pi-dispatch\SKILL.md'
  $sourcePiSkill = Join-Path $payloadPlugin 'skills\pi-dispatch\SKILL.md'
  $piSkillMatches = (Test-Path -LiteralPath $sourcePiSkill -PathType Leaf) -and (Test-Path -LiteralPath $activePiSkill -PathType Leaf) -and ((Get-FileHash -LiteralPath $sourcePiSkill -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $activePiSkill -Algorithm SHA256).Hash)
  Check $piSkillMatches 'active Pi pi-dispatch skill parity'
  if (-not $piSkillMatches) { Report-ArtifactDrift 'plugins/pi-dispatch/skills/pi-dispatch/SKILL.md' $sourcePiSkill $activePiSkill }
  if ($Hosts -contains 'codex' -and (Test-Path -LiteralPath (Join-Path $TargetHome '.agents\skills\hindsight-coding-agent\SKILL.md') -PathType Leaf)) {
    try {
      & (Join-Path $packageRoot 'install\Apply-HindsightWrapper.ps1') -TargetHome $TargetHome -Check | Out-Null
      Check $true 'optional Hindsight wrapper parity'
    } catch { Check $false 'optional Hindsight wrapper parity' }
  }
  $hostState=Get-Content -LiteralPath (Join-Path $TargetHome '.local\state\pi-kether\installation-hosts.json') -Raw|ConvertFrom-Json
  foreach($hostId in $Hosts){Check (Test-Path -LiteralPath (Join-Path $hostState.profiles "$hostId/connection.json")) ("host profile: $hostId")}
  try {
    $mcp = Get-Content -LiteralPath (Join-Path $plugin '.mcp.json') -Raw | ConvertFrom-Json
    Check ([bool]$mcp.mcpServers.'pi-kether-gateway'.env.PI_GATEWAY_ROOTS) 'MCP workspace scope configured'
    Check ($mcp.mcpServers.'pi-kether-gateway'.env.PI_DISPATCH_PI_ENTRY -eq $piEntry) 'MCP resolves the installed host Pi entry'
  } catch { Check $false 'MCP workspace scope configured' }
  if (-not $SkipWsl) {
    & wsl.exe -d $WslDistro -u root --exec test -f /opt/pi-kether/extensions/role-presets.js
    Check ($LASTEXITCODE -eq 0) 'WSL role presets extension installed'
    & wsl.exe -d $WslDistro -u root --exec test -f /opt/pi-kether/extensions/source-window.js
    Check ($LASTEXITCODE -eq 0) 'WSL source-window extension installed'
    & wsl.exe -d $WslDistro -u root --exec /opt/node/bin/node --check /opt/pi-kether/extensions/source-window.js
    Check ($LASTEXITCODE -eq 0) 'WSL source-window ES module parses'
    $probe = & wsl.exe -d $WslDistro -u root -- /usr/local/libexec/pi-kether-sandbox --probe
    $probeObject = try { $probe | ConvertFrom-Json } catch { $null }
    Check ($LASTEXITCODE -eq 0 -and $probeObject.ok -eq $true -and $probeObject.resourceLimits -eq $true) 'WSL isolation and cgroup resource limits'
    & wsl.exe -d $WslDistro -u root --exec sh -c 'export PATH=/opt/node/bin:/opt/pi-kether/node_modules/.bin:/usr/local/bin:/usr/bin:/bin; for tool in pyright-langserver typescript-language-server clangd jdtls csharp-ls; do command -v "$tool" >/dev/null || exit 1; done'
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
