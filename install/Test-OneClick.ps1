#requires -Version 5.1
[CmdletBinding()]
param([string]$Installer)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo 'Install-YHWH.ps1'
$test = Join-Path $repo ('.test\one click ' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $test -Force | Out-Null
$checks = 0
function Check([bool]$Passed, [string]$Name) {
  if (-not $Passed) { throw "FAIL: $Name" }
  $script:checks++
  Write-Host "[PASS] $Name"
}
function Reject([scriptblock]$Action, [string]$Message) {
  $rejected = $false
  try { & $Action | Out-Null } catch { $rejected = $_.Exception.Message -like "*$Message*"; if(-not $rejected){throw} }
  Check $rejected "Reject: $Message"
}
# Load function declarations only. Never invoke the real installer/WSL/download path.
$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$null,[ref]$parseErrors)
Check (-not $parseErrors) 'Bootstrap parses in this PowerShell version'
foreach ($fn in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]}, $false)) {
  . ([scriptblock]::Create($fn.Extent.Text))
}
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
function MakeZip([string]$Name, [string[]]$Entries) {
  $path=Join-Path $test $Name
  $zip=[IO.Compression.ZipFile]::Open($path,[IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach($entry in $Entries) {
      $writer=[IO.StreamWriter]::new($zip.CreateEntry($entry).Open())
      try{$writer.Write('fixture')}finally{$writer.Dispose()}
    }
  }finally{$zip.Dispose()}
  return $path
}
$zip=MakeZip 'valid.zip' @('pi-kether-portable/.codex-plugin/plugin.json','pi-kether-portable/README.en.md')
$out=Join-Path $test 'valid extracted'
Expand-YhwhArchive $zip $out
Check (Test-Path -LiteralPath (Join-Path $out 'pi-kether-portable/.codex-plugin/plugin.json')) 'Extraction preserves dotfiles and spaces'
Reject {Expand-YhwhArchive $zip $out} 'new directory'
foreach($entry in @('../escaped.txt','/rooted.txt','folder/../../escaped.txt','folder/file:stream','NUL.txt','folder./file.txt')) {
  $bad=MakeZip ([guid]::NewGuid().ToString('N')+'.zip') @($entry)
  $badOut=Join-Path $test ([guid]::NewGuid().ToString('N'))
  Reject {Expand-YhwhArchive $bad $badOut} 'Unsafe'
  Check (-not(Test-Path -LiteralPath $badOut)) 'Unsafe archive rejected before destination creation'
}
$bad=MakeZip 'duplicate.zip' @('File.txt','file.txt')
Reject {Expand-YhwhArchive $bad (Join-Path $test 'duplicates')} 'duplicate'
$hash=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
Assert-YhwhHash $zip $hash
Reject {Assert-YhwhHash $zip ('0'*64)} 'SHA256'
$script:PayloadBase64=[Convert]::ToBase64String([IO.File]::ReadAllBytes($zip))
$script:PayloadSha256='0'*64
Reject {Expand-YhwhPayload (Join-Path $test 'tampered')} 'checksum mismatch'
Check (-not(Test-Path -LiteralPath (Join-Path $test 'tampered'))) 'Tampered payload makes no destination'
$script:PayloadSha256=$hash
$expanded=Expand-YhwhPayload (Join-Path $test 'embedded')
Check (Test-Path -LiteralPath (Join-Path $expanded 'README.en.md')) 'Embedded payload round-trip'

# Mocks fail closed if a test takes an unexpected external-action branch.
function Get-CimInstance { [pscustomobject]@{CommandLine=$script:fakeCommand} }
$fakePlugin=Join-Path $test 'existing plugin'
New-Item -ItemType Directory -Path $fakePlugin | Out-Null
Reject {Assert-YhwhInstallAllowed $fakePlugin} 'already installed'
$script:fakeCommand='node.exe "'+$fakePlugin+'\scripts\stdio-server.mjs"'
Reject {Assert-YhwhInstallAllowed $fakePlugin -Upgrade} 'runtime is active'
$script:fakeCommand='node.exe unrelated.js'
Assert-YhwhInstallAllowed $fakePlugin -Upgrade
Check $true 'Explicit stopped upgrade allowed'
function wsl.exe {
  $global:LASTEXITCODE=0
  if (($args -join ' ') -eq '--list --quiet') { return 'YHWH' }
  if (($args -join ' ') -in @('-d YHWH -u root -- cat /etc/yhwh-owner','-d YHWH -u root cat /etc/yhwh-owner')) { return $script:fakeOwner }
  throw "Unexpected WSL mutation in tests: $($args -join ' ')"
}
function Get-YhwhDownload { throw 'Unexpected download in ownership tests' }
$ownerRoot=Join-Path $test 'owner'
New-Item -ItemType Directory -Path $ownerRoot | Out-Null
Reject {Initialize-YhwhDistro $ownerRoot $null $null} 'unmanaged'
@{id=('a'*32)}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $ownerRoot 'distro-owner.json') -Encoding UTF8
$script:fakeOwner='b'*32
Reject {Initialize-YhwhDistro $ownerRoot $null $null} 'ownership mismatch'
$script:fakeOwner='a'*32
Initialize-YhwhDistro $ownerRoot $null $null
Check $true 'Owned WSL reused without import or download'

$engine=(Get-Process -Id $PID).Path
$planTarget=Join-Path $test 'plan install target'
& $engine -NoProfile -ExecutionPolicy Bypass -File $source -PlanOnly -InstallRoot $planTarget
Check ($LASTEXITCODE -eq 0 -and -not(Test-Path -LiteralPath $planTarget)) 'Plan is read-only'
& $engine -NoProfile -ExecutionPolicy Bypass -File $source -PlanOnly -InstallRoot $planTarget -Hosts 'cursor,vscode-copilot,windsurf,cline,roo-code,gemini-cli,kiro,zed,continue,lm-studio'
Check ($LASTEXITCODE -eq 0 -and -not(Test-Path -LiteralPath $planTarget)) 'All common-client host selections plan without writes'
$featureScript=Join-Path $PSScriptRoot 'Set-CodexFeatures.ps1'
$fresh=& $featureScript -Text ''
Check ($fresh -match '(?s)\[features\]\s+multi_agent = false') 'Fresh Codex config uses the features table'
$original="model = 'example'`n[features]`nother = true`nmulti_agent = true`n[projects.example]`nmulti_agent = true`n"
$updated=& $featureScript -Text $original
Check ($updated -match '(?s)\[features\].*?other = true.*?multi_agent = false') 'Existing features are preserved while Pi routing is selected'
Check ($updated -match '(?s)\[projects.example\]\s+multi_agent = true') 'Unrelated TOML tables are preserved'
Check ((& $featureScript -Text $updated) -eq $updated) 'Feature edit is idempotent'
$legacy=& $featureScript -Text "multi_agent = true`nmodel = 'example'"
Check (-not($legacy.StartsWith('multi_agent')) -and $legacy.Contains('[features]')) 'Legacy root feature migrates into its table'
$emptyTable=& $featureScript -Text '[features]'
Check ($emptyTable -match '(?s)\[features\]\s+multi_agent = false') 'Empty features table is supported'
Reject {& $featureScript -Text 'features = { other = true }'} 'manual migration'
if($Installer) {
  $actualOut=Join-Path $test 'release extracted'
  & $engine -NoProfile -ExecutionPolicy Bypass -File $Installer -ExtractOnly -Destination $actualOut
  Check ($LASTEXITCODE -eq 0) 'Generated installer extracts successfully'
  $package=Join-Path $actualOut 'pi-kether-portable'
  foreach($required in @('Workflow.ps1','payload/pi-dispatch/.codex-plugin/plugin.json','payload/wsl-package-lock.json','templates/agent-references/pi-routing.md','README.md','README.en.md','.readme-assets/en.svg','install/bootstrap-dependencies.json','templates/host-primary.md','payload/pi-dispatch/workflow/catalog.json','payload/pi-dispatch/scripts/host-profiles.mjs','payload/pi-dispatch/scripts/check-host-connection.mjs','install/Export-HostProfiles.ps1','docs/host-integration.md','docs/host-integration.en.md','payload/pi-dispatch/scripts/common-client-profiles.mjs','docs/common-clients.md','docs/common-clients.en.md')) {
    Check (Test-Path -LiteralPath (Join-Path $package $required)) "Release contains $required"
  }
  foreach($licenseFile in @('install/Test-Multilspy.py','payload/pi-dispatch/tests/multilspy-probe.test.py','payload/pi-dispatch/tests/multilspy-server-fixture.py','payload/multilspy-requirements.txt','licenses/multilspy-dependencies.json','licenses/multilspy-dependency-notices.txt','licenses/multilspy-0.0.15-MIT.txt','licenses/multilspy-OLSP-MIT.txt','payload/pi-dispatch/scripts/multilspy-probe.py','payload/pi-dispatch/scripts/legacy-structural-bootstrap.mjs','LICENSE','NOTICE','THIRD_PARTY.md','THIRD_PARTY.en.md','licenses/sources.json','licenses/MIT-standard-reference.txt','licenses/pi-lsp-extension-evidence.json','docs/lsp-component.md','docs/lsp-component.en.md','docs/lsp-license-remediation.md','docs/lsp-license-remediation.en.md','docs/upstream-lsp-license-request.md','install/Set-ClaudeApiKey.ps1','payload/pi-dispatch/scripts/anthropic-api-credential.mjs','payload/pi-dispatch/scripts/claude-api-auth.mjs','licenses/dependency-inventory.json','licenses/pi-0.84.4-MIT.txt','licenses/pi-claude-code-provider-0.1.4-MIT.txt','licenses/pi-lsp-extension-NOTICE.txt','licenses/pi-lsp-extension-1.3.0.package.json','licenses/claude-code-2.1.250-NOTICE.txt','payload/pi-dispatch/LICENSE','payload/pi-dispatch/NOTICE','payload/pi-dispatch/THIRD_PARTY_NOTICES.txt','docs/claude-code-feasibility.md','docs/claude-code-feasibility.en.md')) {
    $packedFile=Join-Path $package $licenseFile
    Check ((Test-Path -LiteralPath $packedFile) -and ((Get-FileHash -LiteralPath $packedFile).Hash -eq (Get-FileHash -LiteralPath (Join-Path $repo $licenseFile)).Hash)) "Release preserves $licenseFile"
  }
  foreach($providerFile in @('install/Migrate-ApiCredentials.ps1','install/Test-ApiEncryption.ps1','payload/pi-dispatch/scripts/ApiCredentialStore.ps1','payload/pi-dispatch/scripts/Read-ApiCredential.ps1','payload/pi-dispatch/scripts/windows-api-credential.mjs','payload/pi-dispatch/scripts/accept-api-packet.mjs','install/Set-ProviderConfig.ps1','install/Set-ProviderApiKey.ps1','install/Open-YhwhProviders.ps1','install/provider-config.mjs','templates/provider-config.example.json','payload/pi-dispatch/scripts/controlled-provider.mjs','payload/pi-dispatch/scripts/provider-transport.mjs','payload/pi-dispatch/extensions/controlled-provider.js','docs/provider-configuration.md','docs/provider-configuration.en.md')) {
    $packed=Join-Path $package $providerFile
    Check ((Test-Path -LiteralPath $packed) -and ((Get-FileHash -LiteralPath $packed).Hash -eq (Get-FileHash -LiteralPath (Join-Path $repo $providerFile)).Hash)) "Release preserves $providerFile"
  }
  foreach($adapterFile in @('install/Test-PiLspAdapter.py','payload/pi-dispatch/extensions/lsp-proxy.js','payload/pi-dispatch/scripts/lsp-sandbox-broker.mjs','payload/pi-dispatch/pi-extensions/lsp/index.mjs','payload/pi-dispatch/pi-extensions/lsp/package.json','payload/pi-dispatch/tests/lsp-adapter-agent.mjs','docs/pi-lsp-adapter.md','docs/pi-lsp-adapter.en.md')) {
    $packed=Join-Path $package $adapterFile
    Check ((Test-Path -LiteralPath $packed) -and ((Get-FileHash -LiteralPath $packed).Hash -eq (Get-FileHash -LiteralPath (Join-Path $repo $adapterFile)).Hash)) "Release preserves $adapterFile"
  }
  foreach($sessionFile in @('install/provision-go-rust.sh','licenses/go-rust-runtime.json','payload/pi-dispatch/tests/lsp-reuse-benchmark.mjs','payload/pi-dispatch/tests/python-reuse-benchmark.mjs','payload/pi-dispatch/tests/cpp-reuse-benchmark.mjs','payload/pi-dispatch/tests/csharp-reuse-benchmark.mjs','payload/pi-dispatch/tests/java-reuse-benchmark.mjs','payload/pi-dispatch/scripts/java-probe-launch.py','payload/pi-dispatch/tests/csharp-probe.test.mjs','payload/pi-dispatch/scripts/csharp-probe-project.mjs','payload/pi-dispatch/tests/lsp-session-fixture.mjs','payload/pi-dispatch/tests/lsp-session.test.mjs')) {
    $packed=Join-Path $package $sessionFile
    Check ((Test-Path -LiteralPath $packed) -and ((Get-FileHash -LiteralPath $packed).Hash -eq (Get-FileHash -LiteralPath (Join-Path $repo $sessionFile)).Hash)) "Release preserves $sessionFile"
  }
  $files=@(Get-ChildItem -LiteralPath $package -Recurse -Force -File)
  $badFiles=@($files|Where-Object{$_.FullName -match '[\\/](node_modules|\.git|\.runtime)[\\/]|[\\/]auth\.json$|[\\/](anthropic-api-key|provider-config|provider-credentials)\.json$|[\\/]\.env[^\\/]*$'})
  Check ($badFiles.Count -eq 0) 'Release excludes dependencies, credentials and runtime state'
  & $engine -NoProfile -ExecutionPolicy Bypass -File $Installer -PlanOnly -InstallRoot (Join-Path $test 'generated plan')
  Check ($LASTEXITCODE -eq 0 -and -not(Test-Path -LiteralPath (Join-Path $test 'generated plan'))) 'Generated installer plan remains read-only'
}
Write-Host "[PASS] $checks one-click checks; no host installation, WSL mutation or model calls."
