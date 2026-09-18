$ErrorActionPreference='Stop'
$package=Split-Path -Parent $PSScriptRoot
$testRoot=Join-Path $package ('.test/config-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$configPath=Join-Path $testRoot 'config.json'
$target=Join-Path $testRoot 'uncreated-target'
$config=@{schemaVersion=1;workspaceRoots=@($package);wslDistro='Ubuntu-24.04';installWsl=$false;allowDistroHardening=$false;installTunnel=$false}
function Save { $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding utf8NoBOM }
function Reject {
  $rejected=$false
  try { & (Join-Path $PSScriptRoot 'Read-WorkflowConfig.ps1') -ConfigFile $configPath | Out-Null } catch { $rejected=$true }
  if(-not $rejected){throw 'Invalid configuration was accepted.'}
}
Save
$loaded=& (Join-Path $PSScriptRoot 'Read-WorkflowConfig.ps1') -ConfigFile $configPath
if($loaded.workspaceRoots -isnot [array] -or $loaded.workspaceRoots.Count -ne 1){throw 'Single workspace root lost array shape.'}
$rootsJson=ConvertTo-Json -InputObject @($loaded.workspaceRoots) -Compress
if(-not $rootsJson.StartsWith('[')){throw 'MCP roots must serialize as an array.'}
$config.installWsl='false'; Save; Reject; $config.installWsl=$false
$config.typo=$true; Save; Reject; $config.Remove('typo')
$config.schemaVersion=2; Save; Reject; $config.schemaVersion=1
Save
& (Join-Path $package 'Workflow.ps1') -Action Plan -ConfigFile $configPath -TargetHome $target -SkipCodexRegistration
if(Test-Path -LiteralPath $target){throw 'Plan mutated target home.'}
$config.installTunnel=$true; Save
$rejected=$false
try { & (Join-Path $package 'Workflow.ps1') -Action Plan -ConfigFile $configPath -TargetHome $target -SkipCodexRegistration } catch { $rejected=$true }
if(-not $rejected -or (Test-Path -LiteralPath $target)){throw 'Tunnel preflight failed to reject missing inputs before mutation.'}
Write-Output '[PASS] Workflow config validation, single-root serialization and no-write preflight.'
