#requires -Version 5.1
param([switch]$Migrate)
$ErrorActionPreference='Stop'
$installation=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'installation.json') -Raw | ConvertFrom-Json
$oldPath=$env:PATH
try {
 $env:PATH=(Split-Path -Parent $installation.node)+';'+$oldPath
 if($Migrate){& (Join-Path $installation.package 'install/Migrate-ApiCredentials.ps1') -TargetHome $installation.home;return}
 Write-Host 'Controlled API routes are optional. Prepare provider-config.example.json from the package templates; confirm platform model/max capability before enabling.'
 $configPath=Read-Host 'Full path to your provider configuration JSON'
 & (Join-Path $installation.package 'install/Set-ProviderConfig.ps1') -TargetHome $installation.home -ConfigPath $configPath
 $config=Get-Content -LiteralPath (Join-Path $installation.home '.local/state/pi-kether/provider-config.json') -Raw | ConvertFrom-Json
 $references=@($config.routes.PSObject.Properties | ForEach-Object {$_.Value.credentialRef} | Sort-Object -Unique)
 foreach($reference in $references){
   Write-Host ('Configure API key reference: '+$reference)
   & (Join-Path $installation.package 'install/Set-ProviderApiKey.ps1') -TargetHome $installation.home -CredentialRef $reference
 }
 Write-Host 'Configured. Query list_capabilities and select yhwh-worker-api or yhwh-reviewer-api explicitly. No network/model test has run.'
} finally {$env:PATH=$oldPath}
