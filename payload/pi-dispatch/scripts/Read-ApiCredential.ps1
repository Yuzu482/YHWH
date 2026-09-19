#requires -Version 5.1
param([Parameter(Mandatory)][string]$TargetHome,[Parameter(Mandatory)][ValidateSet('Anthropic','Provider')][string]$Store,[Parameter(Mandatory)][string]$Reference)
$ErrorActionPreference='Stop'
try {
 . (Join-Path $PSScriptRoot 'ApiCredentialStore.ps1')
 $file=Get-YhwhCredentialFile $TargetHome $Store
 $entries=Read-YhwhApiStore $file
 if(-not $entries.ContainsKey($Reference)){throw 'PI_AUTH_MISSING'}
 $value=Unprotect-YhwhApiKey $entries[$Reference] $Store $Reference
 # stdout is a captured private process pipe; never invoke this helper interactively.
 [Console]::Out.Write($value)
} catch {
 $code=$_.Exception.Message
 if($code -cnotmatch '^PI_AUTH_(MISSING|INVALID|MIGRATION_REQUIRED|DECRYPT_FAILED)$'){$code='PI_AUTH_DECRYPT_FAILED'}
 [Console]::Error.WriteLine($code);exit 4
} finally {$value=$null}
