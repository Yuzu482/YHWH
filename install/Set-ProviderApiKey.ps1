#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][string]$TargetHome,[Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{0,39}$')][string]$CredentialRef)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../payload/pi-dispatch/scripts/ApiCredentialStore.ps1')
function Set-YhwhProviderApiKey([string]$HomePath,[Security.SecureString]$ApiKey,[string]$Reference) {
 Set-YhwhEncryptedApiKey -HomePath $HomePath -Store Provider -Reference $Reference -ApiKey $ApiKey
}
$keyInput=Read-Host 'API key (hidden; saved using Windows user encryption)' -AsSecureString
try {Set-YhwhProviderApiKey -HomePath $TargetHome -ApiKey $keyInput -Reference $CredentialRef} finally {$keyInput.Dispose()}
