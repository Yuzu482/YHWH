[CmdletBinding()]
param(
  [string]$ConfigFile,
  [string[]]$WorkspaceRoots,
  [string[]]$Hosts,
  [string]$WslDistro,
  [switch]$SkipWsl,
  [switch]$SkipTunnel,
  [switch]$AllowDistroHardening,
  [switch]$PlanOnly,
  [switch]$Force,
  [string]$TargetHome = $HOME,
  [switch]$SkipCodexRegistration
)

$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
$payload = Join-Path $packageRoot 'payload'
$manifest = Get-Content -LiteralPath (Join-Path $packageRoot 'portable.manifest.json') -Raw | ConvertFrom-Json

function Say([string]$Text) { Write-Host "[Pi Kether] $Text" }
function Assert-Under([string]$Path, [string]$Root) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $base = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  if ($full -ne $base -and -not $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing path outside target home: $full"
  }
}
function Read-Config {
  if (-not $ConfigFile) { return $null }
  $resolved = (Resolve-Path -LiteralPath $ConfigFile).Path
  & (Join-Path $PSScriptRoot 'Read-WorkflowConfig.ps1') -ConfigFile $resolved
}
function Copy-WithBackup([string]$Source, [string]$Destination, [string]$BackupRoot) {
  Assert-Under $Destination $TargetHome
  if (Test-Path -LiteralPath $Destination) {
    $relative = [IO.Path]::GetRelativePath([IO.Path]::GetFullPath($TargetHome), [IO.Path]::GetFullPath($Destination))
    $backup = Join-Path $BackupRoot $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backup) | Out-Null
    Move-Item -LiteralPath $Destination -Destination $backup
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}
function Copy-ToWsl([string]$LocalPath, [string]$RemotePath) {
  $bytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $LocalPath))
  $encoded = [Convert]::ToBase64String($bytes)
  $encoded | & wsl.exe -d $script:WslName -u root -- sh -c "base64 -di > '$RemotePath'"
  if ($LASTEXITCODE -ne 0) { throw "Failed to transfer $LocalPath to WSL" }
}
function Set-ManagedAgents([string]$Path, [string]$Template) {
  $begin = '<!-- PI-KETHER:BEGIN -->'; $end = '<!-- PI-KETHER:END -->'
  $old = if (Test-Path -LiteralPath $Path) { Get-Content -LiteralPath $Path -Raw } else { '' }
  $escapedBegin = [regex]::Escape($begin); $escapedEnd = [regex]::Escape($end)
  $old = [regex]::Replace($old, "(?s)\r?\n?$escapedBegin.*?$escapedEnd\r?\n?", "`r`n")
  $block = "$begin`r`n$Template`r`n$end`r`n"
  $new = if ([string]::IsNullOrWhiteSpace($old)) { $block } else { $old.TrimEnd() + "`r`n`r`n" + $block }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [IO.File]::WriteAllText($Path, $new, [Text.UTF8Encoding]::new($false))
}

$config = Read-Config
if(-not $Hosts){$Hosts=if($config.hosts){@($config.hosts)}else{@('codex')}}
foreach($hostId in $Hosts){if($hostId -notin @('generic','codex','cherry-studio','opencode','opencode-v2','claude-code','claude-desktop','deepseek-harness','cursor','vscode-copilot','windsurf','cline','roo-code','gemini-cli','kiro','zed','continue','lm-studio')){throw "Unknown host: $hostId"}}
if (@($Hosts | Select-Object -Unique).Count -ne $Hosts.Count) { throw 'Choose unique host IDs.' }
$installCodex=$Hosts -contains 'codex'
if (-not $WorkspaceRoots -and $config.workspaceRoots) { $WorkspaceRoots = @($config.workspaceRoots) }
if (-not $WslDistro) { $WslDistro = if ($config.wslDistro) { $config.wslDistro } else { 'Ubuntu-24.04' } }
$script:WslName = $WslDistro
$installWsl = -not $SkipWsl -and ($null -eq $config -or $config.installWsl -ne $false)
$harden = $AllowDistroHardening -or ($config.allowDistroHardening -eq $true)
$installTunnel = -not $SkipTunnel -and ($config.installTunnel -eq $true)

if (-not $WorkspaceRoots -or $WorkspaceRoots.Count -eq 0) { throw 'At least one workspaceRoots entry is required.' }
$roots = foreach ($root in $WorkspaceRoots) {
  if (-not [IO.Path]::IsPathFullyQualified($root) -or -not (Test-Path -LiteralPath $root -PathType Container)) { throw "Workspace root must be an existing absolute directory: $root" }
  (Resolve-Path -LiteralPath $root).Path
}
if ($installWsl -and -not $harden) { throw 'The sandbox requires a dedicated WSL distro with automount and Windows interop disabled. Set allowDistroHardening=true or use -AllowDistroHardening.' }
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Node.js 22 or newer is required on Windows.' }
$nodePath = (Get-Command node.exe).Source
$nodeMajor = [int]((& $nodePath --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw 'Node.js 22 or newer is required on Windows.' }

$pluginSource = Join-Path $payload 'pi-dispatch'
$templatePath = Join-Path $packageRoot 'templates\AGENTS.kether.md'
$referencesSource = Join-Path $packageRoot 'templates\agent-references'
foreach ($required in @($pluginSource, $templatePath, $referencesSource, (Join-Path $packageRoot 'install\patch-pi-lsp.mjs'))) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Package is incomplete: $required" }
}

Say "Target home: $TargetHome"
Say "Workspace roots: $($roots -join ', ')"
Say "WSL sandbox: $installWsl ($WslDistro)"
Say "Secure MCP Tunnel: $installTunnel"
Say "Primary host profiles: $($Hosts -join ', ')"
if ($installTunnel) {
  foreach ($key in @('tunnelId','tunnelRuntimeKeyFile','tunnelClientPath')) {
    if ([string]::IsNullOrWhiteSpace([string]$config.$key)) { throw "Tunnel configuration requires $key." }
  }
  foreach ($key in @('tunnelRuntimeKeyFile','tunnelClientPath')) {
    if (-not [IO.Path]::IsPathFullyQualified($config.$key) -or -not (Test-Path -LiteralPath $config.$key -PathType Leaf)) { throw "Tunnel $key must reference an existing absolute file path." }
  }
}
if ($PlanOnly) { Say 'Plan validated; no changes made.'; exit 0 }

if($installCodex){
  $configToml = Join-Path $TargetHome '.codex\config.toml'
  $tomlText = if (Test-Path -LiteralPath $configToml) { Get-Content -LiteralPath $configToml -Raw } else { '' }
  $updatedToml = & (Join-Path $PSScriptRoot 'Set-CodexFeatures.ps1') -Text $tomlText
}

# Fail before changing host files if the requested sandbox cannot be reached.
if ($installWsl) {
  $distros = @((& wsl.exe --list --quiet) -replace "`0", '' | ForEach-Object { $_.Trim() })
  if ($LASTEXITCODE -ne 0 -or $distros -notcontains $WslDistro) { throw "WSL distro '$WslDistro' is not available." }
  & wsl.exe -d $WslDistro -u root -- true
  if ($LASTEXITCODE -ne 0) { throw 'WSL cannot start. Host files were not changed.' }
}

New-Item -ItemType Directory -Force -Path $TargetHome | Out-Null
$stateRoot = Join-Path $TargetHome '.local\state\pi-kether'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $stateRoot "installer-backups\$timestamp"
New-Item -ItemType Directory -Force -Path $backupRoot, $stateRoot | Out-Null

$pluginTarget = Join-Path $TargetHome 'plugins\pi-dispatch'
Copy-WithBackup $pluginSource $pluginTarget $backupRoot
Push-Location $pluginTarget
try {
  & (Join-Path (Split-Path -Parent $nodePath) 'npm.cmd') ci --omit=dev --ignore-scripts=false
  if ($LASTEXITCODE -ne 0) { throw 'Plugin dependency installation failed.' }
} finally { Pop-Location }

$auditFile = Join-Path $stateRoot 'audit.jsonl'
$circuitFile = Join-Path $stateRoot 'provider-circuit.jsonl'
$ledgerDir = Join-Path $stateRoot 'request-ledger'
New-Item -ItemType Directory -Force -Path $ledgerDir | Out-Null
$mcp = [ordered]@{ mcpServers = [ordered]@{ 'pi-kether-gateway' = [ordered]@{
  command = $nodePath
  args = @((Join-Path $pluginTarget 'scripts\stdio-server.mjs'))
  env = [ordered]@{
    PATH = ((Split-Path -Parent $nodePath) + ';' + $env:PATH)
    PI_DISPATCH_PI_ENTRY = (Join-Path $TargetHome '.pi\agent\npm\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js')
    PI_GATEWAY_ROOTS = (ConvertTo-Json -InputObject @($roots) -Compress)
    PI_GATEWAY_AUDIT_FILE = $auditFile
    PI_GATEWAY_PROVIDER_CIRCUIT_FILE = $circuitFile
    PI_GATEWAY_REQUEST_LEDGER_DIR = $ledgerDir
    PI_DISPATCH_SANDBOX = 'wsl2-bwrap'
    PI_SANDBOX_DISTRO = $WslDistro
  }
  enabled = $true
  enabled_tools = @('get_workflow','list_capabilities','dispatch_subagent','submit_subagent','get_subagent_status','get_subagent_result','list_subagents','cancel_subagent','render_subagent_monitor','probe_model','lsp_request','check_claude_auth')
  startup_timeout_sec = 30
}}}
$mcp | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $pluginTarget '.mcp.json') -Encoding utf8NoBOM
if ($installTunnel) {
  # Native Codex UI and Tunnel must observe the same monitor and scheduler.
  $mcp.mcpServers.'pi-kether-gateway'.env.PI_GATEWAY_CONFIG = Join-Path $stateRoot 'gateway-silent.json'
  $mcp | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $pluginTarget '.mcp.json') -Encoding utf8NoBOM
}

$hostPiRoot = Join-Path $TargetHome '.pi\agent\npm'
New-Item -ItemType Directory -Force -Path $hostPiRoot | Out-Null
$hostPackage = [ordered]@{ private = $true; dependencies = [ordered]@{
  '@earendil-works/pi-coding-agent' = $manifest.components.piCodingAgent
  'pi-lsp-extension' = $manifest.components.piLspExtension
  pyright = $manifest.components.pyright
  'typescript-language-server' = $manifest.components.typescriptLanguageServer
  typescript = $manifest.components.typescript
  'typescript-lsp' = "npm:typescript@$($manifest.components.typescriptLsp)"
  'vscode-languageserver-protocol' = '3.17.5'
}}
$hostPackage | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $hostPiRoot 'package.json') -Encoding utf8NoBOM
Copy-Item -LiteralPath (Join-Path $payload 'wsl-package-lock.json') -Destination (Join-Path $hostPiRoot 'package-lock.json') -Force
Push-Location $hostPiRoot
try {
  & (Join-Path (Split-Path -Parent $nodePath) 'npm.cmd') ci --omit=dev --ignore-scripts=false
  if ($LASTEXITCODE -ne 0) { throw 'Host Pi dependency installation failed.' }
  & $nodePath (Join-Path $packageRoot 'install\patch-pi-lsp.mjs') (Join-Path $hostPiRoot 'node_modules\pi-lsp-extension')
  if ($LASTEXITCODE -ne 0) { throw 'Host Pi LSP patch failed.' }
} finally { Pop-Location }

$piSettingsPath = Join-Path $TargetHome '.pi\agent\settings.json'
$piSettings = if (Test-Path -LiteralPath $piSettingsPath) { Get-Content -LiteralPath $piSettingsPath -Raw | ConvertFrom-Json -AsHashtable } else { @{} }
if (Test-Path -LiteralPath $piSettingsPath) { Copy-Item -LiteralPath $piSettingsPath -Destination (Join-Path $backupRoot 'pi-settings.json') }
foreach ($extensionName in @('desktop-monitor','unity','blender')) {
  $extensionPackage = (Join-Path $pluginTarget ('pi-extensions\'+$extensionName)).Replace('\','/')
  if (@($piSettings.packages) -notcontains $extensionPackage) { $piSettings.packages = @($piSettings.packages | Where-Object { $null -ne $_ }) + @($extensionPackage) }
}
$piSettings | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $piSettingsPath -Encoding utf8NoBOM

if($installCodex){
$skillsRoot = Join-Path $TargetHome '.agents\skills'
Get-ChildItem -LiteralPath (Join-Path $payload 'workflow-skills') -Directory | ForEach-Object {
  Copy-WithBackup $_.FullName (Join-Path $skillsRoot $_.Name) $backupRoot
}

$agentsPath = Join-Path $TargetHome '.codex\AGENTS.md'
Get-ChildItem -LiteralPath $referencesSource -File -Filter '*.md' | ForEach-Object {
  Copy-WithBackup $_.FullName (Join-Path $TargetHome ('.codex\agent-references\' + $_.Name)) $backupRoot
}
if (Test-Path -LiteralPath $agentsPath) { Copy-Item -LiteralPath $agentsPath -Destination (Join-Path $backupRoot 'AGENTS.md') -Force }
Set-ManagedAgents $agentsPath (Get-Content -LiteralPath $templatePath -Raw)

$configToml = Join-Path $TargetHome '.codex\config.toml'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $configToml) | Out-Null
if (Test-Path -LiteralPath $configToml) { Copy-Item -LiteralPath $configToml -Destination (Join-Path $backupRoot 'config.toml') -Force }
[IO.File]::WriteAllText($configToml, $updatedToml, [Text.UTF8Encoding]::new($false))

$marketplacePath = Join-Path $TargetHome '.agents\plugins\marketplace.json'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $marketplacePath) | Out-Null
$market = if (Test-Path -LiteralPath $marketplacePath) { Get-Content -LiteralPath $marketplacePath -Raw | ConvertFrom-Json -AsHashtable } else { @{ name='personal'; interface=@{displayName='Personal'}; plugins=@() } }
if (-not $market.plugins) { $market.plugins = @() }
$market.plugins = @($market.plugins | Where-Object { $_.name -ne 'pi-dispatch' }) + @(@{name='pi-dispatch';source=@{source='local';path='./plugins/pi-dispatch'};policy=@{installation='AVAILABLE';authentication='ON_INSTALL'};category='Productivity'})
$market | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $marketplacePath -Encoding utf8NoBOM
}

if ($installWsl) {
  $distros = (& wsl.exe --list --quiet) -replace "`0", ''
  if ($distros -notcontains $WslDistro) { throw "WSL distro '$WslDistro' is not installed. Install Ubuntu 24.04, then rerun." }
  & wsl.exe -d $WslDistro -u root -- sh -c 'mkdir -p /tmp/pi-kether-install && chmod 700 /tmp/pi-kether-install'
  if ($LASTEXITCODE -ne 0) { throw 'Could not initialize WSL provisioning directory.' }
  $transfers = @{
    (Join-Path $packageRoot 'install\provision-wsl.sh')='/tmp/pi-kether-install/provision-wsl.sh'
    (Join-Path $packageRoot 'install\patch-pi-lsp.mjs')='/tmp/pi-kether-install/patch-pi-lsp.mjs'
    (Join-Path $payload 'wsl-package-lock.json')='/tmp/pi-kether-install/wsl-package-lock.json'
    (Join-Path $pluginTarget 'sandbox\pi-kether-sandbox')='/tmp/pi-kether-install/pi-kether-sandbox'
    (Join-Path $pluginTarget 'scripts\validate-write-scope.mjs')='/tmp/pi-kether-install/validate-write-scope.mjs'
    (Join-Path $pluginTarget 'extensions\write-scope-guard.js')='/tmp/pi-kether-install/write-scope-guard.js'
    (Join-Path $pluginTarget 'extensions\auth-scrub.js')='/tmp/pi-kether-install/auth-scrub.js'
    (Join-Path $pluginTarget 'extensions\read-scope-guard.js')='/tmp/pi-kether-install/read-scope-guard.js'
    (Join-Path $payload 'pi-dispatch\extensions\role-presets.js')='/tmp/pi-kether-install/role-presets.js'
    (Join-Path $payload 'pi-dispatch\extensions\result-submit.js')='/tmp/pi-kether-install/result-submit.js'
    (Join-Path $pluginTarget 'scripts\snapshot-scope.py')='/tmp/pi-kether-install/snapshot-scope.py'
    (Join-Path $pluginTarget 'scripts\lsp-result.mjs')='/tmp/pi-kether-install/lsp-result.mjs'
    (Join-Path $pluginTarget 'scripts\prepare-credentials.mjs')='/tmp/pi-kether-install/prepare-credentials.mjs'
    (Join-Path $pluginTarget 'scripts\direct-lsp-bootstrap.mjs')='/tmp/pi-kether-install/direct-lsp-bootstrap.mjs'
    (Join-Path $pluginTarget 'scripts\legacy-structural-bootstrap.mjs')='/tmp/pi-kether-install/legacy-structural-bootstrap.mjs'
    (Join-Path $pluginTarget 'scripts\multilspy-probe.py')='/tmp/pi-kether-install/multilspy-probe.py'
    (Join-Path $payload 'multilspy-requirements.txt')='/tmp/pi-kether-install/multilspy-requirements.txt'
    (Join-Path $pluginTarget 'scripts\secure-pi-bootstrap.mjs')='/tmp/pi-kether-install/secure-pi-bootstrap.mjs'
    (Join-Path $pluginTarget 'scripts\editor-pi-bootstrap.mjs')='/tmp/pi-kether-install/editor-pi-bootstrap.mjs'
    (Join-Path $pluginTarget 'scripts\lsp-sandbox-broker.mjs')='/tmp/pi-kether-install/lsp-sandbox-broker.mjs'
    (Join-Path $pluginTarget 'scripts\csharp-probe-project.mjs')='/tmp/pi-kether-install/csharp-probe-project.mjs'
    (Join-Path $pluginTarget 'scripts\java-probe-launch.py')='/tmp/pi-kether-install/java-probe-launch.py'
    (Join-Path $PSScriptRoot 'provision-go-rust.sh')='/tmp/pi-kether-install/provision-go-rust.sh'
    (Join-Path $pluginTarget 'extensions\lsp-proxy.js')='/tmp/pi-kether-install/lsp-proxy.js'
    (Join-Path $pluginTarget 'scripts\editor-rpc.mjs')='/tmp/pi-kether-install/editor-rpc.mjs'
    (Join-Path $pluginTarget 'extensions\editor-proxy.js')='/tmp/pi-kether-install/editor-proxy.js'
    (Join-Path $pluginTarget 'scripts\accept-api-packet.mjs')='/tmp/pi-kether-install/accept-api-packet.mjs'
    (Join-Path $pluginTarget 'scripts\controlled-provider.mjs')='/tmp/pi-kether-install/controlled-provider.mjs'
    (Join-Path $pluginTarget 'scripts\provider-transport.mjs')='/tmp/pi-kether-install/provider-transport.mjs'
    (Join-Path $pluginTarget 'extensions\controlled-provider.js')='/tmp/pi-kether-install/controlled-provider.js'
    (Join-Path $pluginTarget 'scripts\anthropic-api-credential.mjs')='/tmp/pi-kether-install/anthropic-api-credential.mjs'
  }
  foreach ($pair in $transfers.GetEnumerator()) { Copy-ToWsl $pair.Key $pair.Value }
  & wsl.exe -d $WslDistro -u root -- env PI_KETHER_HARDEN_DISTRO=1 bash /tmp/pi-kether-install/provision-wsl.sh
  if ($LASTEXITCODE -ne 0) { throw 'WSL provisioning failed.' }
  & wsl.exe --terminate $WslDistro
  Start-Sleep -Seconds 2
}

if ($installCodex -and -not $SkipCodexRegistration -and [IO.Path]::GetFullPath($TargetHome) -eq [IO.Path]::GetFullPath($HOME) -and (Get-Command codex.exe -ErrorAction SilentlyContinue)) {
  & codex.exe plugin add pi-dispatch@personal --json | Out-Host
  if ($LASTEXITCODE -ne 0 -and -not $Force) { throw 'Codex plugin registration failed. Rerun with -Force to keep the installed files for manual registration.' }
}

$runtime = Join-Path $stateRoot 'ensure-tunnel.ps1'
if ($installTunnel) {
  $tunnelId = [string]$config.tunnelId; $keyFile = [string]$config.tunnelRuntimeKeyFile; $client = [string]$config.tunnelClientPath
  if (-not $tunnelId -or -not $keyFile -or -not $client) { throw 'Tunnel installation requires tunnelId, tunnelRuntimeKeyFile, and tunnelClientPath.' }
  if (-not (Test-Path -LiteralPath $keyFile -PathType Leaf) -or -not (Test-Path -LiteralPath $client -PathType Leaf)) { throw 'Tunnel key file or client executable does not exist.' }
  $runtime = & (Join-Path $PSScriptRoot 'Configure-SilentRuntime.ps1') -TargetHome $TargetHome -NodePath $nodePath -PluginPath $pluginTarget -Roots @($roots) -WslDistro $WslDistro -TunnelClient $client -TunnelId $tunnelId -RuntimeKeyFile $keyFile
  $pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
  $launcher = Join-Path $stateRoot 'Launch-HiddenPowerShell.vbs'
  $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument "//B //NoLogo `"$launcher`" `"$pwshPath`" `"$runtime`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  Register-ScheduledTask -TaskName 'Pi Kether Secure MCP Tunnel' -Action $action -Trigger $trigger -Description 'Starts the Pi Kether Secure MCP Tunnel runtime silently.' -Force | Out-Null
  & $runtime
}

$hostExports=Join-Path $stateRoot ('host-profiles\'+[guid]::NewGuid().ToString('N'))
& $nodePath (Join-Path $pluginTarget 'scripts\host-profiles.mjs') (Join-Path $pluginTarget '.mcp.json') $hostExports ($Hosts -join ',')
if($LASTEXITCODE -ne 0){throw 'Host profile generation failed.'}
@{hosts=@($Hosts);profiles=$hostExports}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $stateRoot 'installation-hosts.json') -Encoding utf8NoBOM
& (Join-Path $PSScriptRoot 'Protect-PiState.ps1') -TargetHome $TargetHome
& (Join-Path $packageRoot 'install\Test-PiKether.ps1') -Installed -TargetHome $TargetHome -WslDistro $WslDistro -Hosts $Hosts -SkipWsl:$(-not $installWsl)
if ($LASTEXITCODE -ne 0) { throw 'Post-install self-test failed.' }
& $nodePath (Join-Path $pluginTarget 'scripts/plugin-upgrade.mjs') record $pluginSource $pluginTarget
if($LASTEXITCODE -ne 0){throw 'Managed installation baseline could not be recorded.'}
Say "Installation complete. Backup: $backupRoot"
Say 'Sign in with Pi on this Windows account if ~/.pi/agent/auth.json is not already present.'
Say "Import your selected host's connection and PRIMARY-AGENT.md from: $hostExports"
