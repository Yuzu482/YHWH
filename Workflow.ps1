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
  [switch]$SkipCodexRegistration,
  [switch]$AllowDirty,
  [string]$DirtyReason
)
$ErrorActionPreference='Stop'
switch($Action) {
  'Install' {
    $admission = & (Join-Path $PSScriptRoot 'install/Assert-DeploymentSource.ps1') -PackageRoot $PSScriptRoot -AllowDirty:$AllowDirty -DirtyReason $DirtyReason
    $recordRoot = Join-Path ([IO.Path]::GetFullPath($TargetHome)) '.local/state/pi-kether/installation-records'
    New-Item -ItemType Directory -Force -Path $recordRoot | Out-Null
    $recordPath = Join-Path $recordRoot (([guid]::NewGuid().ToString('N')) + '.json')
    $record = [ordered]@{schemaVersion=1;startedAt=[DateTime]::UtcNow.ToString('o');status='admitted';source=$PSScriptRoot;admission=$admission}
    function Save-InstallRecord {
      $temporary = $recordPath + '.tmp'
      try {
        [IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
        [IO.File]::Move($temporary, $recordPath, $true)
      } finally { if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force} }
    }
    Save-InstallRecord
    try {
      & (Join-Path $PSScriptRoot 'install/Install-PiKether.ps1') -ConfigFile $ConfigFile -TargetHome $TargetHome -SkipWsl:$SkipWsl -SkipTunnel:$SkipTunnel -SkipCodexRegistration:$SkipCodexRegistration
      if(-not $?){throw 'Installer failed.'}
      $record.status='completed'
    } catch {
      $record.status='failed'; throw
    } finally {
      $record.finishedAt=[DateTime]::UtcNow.ToString('o'); Save-InstallRecord
    }
  }
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
    $gatewayRoot=Join-Path $PSScriptRoot 'payload/pi-dispatch'
    $testOutputRoot=Join-Path $PSScriptRoot '.test'
    $testLog=Join-Path $testOutputRoot 'workflow-verify-npm-test.tap.log'
    New-Item -ItemType Directory -Path $testOutputRoot -Force | Out-Null
    Push-Location $gatewayRoot
    try {
      & npm test 2>&1 | Out-File -FilePath $testLog -Encoding utf8NoBOM
      $npmTestExit=$LASTEXITCODE
      & node scripts/test-baseline.mjs --compare $testLog
      $baselineExit=$LASTEXITCODE
    } finally {
      Pop-Location
    }
    if($npmTestExit -ne 0){throw "Pi Dispatch npm test failed (exit $npmTestExit); see $testLog"}
    if($baselineExit -ne 0){throw "Pi Dispatch test baseline comparison failed (exit $baselineExit)."}
    $config=& (Join-Path $PSScriptRoot 'install/Read-WorkflowConfig.ps1') -ConfigFile $ConfigFile
    & (Join-Path $PSScriptRoot 'install/Test-PiKether.ps1') -Installed -TargetHome $TargetHome -WslDistro $config.wslDistro -Hosts $config.hosts -SkipWsl:($SkipWsl -or -not $config.installWsl)
  }
  default {
    & (Join-Path $PSScriptRoot 'install/Install-PiKether.ps1') -ConfigFile $ConfigFile -TargetHome $TargetHome -PlanOnly:($Action -eq 'Plan') -SkipWsl:$SkipWsl -SkipTunnel:$SkipTunnel -SkipCodexRegistration:$SkipCodexRegistration
  }
}
