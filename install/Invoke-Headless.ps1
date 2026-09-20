#Requires -Version 7.0
[CmdletBinding()]
param(
  [ValidateSet('Doctor','Run','Compare','Events','Batch','BatchEvents','Accept')][string]$Action='Doctor',
  [string]$ConfigFile,
  [string]$RequestFile,
  [string]$PluginRoot=(Join-Path (Split-Path -Parent $PSScriptRoot) 'payload/pi-dispatch'),
  [string]$ComparePluginRoot,
  [switch]$Live,
  [switch]$CancelProbe
)
$ErrorActionPreference='Stop'
$entry=Join-Path $PluginRoot 'scripts/headless-host.mjs'
if(-not(Test-Path -LiteralPath $entry -PathType Leaf)){throw 'Headless CLI feature is not installed in the selected plugin root.'}
$node=(Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
if($Action -eq 'Compare'){
  if(-not $ComparePluginRoot){throw 'ComparePluginRoot is required.'}
  & $node $entry fingerprint $ComparePluginRoot
} else {
  if(-not $ConfigFile){throw 'ConfigFile is required; use a host-owned *.local.json file.'}
  if($Action -eq 'Accept'){
    $arguments=@((Join-Path $PluginRoot 'scripts/headless-acceptance.mjs'),$ConfigFile)
    if($Live){$arguments+='--live'}
    if($CancelProbe){$arguments+='--cancel'}
    & $node @arguments
  } elseif($Action -in @('Run','Events','Batch','BatchEvents')){
    if(-not $RequestFile){throw 'RequestFile is required.'}
    $verb=@{Run='run';Events='run-events';Batch='batch';BatchEvents='batch-events'}[$Action]
    & $node $entry $verb $ConfigFile $RequestFile
  } else { & $node $entry doctor $ConfigFile }
}
if($LASTEXITCODE -ne 0){throw 'Headless CLI check or execution did not complete successfully; inspect the structured result.'}
