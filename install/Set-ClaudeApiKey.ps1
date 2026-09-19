#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][string]$TargetHome)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../payload/pi-dispatch/scripts/ApiCredentialStore.ps1')
function Set-YhwhClaudeApiKey([string]$HomePath,[Security.SecureString]$ApiKey) {
 Set-YhwhEncryptedApiKey -HomePath $HomePath -Store Anthropic -Reference 'anthropic' -ApiKey $ApiKey
}
$keyInput=Read-Host 'API key (hidden; saved using Windows user encryption)' -AsSecureString
try {Set-YhwhClaudeApiKey -HomePath $TargetHome -ApiKey $keyInput} finally {$keyInput.Dispose()}
