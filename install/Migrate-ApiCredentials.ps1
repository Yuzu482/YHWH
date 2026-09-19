#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][string]$TargetHome)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../payload/pi-dispatch/scripts/ApiCredentialStore.ps1')
foreach($store in @('Anthropic','Provider')) {
 $file=Get-YhwhCredentialFile $TargetHome $store
 if(-not(Test-Path -LiteralPath $file)){continue}
 $entries=Read-YhwhApiStore $file;$changed=$false
 foreach($reference in @($entries.Keys)) {
  $entry=$entries[$reference]
  if($entry.type -eq 'api_key') {
   $cipher=Protect-YhwhApiKey $entry.key $store $reference
   if((Unprotect-YhwhApiKey $cipher $store $reference) -cne $entry.key){throw 'PI_AUTH_ENCRYPT_FAILED'}
   $entries[$reference]=$cipher;$changed=$true
  } else {$null=Unprotect-YhwhApiKey $entry $store $reference}
 }
 if($changed){Write-YhwhEncryptedStore $file $entries}
 Write-Host ($store+': encrypted format verified. No plaintext backup created.')
}
