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
$config.hosts='generic'; Save; Reject
$config.hosts=@('unknown'); Save; Reject
$config.hosts=@('generic','generic'); Save; Reject
$config.hosts=@('cherry-studio','opencode','deepseek-harness','claude-code'); Save
$hostConfig=& (Join-Path $PSScriptRoot 'Read-WorkflowConfig.ps1') -ConfigFile $configPath
if($hostConfig.hosts.Count -ne 4){throw 'Host selection lost entries.'}
$config.hosts=@((& node (Join-Path $package 'payload/pi-dispatch/scripts/host-profiles.mjs') --list | ConvertFrom-Json))
if($LASTEXITCODE -ne 0 -or $config.hosts.Count -ne 18){throw 'Host discovery failed.'}
Save
$hostConfig=& (Join-Path $PSScriptRoot 'Read-WorkflowConfig.ps1') -ConfigFile $configPath
if($hostConfig.hosts.Count -ne 18){throw 'Expanded host selection lost entries.'}
Save
& (Join-Path $package 'Workflow.ps1') -Action Plan -ConfigFile $configPath -TargetHome $target -SkipCodexRegistration
if(Test-Path -LiteralPath $target){throw 'Plan mutated target home.'}
$config.installTunnel=$true; Save
$rejected=$false
try { & (Join-Path $package 'Workflow.ps1') -Action Plan -ConfigFile $configPath -TargetHome $target -SkipCodexRegistration } catch { $rejected=$true }
if(-not $rejected -or (Test-Path -LiteralPath $target)){throw 'Tunnel preflight failed to reject missing inputs before mutation.'}
Write-Output '[PASS] Workflow config validation, host selection, single-root serialization and no-write preflight.'
