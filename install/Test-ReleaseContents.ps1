#Requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$PackageRoot)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($PackageRoot).TrimEnd('\','/')
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'Release stage is missing.' }
function Get-SafeReleaseFiles([string]$Directory) {
  foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Release stage contains a link.' }
    if ($item.PSIsContainer) {
      if ($item.Name -in @('node_modules','.git','.runtime','diagnostics','release')) { throw 'Release stage contains runtime or Git state.' }
      Get-SafeReleaseFiles $item.FullName
    } else {
      if ($item.Name -match '(?i)^\.git$|^auth\.json$|^(anthropic-api-key|provider-config|provider-credentials)\.json$|^\.env|\.local\.|\.(log|bak|backup|pyc|zip)$|^(?:.*token|.*key).*\.txt$') { throw 'Release stage contains a prohibited local-state file.' }
      $item
    }
  }
}
$separator = '[\\/]'
$hostUserPattern = 'C:' + $separator + 'Users' + $separator + 'asus'
$hostRepoPattern = 'E:' + $separator + 'Projects' + $separator + 'DeepSeekHarness'
$oldTunnel = 'tunnel_' + '6a9aa889406481918ef6a135c41493c7'
$forbidden='(?i)'+$hostUserPattern+'|'+$hostRepoPattern+'|'+[regex]::Escape($oldTunnel)+'|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|sk-[A-Za-z0-9_-]{20,}'
function Assert-SafeJsonValue($Value,[string]$Relative) {
  if($null -eq $Value){return}
  if($Value -is [string]){
    $plain=$Value.Replace('sk-super-secret-123456789','').Replace('sk-request-secret-12345678','')
    if($plain -match $forbidden){throw ('Release stage contains a credential or machine-specific path: '+$Relative)}
  } elseif($Value -is [System.Collections.IDictionary]){
    foreach($key in $Value.Keys){Assert-SafeJsonValue ([string]$key) $Relative;Assert-SafeJsonValue $Value[$key] $Relative}
  } elseif($Value -is [System.Collections.IEnumerable]){
    foreach($item in $Value){Assert-SafeJsonValue $item $Relative}
  }
}
$count=0
foreach($file in @(Get-SafeReleaseFiles $root)) {
  $count++
  # These two inert test fixtures already have exact exemptions in the
  # existing source scanner. Remove just the fixture token, not the line,
  # so a second secret on that line is still detected.
  foreach($hit in @(Select-String -LiteralPath $file.FullName -Pattern $forbidden -ErrorAction Stop)) {
    $line=$hit.Line.Replace('sk-super-secret-123456789','').Replace('sk-request-secret-12345678','')
    if($line -match $forbidden) { throw ('Release stage contains a credential or machine-specific path: '+[IO.Path]::GetRelativePath($root,$file.FullName)) }
  }
  # JSON escapes backslashes and Unicode, so raw line scanning alone cannot
  # detect a machine-specific path encoded inside a JSON string.
  if($file.Extension -ieq '.json'){
    if($file.Length -gt 16MB){throw 'Release JSON exceeds the bounded scan size.'}
    try{$parsed=ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($file.FullName)) -AsHashtable -Depth 100 -NoEnumerate -ErrorAction Stop}catch{throw ('Invalid release JSON: '+[IO.Path]::GetRelativePath($root,$file.FullName))}
    Assert-SafeJsonValue $parsed ([IO.Path]::GetRelativePath($root,$file.FullName))
  }
}
Write-Host "[PASS] Scanned $count staged release files for local paths, credentials, links and runtime state."
