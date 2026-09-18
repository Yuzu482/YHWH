#Requires -Version 7.0
[CmdletBinding()]
param(
  [ValidateSet('Init','Plan','Install','Verify','Build')][string]$Action='Plan',
  [string]$ConfigFile=(Join-Path $PSScriptRoot 'install.config.json'),
  [string]$TargetHome=$HOME,
  [switch]$SkipWsl,
  [switch]$SkipTunnel,
  [switch]$SkipCodexRegistration
)
$ErrorActionPreference='Stop'
switch($Action) {
  'Init' {
    if(Test-Path -LiteralPath $ConfigFile){throw 'Configuration already exists; edit it explicitly.'}
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install.config.example.json') -Destination $ConfigFile
    Write-Output "Configuration created: $ConfigFile"
  }
  'Build' { & (Join-Path $PSScriptRoot 'Build-Release.ps1') }
  'Verify' {
    $config=& (Join-Path $PSScriptRoot 'install/Read-WorkflowConfig.ps1') -ConfigFile $ConfigFile
    & (Join-Path $PSScriptRoot 'install/Test-PiKether.ps1') -Installed -TargetHome $TargetHome -WslDistro $config.wslDistro -SkipWsl:($SkipWsl -or -not $config.installWsl)
  }
  default {
    & (Join-Path $PSScriptRoot 'install/Install-PiKether.ps1') -ConfigFile $ConfigFile -TargetHome $TargetHome -PlanOnly:($Action -eq 'Plan') -SkipWsl:$SkipWsl -SkipTunnel:$SkipTunnel -SkipCodexRegistration:$SkipCodexRegistration
  }
}
