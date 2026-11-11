#Requires -Version 7.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$base=[IO.Path]::GetFullPath((Join-Path $repo '.test')).TrimEnd('\')+'\'
$output=Join-Path $base ('public-release-gate-'+[guid]::NewGuid().ToString('N'))
if(-not [IO.Path]::GetFullPath($output).StartsWith($base,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe fixture output.'}
$rejected=$false
try { & (Join-Path $repo 'Build-Release.ps1') -PublicRelease -SkipTests -OutputDirectory $output } catch {$rejected=$_.Exception.Message.Contains('Public release requires the full plugin regression');if(-not $rejected){throw}}
if(-not $rejected -or (Test-Path -LiteralPath $output)){throw 'Public release must reject skipped plugin tests before creating output.'}
Write-Output 'PASS: public release cannot skip plugin regression or create output first.'
