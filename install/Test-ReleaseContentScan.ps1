#Requires -Version 7.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$testRoot=Join-Path $repo '.test'
$fixture=Join-Path $testRoot ('release-content-scan-'+[guid]::NewGuid().ToString('N'))
$parent=[IO.Path]::GetFullPath($testRoot).TrimEnd('\')+'\'
if(-not [IO.Path]::GetFullPath($fixture).StartsWith($parent,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe test root.'}
New-Item -ItemType Directory -Force -Path (Join-Path $fixture 'payload/.local-evidence'),(Join-Path $fixture '.test') | Out-Null
$scan=Join-Path $PSScriptRoot 'Test-ReleaseContents.ps1';$file=Join-Path $fixture 'payload/.local-evidence/check.txt'
$checks=0
function Check([bool]$Ok,[string]$Name){if(-not $Ok){throw "FAIL: $Name"};$script:checks++;Write-Output "PASS: $Name"}
function Reject([scriptblock]$Action,[string]$Reason){$caught=$false;try{& $Action 6>$null}catch{$caught=$_.Exception.Message.Contains($Reason);if(-not $caught){throw}};Check $caught ('reject '+$Reason)}
try{
 [IO.File]::WriteAllText($file,'safe fixture');& $scan -PackageRoot $fixture 6>$null;Check $true 'complete stage passes'
 $hostPath='C:'+'\Users\'+'asus';[IO.File]::WriteAllText($file,$hostPath)
 Reject {& $scan -PackageRoot $fixture} 'machine-specific path'
 [IO.File]::WriteAllText($file,$hostPath.Replace('\','/'))
 Reject {& $scan -PackageRoot $fixture} 'machine-specific path'
 $fake='sk-'+'super-secret-123456789';$secret='sk-'+('z'*28)
 [IO.File]::WriteAllText($file,$fake);& $scan -PackageRoot $fixture 6>$null;Check $true 'known exact fixture retained'
 [IO.File]::WriteAllText($file,$fake+' '+$secret);Reject {& $scan -PackageRoot $fixture} 'credential or machine-specific'
 [IO.File]::WriteAllText($file,'safe fixture');[IO.File]::WriteAllText((Join-Path $fixture '.test/baseline-failures.json'),$secret)
 Reject {& $scan -PackageRoot $fixture} 'credential or machine-specific'
 [IO.File]::WriteAllText((Join-Path $fixture '.test/baseline-failures.json'),'safe fixture')
 [IO.File]::WriteAllText((Join-Path $fixture '.test/baseline-failures.json'),'{}')
 $escaped=Join-Path $fixture 'payload/escaped.json';@{path=$hostPath}|ConvertTo-Json|Set-Content -LiteralPath $escaped -Encoding utf8NoBOM
 Reject {& $scan -PackageRoot $fixture} 'credential or machine-specific'
 @{path=$hostPath.Replace('\','/')}|ConvertTo-Json|Set-Content -LiteralPath $escaped -Encoding utf8NoBOM
 Reject {& $scan -PackageRoot $fixture} 'credential or machine-specific'
 [IO.File]::WriteAllText($escaped,'{"ok":true}')
 $prohibited=Join-Path $fixture 'payload/.env.local';[IO.File]::WriteAllText($prohibited,'fixture')
 Reject {& $scan -PackageRoot $fixture} 'prohibited local-state file'
 Remove-Item -LiteralPath $prohibited
 $archive=Join-Path $fixture 'payload/hidden.zip';[IO.File]::WriteAllText($archive,'fixture')
 Reject {& $scan -PackageRoot $fixture} 'prohibited local-state file'
 Write-Output "PASS: $checks release-content checks; no external files or network."
}finally{
 if(Test-Path -LiteralPath $fixture){$resolved=(Resolve-Path -LiteralPath $fixture).Path;if(-not $resolved.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe cleanup path.'};Remove-Item -LiteralPath $resolved -Recurse -Force}
}
