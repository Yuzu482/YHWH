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
. (Join-Path $PSScriptRoot 'HostRuntimeSecurity.ps1')
. (Join-Path $PSScriptRoot 'HostPolicyPreservation.ps1')

function Say([string]$Text) { Write-Host "[Pi Kether] $Text" }
function Write-HostPackage([string]$Path, $Package) {
  # npm uses package.json's line endings for its generated hidden lockfile.
  # Keep them stable so the reviewed Windows runtime tree digest is portable.
  $json = ($Package | ConvertTo-Json -Depth 5).Replace("`r`n", "`n")
  [IO.File]::WriteAllText($Path, $json + "`n", [Text.UTF8Encoding]::new($false))
}
function Assert-Under([string]$Path, [string]$Root) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $base = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  if ($full -ne $base -and -not $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing path outside target home: $full"
  }
}
function Assert-NoReparse([string]$Path, [string]$Root) {
  Assert-Under $Path $Root
  $base = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $cursor = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  while ($true) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Refusing a link in the Pi installation path: $cursor" }
    if ($cursor -ieq $base) { break }
    $cursor = Split-Path -Parent $cursor
    if (-not $cursor) { throw 'Could not validate Pi installation path.' }
  }
}
function Assert-PiRuntimeContract([string]$Root, $PortableManifest) {
  $version = [string]$PortableManifest.components.piCodingAgent
  if ($version -cne '1.5.1') { throw 'The installer is pinned to Pi 1.5.1; update and revalidate its runtime contract before changing the version.' }
  $lockPath = Join-Path $Root 'payload/wsl-package-lock.json'
  if ((Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne '27887b43d9346d533cf0e7c4fde2d0994cb0e5311cd06c7a3ed253bceeb13389') { throw 'Pi runtime lockfile does not match the verified 1.5.1 installation.' }
  $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json -AsHashtable
  if ($lock.packages[''].dependencies['@earendil-works/pi-coding-agent'] -cne $version -or $lock.packages['node_modules/@earendil-works/pi-coding-agent'].version -cne $version -or $PortableManifest.components.piLspExtension -cne '1.4.0' -or $lock.packages[''].dependencies['pi-lsp-extension'] -cne '1.4.0' -or $lock.packages['node_modules/pi-lsp-extension'].version -cne '1.4.0') { throw 'Pi runtime lockfile version mismatch.' }
  $script = Get-Content -LiteralPath (Join-Path $Root 'install/provision-wsl.sh') -Raw
  $versions = [regex]::Matches($script, '(?m)^PI_VERSION="([^"\r\n]+)"\r?$')
  if ($versions.Count -ne 1 -or $versions[0].Groups[1].Value -cne $version) { throw 'WSL provisioning version differs from the portable manifest.' }
  $lspVersions = [regex]::Matches($script, '(?m)^LSP_VERSION="([^"\r\n]+)"\r?$')
  if ($lspVersions.Count -ne 1 -or $lspVersions[0].Groups[1].Value -cne '1.4.0') { throw 'WSL LSP provisioning version differs from the verified runtime.' }
  foreach ($name in @('sdk-tree-integrity.mjs','check-pi-runtime-tree.mjs','pi-151-home.mjs','stdio-proxy.mjs','lsp-approval-runner.mjs','lsp-approval-state.mjs','lsp-approval-worker.mjs','lsp-change-detector.mjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root ('payload/pi-dispatch/scripts/'+$name)) -PathType Leaf)) { throw "Missing Pi runtime file: $name" }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'install/check-pi-downgrade.py') -PathType Leaf) -or -not $script.Contains('python3 /tmp/pi-kether-install/check-pi-downgrade.py /opt/pi-kether "$PI_VERSION"')) { throw 'WSL Pi downgrade guard is missing.' }
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'install/HostRuntimeSecurity.ps1') -PathType Leaf)) { throw 'Windows Pi security preservation guard is missing.' }
  if (-not $script.Contains('/opt/node/bin/node /tmp/pi-kether-install/check-pi-runtime-tree.mjs /opt/pi-kether/node_modules')) { throw 'WSL runtime replacement integrity guard is missing.' }
  $integrity = Get-Content -LiteralPath (Join-Path $Root 'payload/pi-dispatch/scripts/sdk-tree-integrity.mjs') -Raw
  if (-not $integrity.Contains("PI_151_TREE_SHA256 = '5aa0eecfea8739ee9c805511ac03830906f346e579389600e04dd88ddf318644'") -or -not $script.Contains('sdkTreeDigest("/opt/pi-kether/node_modules") !== PI_151_TREE_SHA256')) { throw 'Pi 1.5.1 integrity policy is missing or inconsistent.' }
}
function Compare-ToPinnedRuntimeVersion([string]$Value, [int[]]$Pinned, [string]$Component) {
  $match=[regex]::Match($Value,'^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$')
  if(-not $match.Success){throw "Existing $Component version cannot be safely classified; refusing replacement."}
  if($match.Groups[4].Success){foreach($identifier in $match.Groups[4].Value.Split('.')){if($identifier -cmatch '^0[0-9]+$'){throw "Existing $Component version cannot be safely classified; refusing replacement."}}}
  for($i=0;$i -lt 3;$i++){$part=[long]$match.Groups[$i+1].Value;if($part -gt $Pinned[$i]){return 1};if($part -lt $Pinned[$i]){return -1}}
  if($match.Groups[4].Success){return -1}
  return 0
}
function Compare-ToPinnedPiVersion([string]$Value) { return Compare-ToPinnedRuntimeVersion $Value @(1,5,1) 'Pi' }
function Compare-ToPinnedLspVersion([string]$Value) { return Compare-ToPinnedRuntimeVersion $Value @(1,4,0) 'LSP' }
function Get-HostPiMode([string]$Root, [string]$NodePath, [string]$IntegrityModule, [string]$TargetRoot) {
  Assert-NoReparse $Root $TargetRoot
  if (-not (Test-Path -LiteralPath $Root)) { return 'install' }
  $packagePath = Join-Path $Root 'package.json'; $modules = Join-Path $Root 'node_modules'
  if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf) -or -not (Test-Path -LiteralPath $modules -PathType Container)) {
    if (@(Get-ChildItem -LiteralPath $Root -Force).Count -eq 0) { return 'install' }
    throw 'Existing Pi npm directory is incomplete; preserve it and reconcile before reinstalling.'
  }
  Assert-NoReparse $modules $TargetRoot
  Assert-NoReparse $packagePath $TargetRoot
  Assert-NoReparse (Join-Path $Root 'package-lock.json') $TargetRoot
  $existing = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json -AsHashtable
  if ($existing.dependencies -isnot [System.Collections.IDictionary]) { throw 'Existing Pi dependencies cannot be safely classified.' }
  $declaredPi=$existing.dependencies['@earendil-works/pi-coding-agent']
  $versions=@();if($null -ne $declaredPi){$versions+=@([string]$declaredPi)}
  $installedPi=Join-Path $modules '@earendil-works/pi-coding-agent/package.json'
  Assert-NoReparse $installedPi $TargetRoot
  if(Test-Path -LiteralPath $installedPi -PathType Leaf){
    try{$versions+=@([string]((Get-Content -LiteralPath $installedPi -Raw | ConvertFrom-Json).version))}catch{throw 'Existing Pi version cannot be safely classified; refusing replacement.'}
  }
  if ($versions.Count -eq 0) { throw 'Existing Pi version cannot be safely classified; refusing replacement.' }
  foreach($existingVersion in $versions){if((Compare-ToPinnedPiVersion $existingVersion) -gt 0){throw 'Existing Pi is newer than 1.5.1; refusing to downgrade.'}}
  $declaredLsp=$existing.dependencies['pi-lsp-extension']
  $installedLsp=Join-Path $modules 'pi-lsp-extension/package.json'
  Assert-NoReparse $installedLsp $TargetRoot
  $lspVersions=@();if($null -ne $declaredLsp){$lspVersions+=@([string]$declaredLsp)}
  $actualLsp=$null
  if(Test-Path -LiteralPath $installedLsp -PathType Leaf){
    try{$actualLsp=[string]((Get-Content -LiteralPath $installedLsp -Raw | ConvertFrom-Json).version);$lspVersions+=@($actualLsp)}catch{throw 'Existing LSP version cannot be safely classified; refusing replacement.'}
  }
  foreach($existingVersion in $lspVersions){if((Compare-ToPinnedLspVersion $existingVersion) -gt 0){throw 'Existing LSP is newer than 1.4.0; refusing to downgrade.'}}
  if (($null -ne $declaredLsp -and $null -eq $actualLsp) -or ($null -eq $declaredLsp -and $null -ne $actualLsp) -or ($declaredPi -ceq '1.5.1' -and $null -eq $actualLsp)) { throw 'Existing LSP metadata is incomplete; preserve it and reconcile before reinstalling.' }
  $managed = @('@earendil-works/pi-coding-agent','pi-lsp-extension','pyright','typescript-language-server','typescript','typescript-lsp','vscode-languageserver-protocol')
  $extras = @($existing.dependencies.Keys | Where-Object { $_ -cnotin $managed })
  $otherPackageFields = @($existing.Keys | Where-Object { $_ -cnotin @('name','version','private','dependencies') })
  $otherFiles = @(Get-ChildItem -LiteralPath $Root -Force | Where-Object { $_.Name -cnotin @('package.json','package-lock.json','node_modules') })
  $existingLockValid = $false
  try {
    $existingLock = Get-Content -LiteralPath (Join-Path $Root 'package-lock.json') -Raw | ConvertFrom-Json -AsHashtable
    $entry = $existingLock.packages['node_modules/@earendil-works/pi-coding-agent']
    $existingLockValid = $existingLock.packages[''].dependencies['@earendil-works/pi-coding-agent'] -ceq '1.5.1' -and $entry.version -ceq '1.5.1' -and $entry.integrity -ceq 'sha512-rdu4pRvpQba2ep83nqHaN8L1pvY1OQ3i/2FucogA/eyRxwoUXMUXdk1Z9JnZFJR+9ck9Gs1ajuSb9m7Hz7ejYw=='
  } catch {}
  if ($existing.dependencies['@earendil-works/pi-coding-agent'] -ceq '1.5.1' -and $existingLockValid) {
    $program = 'import {pathToFileURL} from "node:url";const m=await import(pathToFileURL(process.argv[1]).href);console.log(m.sdkTreeDigest(process.argv[2]));'
    $digest = & $NodePath --input-type=module -e $program $IntegrityModule $modules
    $lspLock=$existingLock.packages['node_modules/pi-lsp-extension']
    $newLspLockValid=$existingLock.packages[''].dependencies['pi-lsp-extension'] -ceq '1.4.0' -and $lspLock.version -ceq '1.4.0' -and $lspLock.integrity -ceq 'sha512-FOwGIivoZt5YfVY/LGqQZf4+wPXT+73loKOQ3Lu6zeG2UAPCxelHT21zXG/qCVD32epq8FymH9dJ8EnotXkv4Q=='
    if ($LASTEXITCODE -eq 0 -and "$digest".Trim() -ceq '06553e705863995121e0a2ad624d61e73b1f773b40a9f12385155e6d548cc4ff' -and $declaredLsp -ceq '1.4.0' -and $actualLsp -ceq '1.4.0' -and $newLspLockValid) { return 'reuse' }
    if ($LASTEXITCODE -ne 0 -or "$digest".Trim() -cnotin @('10b288d4cd2826a8e77520dfbe4e47d29c086c3c85a81bd470a0100c0f49e428','3999ad68f0bab3a9de545a7f286684f9c313d5f38172b6a6f9c8d3558eeb08ee')) { throw 'Existing Pi 1.5.1 has an unrecognized dependency tree; preserve it and reconcile before reinstalling.' }
  }
  elseif ($declaredPi -ceq '1.5.1') { throw 'Existing Pi 1.5.1 lock is unrecognized; preserve it and reconcile before reinstalling.' }
  if ($extras.Count -or $otherPackageFields.Count -or $otherFiles.Count) { throw 'Existing Pi has custom dependencies or files and an unrecognized tree; preserve it and reconcile before reinstalling.' }
  return 'replace'
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
Assert-PiRuntimeContract $packageRoot $manifest

$pluginSource = Join-Path $payload 'pi-dispatch'
$pluginIdentity = & (Join-Path $PSScriptRoot 'Get-PluginBuildIdentity.ps1') -PackageRoot $packageRoot
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

$hostPiRoot = Join-Path $TargetHome '.pi\agent\npm'
$hostPiMode = Get-HostPiMode $hostPiRoot $nodePath (Join-Path $pluginSource 'scripts/sdk-tree-integrity.mjs') $TargetHome
# Validate before changing the target; local sharing does not depend on Tunnel.
$stateRoot = Join-Path $TargetHome '.local\state\pi-kether'
$pluginTarget = Join-Path $TargetHome 'plugins\pi-dispatch'
$sharedConnection = & (Join-Path $PSScriptRoot 'Get-SharedGatewayConnection.ps1') -NodePath $nodePath -PluginTarget $pluginTarget -StateRoot $stateRoot -Roots @($roots) -PiEntry (Join-Path $TargetHome '.pi\agent\npm\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js') -WslDistro $WslDistro -ConfigurationWillBeCreated:$installTunnel
$reusePlugin=$false
if(Test-Path -LiteralPath $pluginTarget){
  Assert-NoReparse $pluginTarget $TargetHome
  $expectedMcp=[ordered]@{mcpServers=[ordered]@{'pi-kether-gateway'=$sharedConnection}} | ConvertTo-Json -Depth 20 -Compress
  $expectedMcp | & $nodePath (Join-Path $PSScriptRoot 'assert-existing-plugin.mjs') $pluginSource $pluginTarget $pluginIdentity.sourceCommit $pluginIdentity.pluginVersion
  if($LASTEXITCODE -ne 0){throw 'Existing Pi plugin cannot be safely replaced; preserve it and reconcile before reinstalling.'}
  $reusePlugin=$true
}

# Existing security descriptors must not be silently hardened or inherited into
# a different runtime during an upgrade. New paths are protected after install.
& (Join-Path $PSScriptRoot 'Protect-PiState.ps1') -TargetHome $TargetHome -CheckOnly

if($installCodex){
  $policyReuse=Assert-HostPolicyPreserved $TargetHome $packageRoot
  $configToml = Join-Path $TargetHome '.codex\config.toml'
  $tomlText = if (Test-Path -LiteralPath $configToml) { Get-Content -LiteralPath $configToml -Raw } else { '' }
  $updatedToml = if($policyReuse.reuseConfig){$tomlText}else{& (Join-Path $PSScriptRoot 'Set-CodexFeatures.ps1') -Text $tomlText}
}

# Fail before changing host files if the requested sandbox cannot be reached.
if ($installWsl) {
  $distros = @((& wsl.exe --list --quiet) -replace "`0", '' | ForEach-Object { $_.Trim() })
  if ($LASTEXITCODE -ne 0 -or $distros -notcontains $WslDistro) { throw "WSL distro '$WslDistro' is not available." }
  & wsl.exe -d $WslDistro -u root -- true
  if ($LASTEXITCODE -ne 0) { throw 'WSL cannot start. Host files were not changed.' }
}

New-Item -ItemType Directory -Force -Path $TargetHome | Out-Null
# Prepare and validate the new runtime before changing the plugin or moving an
# existing installation. A security mismatch leaves the old runtime intact.
$preparedPi=$null
if($hostPiMode -ne 'reuse'){
  $hostParent=Split-Path -Parent $hostPiRoot
  Assert-NoReparse $hostParent $TargetHome
  New-Item -ItemType Directory -Force -Path $hostParent | Out-Null
  $preparedPi=Join-Path $hostParent ('.npm-stage-'+[guid]::NewGuid().ToString('N'))
  Assert-NoReparse $preparedPi $TargetHome
  if(Test-Path -LiteralPath $preparedPi){throw 'Prepared Pi runtime destination already exists.'}
  New-Item -ItemType Directory -Path $preparedPi | Out-Null
  $hostPackage = [ordered]@{ private = $true; dependencies = [ordered]@{
    '@earendil-works/pi-coding-agent' = $manifest.components.piCodingAgent
    'pi-lsp-extension' = $manifest.components.piLspExtension
    pyright = $manifest.components.pyright
    'typescript-language-server' = $manifest.components.typescriptLanguageServer
    typescript = $manifest.components.typescript
    'typescript-lsp' = "npm:typescript@$($manifest.components.typescriptLsp)"
    'vscode-languageserver-protocol' = '3.17.5'
  }}
  Write-HostPackage (Join-Path $preparedPi 'package.json') $hostPackage
  Copy-Item -LiteralPath (Join-Path $payload 'wsl-package-lock.json') -Destination (Join-Path $preparedPi 'package-lock.json')
  Push-Location $preparedPi
  try {
    & (Join-Path (Split-Path -Parent $nodePath) 'npm.cmd') ci --omit=dev --ignore-scripts=false
    if ($LASTEXITCODE -ne 0) { throw 'Host Pi dependency installation failed.' }
    & $nodePath (Join-Path $packageRoot 'install\patch-pi-lsp.mjs') (Join-Path $preparedPi 'node_modules\pi-lsp-extension')
    if ($LASTEXITCODE -ne 0) { throw 'Host Pi LSP patch failed.' }
    $program='import {pathToFileURL} from "node:url";const m=await import(pathToFileURL(process.argv[1]).href);if(m.sdkTreeDigest(process.argv[2])!=="06553e705863995121e0a2ad624d61e73b1f773b40a9f12385155e6d548cc4ff")throw Error("Windows Pi runtime integrity mismatch");'
    & $nodePath --input-type=module -e $program (Join-Path $pluginSource 'scripts/sdk-tree-integrity.mjs') (Join-Path $preparedPi 'node_modules')
    if ($LASTEXITCODE -ne 0) { throw 'Host Pi dependency tree does not match the verified runtime.' }
  } finally { Pop-Location }
  if(Test-Path -LiteralPath $hostPiRoot){Assert-HostRuntimeSecurityPreserved $hostPiRoot $preparedPi $TargetHome}
}
$stateRoot = Join-Path $TargetHome '.local\state\pi-kether'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $stateRoot "installer-backups\$timestamp"
New-Item -ItemType Directory -Force -Path $backupRoot, $stateRoot | Out-Null

$pluginTarget = Join-Path $TargetHome 'plugins\pi-dispatch'
$installationSource=$null
if($reusePlugin){
  Say 'Existing verified plugin and gateway rules retained without rewriting.'
} else {
  $installationSource = & (Join-Path $PSScriptRoot 'Stage-InstalledPlugin.ps1') -PackageRoot $packageRoot -Destination (Join-Path $backupRoot 'installation-source')
  Copy-WithBackup $installationSource $pluginTarget $backupRoot
  Push-Location $pluginTarget
  try {
    & (Join-Path (Split-Path -Parent $nodePath) 'npm.cmd') ci --omit=dev --ignore-scripts=false
    if ($LASTEXITCODE -ne 0) { throw 'Plugin dependency installation failed.' }
  } finally { Pop-Location }
}

$auditFile = Join-Path $stateRoot 'audit.jsonl'
$circuitFile = Join-Path $stateRoot 'provider-circuit.jsonl'
$ledgerDir = Join-Path $stateRoot 'request-ledger'
New-Item -ItemType Directory -Force -Path $ledgerDir | Out-Null
$mcp = [ordered]@{ mcpServers = [ordered]@{ 'pi-kether-gateway' = $sharedConnection }}

if(-not $reusePlugin){$mcp | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $pluginTarget '.mcp.json') -Encoding utf8NoBOM}

if ($hostPiMode -eq 'reuse') {
  Say 'Existing verified Pi 1.5.1 and LSP 1.4.0 runtime retained, including its permissions.'
} else {
  $hostBackup = Join-Path $backupRoot '.pi\agent\npm'
  Publish-HostRuntime $hostPiRoot $preparedPi $hostBackup $TargetHome $backupRoot
}

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
$workflowSkills = Get-ChildItem -LiteralPath (Join-Path $payload 'workflow-skills') -Directory
$retiredCodexSkills = @($workflowSkills | Where-Object { $_.Name -ne 'kether-governance' })
foreach ($skill in $retiredCodexSkills) {
  $installedSkill = Join-Path $skillsRoot $skill.Name
  if (Test-Path -LiteralPath $installedSkill) {
    $relative = [IO.Path]::GetRelativePath([IO.Path]::GetFullPath($TargetHome), [IO.Path]::GetFullPath($installedSkill))
    $backup = Join-Path $backupRoot $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backup) | Out-Null
    Move-Item -LiteralPath $installedSkill -Destination $backup
  }
}
$governanceSkill = Join-Path $payload 'workflow-skills\kether-governance'
if(-not $policyReuse.reuseSkill){Copy-WithBackup $governanceSkill (Join-Path $skillsRoot 'kether-governance') $backupRoot}

$agentsPath = Join-Path $TargetHome '.codex\AGENTS.md'
Get-ChildItem -LiteralPath $referencesSource -File -Filter '*.md' | ForEach-Object {
  $referenceTarget=Join-Path $TargetHome ('.codex\agent-references\' + $_.Name)
  if(-not (Test-Path -LiteralPath $referenceTarget)){Copy-WithBackup $_.FullName $referenceTarget $backupRoot}
}
$retiredGovernanceReference = Join-Path $TargetHome '.codex\agent-references\governance.md'
if (-not (Test-Path -LiteralPath (Join-Path $referencesSource 'governance.md') -PathType Leaf) -and (Test-Path -LiteralPath $retiredGovernanceReference)) {
  Assert-Under $retiredGovernanceReference $TargetHome
  $archive = Join-Path $backupRoot '.codex\agent-references\governance.md'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archive) | Out-Null
  Move-Item -LiteralPath $retiredGovernanceReference -Destination $archive
}
if(-not $policyReuse.reuseAgents){
  if (Test-Path -LiteralPath $agentsPath) { Copy-Item -LiteralPath $agentsPath -Destination (Join-Path $backupRoot 'AGENTS.md') -Force }
  Set-ManagedAgents $agentsPath (Get-Content -LiteralPath $templatePath -Raw)
}

$configToml = Join-Path $TargetHome '.codex\config.toml'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $configToml) | Out-Null
if(-not $policyReuse.reuseConfig){[IO.File]::WriteAllText($configToml, $updatedToml, [Text.UTF8Encoding]::new($false))}

$marketplacePath = Join-Path $TargetHome '.agents\plugins\marketplace.json'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $marketplacePath) | Out-Null
if(-not $policyReuse.reuseMarketplace){
  $market = if (Test-Path -LiteralPath $marketplacePath) { Get-Content -LiteralPath $marketplacePath -Raw | ConvertFrom-Json -AsHashtable } else { @{ name='personal'; interface=@{displayName='Personal'}; plugins=@() } }
  if (-not $market.plugins) { $market.plugins = @() }
  $market.plugins = @($market.plugins | Where-Object { $_.name -ne 'pi-dispatch' }) + @(@{name='pi-dispatch';source=@{source='local';path='./plugins/pi-dispatch'};policy=@{installation='AVAILABLE';authentication='ON_INSTALL'};category='Productivity'})
  $market | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $marketplacePath -Encoding utf8NoBOM
}
}

if ($installWsl) {
  $distros = (& wsl.exe --list --quiet) -replace "`0", ''
  if ($distros -notcontains $WslDistro) { throw "WSL distro '$WslDistro' is not installed. Install Ubuntu 24.04, then rerun." }
  & wsl.exe -d $WslDistro -u root -- sh -c 'mkdir -p /tmp/pi-kether-install && chmod 700 /tmp/pi-kether-install'
  if ($LASTEXITCODE -ne 0) { throw 'Could not initialize WSL provisioning directory.' }
  $transfers = @{
    (Join-Path $packageRoot 'install\provision-wsl.sh')='/tmp/pi-kether-install/provision-wsl.sh'
    (Join-Path $packageRoot 'install\provision-run-check-trust.py')='/tmp/pi-kether-install/provision-run-check-trust.py'
    (Join-Path $packageRoot 'install\patch-pi-lsp.mjs')='/tmp/pi-kether-install/patch-pi-lsp.mjs'
    (Join-Path $packageRoot 'install\check-pi-downgrade.py')='/tmp/pi-kether-install/check-pi-downgrade.py'
    (Join-Path $payload 'wsl-package-lock.json')='/tmp/pi-kether-install/wsl-package-lock.json'
    (Join-Path $pluginTarget 'sandbox\pi-kether-sandbox')='/tmp/pi-kether-install/pi-kether-sandbox'
    (Join-Path $pluginTarget 'scripts\validate-write-scope.mjs')='/tmp/pi-kether-install/validate-write-scope.mjs'
    (Join-Path $pluginTarget 'scripts\artifact-apply.mjs')='/tmp/pi-kether-install/artifact-apply.mjs'
    (Join-Path $pluginTarget 'extensions\write-scope-guard.js')='/tmp/pi-kether-install/write-scope-guard.js'
    (Join-Path $pluginTarget 'extensions\auth-scrub.js')='/tmp/pi-kether-install/auth-scrub.js'
    (Join-Path $payload 'pi-dispatch\extensions\source-window.js')='/tmp/pi-kether-install/source-window.js'
    (Join-Path $pluginTarget 'extensions\read-scope-guard.js')='/tmp/pi-kether-install/read-scope-guard.js'
    (Join-Path $payload 'pi-dispatch\extensions\role-presets.js')='/tmp/pi-kether-install/role-presets.js'
    (Join-Path $payload 'pi-dispatch\extensions\result-submit.js')='/tmp/pi-kether-install/result-submit.js'
    (Join-Path $payload 'pi-dispatch\extensions\role-contract.js')='/tmp/pi-kether-install/role-contract.js'
    (Join-Path $payload 'pi-dispatch\extensions\result-export.js')='/tmp/pi-kether-install/result-export.js'
    (Join-Path $payload 'pi-dispatch\extensions\data-capacity.js')='/tmp/pi-kether-install/data-capacity.js'
    (Join-Path $pluginTarget 'scripts\snapshot-scope.py')='/tmp/pi-kether-install/snapshot-scope.py'
    (Join-Path $pluginTarget 'scripts\lsp-result.mjs')='/tmp/pi-kether-install/lsp-result.mjs'
    (Join-Path $pluginTarget 'scripts\prepare-credentials.mjs')='/tmp/pi-kether-install/prepare-credentials.mjs'
    (Join-Path $pluginTarget 'scripts\direct-lsp-bootstrap.mjs')='/tmp/pi-kether-install/direct-lsp-bootstrap.mjs'
    (Join-Path $pluginTarget 'scripts\legacy-structural-bootstrap.mjs')='/tmp/pi-kether-install/legacy-structural-bootstrap.mjs'
    (Join-Path $pluginTarget 'scripts\multilspy-probe.py')='/tmp/pi-kether-install/multilspy-probe.py'
    (Join-Path $payload 'multilspy-requirements.txt')='/tmp/pi-kether-install/multilspy-requirements.txt'
    (Join-Path $pluginTarget 'scripts\secure-pi-bootstrap.mjs')='/tmp/pi-kether-install/secure-pi-bootstrap.mjs'
    (Join-Path $pluginTarget 'scripts\pi-single-shot-lifecycle.mjs')='/tmp/pi-kether-install/pi-single-shot-lifecycle.mjs'
    (Join-Path $pluginTarget 'scripts\sdk-tree-integrity.mjs')='/tmp/pi-kether-install/sdk-tree-integrity.mjs'
    (Join-Path $pluginTarget 'scripts\check-pi-runtime-tree.mjs')='/tmp/pi-kether-install/check-pi-runtime-tree.mjs'
    (Join-Path $pluginTarget 'scripts\pi-151-home.mjs')='/tmp/pi-kether-install/pi-151-home.mjs'
    (Join-Path $pluginTarget 'extensions\single-shot-lifecycle.js')='/tmp/pi-kether-install/single-shot-lifecycle.js'
    (Join-Path $pluginTarget 'scripts\editor-pi-bootstrap.mjs')='/tmp/pi-kether-install/editor-pi-bootstrap.mjs'
    (Join-Path $pluginTarget 'scripts\lsp-sandbox-broker.mjs')='/tmp/pi-kether-install/lsp-sandbox-broker.mjs'
    (Join-Path $pluginTarget 'scripts\run-check-broker.mjs')='/tmp/pi-kether-install/run-check-broker.mjs'
    (Join-Path $pluginTarget 'scripts\check-policy.mjs')='/tmp/pi-kether-install/check-policy.mjs'
    (Join-Path $pluginTarget 'scripts\check-snapshot.py')='/tmp/pi-kether-install/check-snapshot.py'
    (Join-Path $pluginTarget 'extensions\run-check-proxy.js')='/tmp/pi-kether-install/run-check-proxy.js'
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
    (Join-Path $pluginTarget 'scripts\patch-policy.mjs')='/tmp/pi-kether-install/patch-policy.mjs'
    (Join-Path $pluginTarget 'extensions\audit-log.js')='/tmp/pi-kether-install/audit-log.js'
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
# Existing Hindsight skills are not rewritten as part of a Pi/LSP reinstall.
& (Join-Path $PSScriptRoot 'Protect-PiState.ps1') -TargetHome $TargetHome
if(-not $reusePlugin){
  & $nodePath (Join-Path $pluginTarget 'scripts/plugin-upgrade.mjs') record $installationSource $pluginTarget
  if($LASTEXITCODE -ne 0){throw 'Managed installation baseline could not be recorded.'}
}
& (Join-Path $packageRoot 'install\Test-PiKether.ps1') -Installed -TargetHome $TargetHome -WslDistro $WslDistro -Hosts $Hosts -SkipWsl:$(-not $installWsl)
if ($LASTEXITCODE -ne 0) { throw 'Post-install self-test failed.' }
Say "Installation complete. Backup: $backupRoot"
Say 'Sign in with Pi on this Windows account if ~/.pi/agent/auth.json is not already present.'
Say "Import your selected host's connection and PRIMARY-AGENT.md from: $hostExports"
