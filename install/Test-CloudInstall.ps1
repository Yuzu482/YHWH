#Requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$PackageZip)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or -not [IO.Path]::IsPathFullyQualified($env:RUNNER_TEMP)) { throw 'Cloud installation test requires a GitHub-hosted Windows runner.' }
$temp=[IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\','/')
if(-not (Test-Path -LiteralPath $temp -PathType Container) -or ((Get-Item -LiteralPath $temp -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe runner temporary directory.'}
$fixture=Join-Path $temp ('yhwh-install-smoke-'+[guid]::NewGuid().ToString('N'))
if(Test-Path -LiteralPath $fixture){throw 'Cloud fixture already exists.'}
New-Item -ItemType Directory -Path $fixture | Out-Null
$zip=[IO.Path]::GetFullPath($PackageZip)
if(-not (Test-Path -LiteralPath $zip -PathType Leaf)){throw 'Cloud test package is missing.'}
Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $fixture 'extracted')
$package=Join-Path $fixture 'extracted/pi-kether-portable'
$target=Join-Path $fixture 'home'; $workspace=Join-Path $fixture 'workspace'
$state=Join-Path $target '.local/state/pi-kether'
$ledger=Join-Path $state 'request-ledger/historical-review.jsonl'
$approval=Join-Path $state 'lsp-approval/historical-fixture.json'
foreach($dir in @($workspace,(Split-Path -Parent $ledger),(Split-Path -Parent $approval))){New-Item -ItemType Directory -Path $dir -Force|Out-Null}
Set-Content -LiteralPath $ledger -Value 'synthetic review history' -Encoding utf8NoBOM
Set-Content -LiteralPath $approval -Value 'synthetic approval history' -Encoding utf8NoBOM
$token=Join-Path $state 'token.txt'
Set-Content -LiteralPath $token -Value 'fixture-only-0123456789-0123456789-abcdef' -Encoding utf8NoBOM
@{host='127.0.0.1';port=17331;roots=@($workspace);tokenFile=$token}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $state 'gateway-silent.json') -Encoding utf8NoBOM
$config=Join-Path $fixture 'install.json'
@{schemaVersion=1;hosts=@('generic');workspaceRoots=@($workspace);installWsl=$false;installTunnel=$false}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $config -Encoding utf8NoBOM
& (Join-Path $package 'install/Protect-PiState.ps1') -TargetHome $target
$ledgerHash=(Get-FileHash -LiteralPath $ledger).Hash
$approvalHash=(Get-FileHash -LiteralPath $approval).Hash
$stateSddl=(Get-Acl -LiteralPath $state).Sddl
$env:npm_config_cache=Join-Path $fixture 'npm-cache'
$env:npm_config_audit='false';$env:npm_config_fund='false'
$engine=Join-Path $PSHOME 'pwsh.exe'
function Check-History {
  if((Get-FileHash -LiteralPath $ledger).Hash -cne $ledgerHash -or (Get-FileHash -LiteralPath $approval).Hash -cne $approvalHash -or (Get-Acl -LiteralPath $state).Sddl -cne $stateSddl){throw 'Cloud fixture history or ACL changed.'}
}
function Invoke-FixtureInstall([string]$Source,[string]$Phase,[bool]$Expected){
  $log=Join-Path $fixture ($Phase+'.log')
  & $engine -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $Source 'install/Install-PiKether.ps1') -ConfigFile $config -TargetHome $target -SkipWsl -SkipTunnel -SkipCodexRegistration *> $log
  if(($LASTEXITCODE -eq 0) -ne $Expected){Get-Content -LiteralPath $log -Tail 35;throw "$Phase returned unexpected status $LASTEXITCODE"}
  return $log
}
$first=Invoke-FixtureInstall $package 'fresh-install' $true
Check-History
$plugin=Join-Path $target 'plugins/pi-dispatch'; $marker=Join-Path $plugin '.yhwh-managed-files.json'
$markerHash=(Get-FileHash -LiteralPath $marker).Hash
$componentFiles=@('scripts/task-components.mjs','scripts/project-memory-context.mjs','scripts/gateway.mjs','scripts/host-workflow.mjs','scripts/stdio-proxy.mjs','workflow/catalog.json')
$hashes=@{}
foreach($name in $componentFiles){
  $installed=Join-Path $plugin $name; $packed=Join-Path (Join-Path $package 'payload/pi-dispatch') $name
  if(-not(Test-Path -LiteralPath $installed -PathType Leaf) -or (Get-FileHash -LiteralPath $installed).Hash -cne (Get-FileHash -LiteralPath $packed).Hash){throw "Installed component differs from package: $name"}
  $hashes[$name]=(Get-FileHash -LiteralPath $installed).Hash
}
function Check-Components {
  foreach($name in $componentFiles){if((Get-FileHash -LiteralPath (Join-Path $plugin $name)).Hash -cne $hashes[$name]){throw "Installed component changed: $name"}}
  if((Get-FileHash -LiteralPath $marker).Hash -cne $markerHash){throw 'Managed plugin marker changed.'}
}
$catalog=Get-Content -LiteralPath (Join-Path $plugin 'workflow/catalog.json') -Raw|ConvertFrom-Json
if(-not $catalog.topics.'pi-routing'.Contains('TASK_COMPONENTS_JSON=') -or -not $catalog.topics.primary.Contains('Pi provides optional governed execution')){throw 'Optional component guidance is missing.'}
$second=Invoke-FixtureInstall $package 'repeat-install' $true
Check-History;Check-Components
if(-not (Get-Content -LiteralPath $second -Raw).Contains('Existing verified plugin and gateway rules retained without rewriting.')){throw 'Reinstall did not reuse the verified plugin.'}
$oldZip=Join-Path $fixture 'old-package.zip'
Invoke-WebRequest -Uri 'https://github.com/Yuzu482/YHWH/releases/download/v0.15.2/pi-kether-portable-0.15.2.zip' -OutFile $oldZip
if((Get-FileHash -LiteralPath $oldZip -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'b34e24367eb8df9e0463ab818dc6891d7f5cf3258623d474a4dc1c6fe480589e'){throw 'Prior release digest mismatch.'}
Expand-Archive -LiteralPath $oldZip -DestinationPath (Join-Path $fixture 'old-extracted')
$oldPackage=Join-Path $fixture 'old-extracted/pi-kether-portable'
$oldLog=Invoke-FixtureInstall $oldPackage 'old-installer' $false
if(-not (Get-Content -LiteralPath $oldLog -Raw).Contains('Existing Pi plugin cannot be safely replaced')){throw 'Older installer did not safely refuse the updated plugin.'}
Check-History;Check-Components
$custom=Join-Path $plugin 'scripts/local-history-fixture.mjs'
Set-Content -LiteralPath $custom -Value 'synthetic custom file' -Encoding utf8NoBOM
$customHash=(Get-FileHash -LiteralPath $custom).Hash
$customLog=Invoke-FixtureInstall $package 'custom-mismatch' $false
if(-not (Get-Content -LiteralPath $customLog -Raw).Contains('Existing Pi plugin cannot be safely replaced') -or (Get-FileHash -LiteralPath $custom).Hash -cne $customHash){throw 'Custom plugin was not retained.'}
Check-History;Check-Components
Push-Location $plugin
try {
  & node --test --test-concurrency=1 tests/task-components.test.mjs tests/gateway-memory.test.mjs tests/host-workflow.test.mjs tests/lsp-approval-state.test.mjs
  if($LASTEXITCODE -ne 0){throw 'Installed cloud component and LSP regression failed.'}
} finally {Pop-Location}
Write-Host 'PASS: Cloud fresh install, same-package reinstall, prior/custom refusal, fixture ledger and ACL preservation, and installed runtime checks.'
