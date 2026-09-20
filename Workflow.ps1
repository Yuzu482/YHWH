#Requires -Version 7.0
[CmdletBinding()]
param(
  [ValidateSet('Init','Plan','Install','Verify','Build','HeadlessDoctor','HeadlessRun','HeadlessCompare','HeadlessEvents','HeadlessBatch','HeadlessBatchEvents','HeadlessAccept','ChangeImpact')][string]$Action='Plan',
  [string]$ConfigFile=(Join-Path $PSScriptRoot 'install.config.json'),
  [string]$HeadlessConfigFile,
  [string]$HeadlessRequestFile,
  [string]$ComparePluginRoot,
  [string]$ProjectRoot,
  [switch]$Live,
  [switch]$CancelProbe,
  [string]$TargetHome=$HOME,
  [switch]$SkipWsl,
  [switch]$SkipTunnel,
  [switch]$SkipCodexRegistration
)
$ErrorActionPreference='Stop'
switch($Action) {
  'HeadlessEvents' { & (Join-Path $PSScriptRoot 'install/Invoke-Headless.ps1') -Action Events -ConfigFile $HeadlessConfigFile -RequestFile $HeadlessRequestFile }
  'HeadlessBatch' { & (Join-Path $PSScriptRoot 'install/Invoke-Headless.ps1') -Action Batch -ConfigFile $HeadlessConfigFile -RequestFile $HeadlessRequestFile }
  'HeadlessBatchEvents' { & (Join-Path $PSScriptRoot 'install/Invoke-Headless.ps1') -Action BatchEvents -ConfigFile $HeadlessConfigFile -RequestFile $HeadlessRequestFile }
  'HeadlessAccept' { & (Join-Path $PSScriptRoot 'install/Invoke-Headless.ps1') -Action Accept -ConfigFile $HeadlessConfigFile -Live:$Live -CancelProbe:$CancelProbe }
  'ChangeImpact' {
    if(-not $ProjectRoot){throw 'ProjectRoot is required.'}
    & node (Join-Path $PSScriptRoot 'payload/pi-dispatch/scripts/change-impact.mjs') $ProjectRoot
    if($LASTEXITCODE -ne 0){throw 'Change impact check failed.'}
  }
  'HeadlessDoctor' { & (Join-Path $PSScriptRoot 'install/Invoke-Headless.ps1') -Action Doctor -ConfigFile $HeadlessConfigFile }
  'HeadlessRun' { & (Join-Path $PSScriptRoot 'install/Invoke-Headless.ps1') -Action Run -ConfigFile $HeadlessConfigFile -RequestFile $HeadlessRequestFile }
  'HeadlessCompare' { & (Join-Path $PSScriptRoot 'install/Invoke-Headless.ps1') -Action Compare -ComparePluginRoot $ComparePluginRoot }
  'Init' {
    if(Test-Path -LiteralPath $ConfigFile){throw 'Configuration already exists; edit it explicitly.'}
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install.config.example.json') -Destination $ConfigFile
    Write-Output "Configuration created: $ConfigFile"
  }
  'Build' { & (Join-Path $PSScriptRoot 'Build-Release.ps1') }
  'Verify' {
    $config=& (Join-Path $PSScriptRoot 'install/Read-WorkflowConfig.ps1') -ConfigFile $ConfigFile
    & (Join-Path $PSScriptRoot 'install/Test-PiKether.ps1') -Installed -TargetHome $TargetHome -WslDistro $config.wslDistro -Hosts $config.hosts -SkipWsl:($SkipWsl -or -not $config.installWsl)
  }
  default {
    & (Join-Path $PSScriptRoot 'install/Install-PiKether.ps1') -ConfigFile $ConfigFile -TargetHome $TargetHome -PlanOnly:($Action -eq 'Plan') -SkipWsl:$SkipWsl -SkipTunnel:$SkipTunnel -SkipCodexRegistration:$SkipCodexRegistration
  }
}
