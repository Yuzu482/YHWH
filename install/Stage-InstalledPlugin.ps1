#Requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$PackageRoot,[Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference='Stop'
$source=[IO.Path]::GetFullPath((Join-Path $PackageRoot 'payload/pi-dispatch'))
$target=[IO.Path]::GetFullPath($Destination)
if($target -eq $source -or $target.StartsWith($source+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or $source.StartsWith($target+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Installation staging must not overlap the source payload.'}
if(Test-Path -LiteralPath $target){throw 'Installation staging destination already exists.'}
$identity=& (Join-Path $PSScriptRoot 'Get-PluginBuildIdentity.ps1') -PackageRoot $PackageRoot
Copy-Item -LiteralPath $source -Destination $target -Recurse
foreach($relative in @(& (Join-Path $PSScriptRoot 'Get-ReleaseExcludedPaths.ps1'))){
  $prefix='payload/pi-dispatch/'
  if(-not $relative.StartsWith($prefix,[StringComparison]::Ordinal) -or $relative -match '(^|/)\.\.?(/|$)'){throw 'Invalid repository-only fixture path.'}
  $file=Join-Path $target $relative.Substring($prefix.Length)
  if(Test-Path -LiteralPath $file){
    $cursor=$file
    while($cursor -and $cursor.StartsWith($target,[StringComparison]::OrdinalIgnoreCase)){
      if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Repository-only fixture path contains a link or junction.'}
      if($cursor -ceq $target){break}
      $cursor=Split-Path -Parent $cursor
    }
    if((Get-Item -LiteralPath $file -Force).PSIsContainer){throw 'Repository-only fixture is not a file.'}
    Remove-Item -LiteralPath $file -Force
  }
}
& (Join-Path $PSScriptRoot 'Set-InstalledPluginVersion.ps1') -PackageRoot $PackageRoot -PluginRoot $target | Out-Null
$proof=Get-Content -LiteralPath (Join-Path $target 'build-provenance.json') -Raw | ConvertFrom-Json
if($proof.sourceCommit -cne $identity.sourceCommit -or $proof.pluginVersion -cne $identity.pluginVersion -or $proof.dirty -ne $identity.dirty){throw 'Source identity changed during installation staging.'}
# Keep this private staged copy in the installation backup, including on failure.
# It is the exact source for both copying and the mandatory managed-file baseline.
Write-Output $target
