#Requires -Version 7.0
[CmdletBinding()]
param(
  [string]$SourcePlugin=(Join-Path (Split-Path -Parent $PSScriptRoot) 'payload/pi-dispatch'),
  [string]$TargetHome=$HOME,
  [string]$BaselinePlugin,
  [switch]$Apply
)
$ErrorActionPreference='Stop'
$target=Join-Path $TargetHome 'plugins/pi-dispatch'
$settings=Join-Path $TargetHome '.local/state/pi-kether/silent-runtime.json'
$node=(Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$mutex=[Threading.Mutex]::new($false,'Local\PiKetherSilentRuntime')
$held=$false
try {
  $held=$mutex.WaitOne(0)
  if(-not $held){throw 'Runtime start/update already in progress.'}
  $arguments=@((Join-Path $SourcePlugin 'scripts/upgrade-service.mjs'),$SourcePlugin,$target,$settings,$(if($BaselinePlugin){$BaselinePlugin}else{'-'}))
  if($Apply){$arguments+='--apply'}
  & $node @arguments
  if($LASTEXITCODE -ne 0){throw 'Upgrade was blocked, rolled back, or needs recovery; inspect the structured result.'}
} finally { if($held){$mutex.ReleaseMutex()}; $mutex.Dispose() }
