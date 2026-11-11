#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'DeploymentMainPolicy.ps1')
$testRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
$fixture = Join-Path $testRoot ('yct-'+[guid]::NewGuid().ToString('N'))
if (-not [IO.Path]::GetFullPath($fixture).StartsWith($testRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test fixture path.' }
$source = Join-Path $fixture 'source'
$previewParent = Join-Path $fixture 'previews'
New-Item -ItemType Directory -Path (Join-Path $source 'install'),$previewParent -Force | Out-Null
function Git([string]$Directory,[string[]]$Arguments) {
  $result = Invoke-DeploymentGit -Repository $Directory -GitArguments $Arguments -IsolatedGit
  if (-not (Test-DeploymentProcessSuccess $result)) { throw "Fixture Git failed: $($result.stderr) $($result.error)" }
  return $result.stdout.Trim()
}
try {
  [void](Git $source @('init','--quiet','--initial-branch=feature'))
  [void](Git $source @('config','user.name','CI Preview Test'))
  [void](Git $source @('config','user.email','ci-preview-test@invalid.example'))
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'DeploymentMainPolicy.ps1'),(Join-Path $PSScriptRoot 'Invoke-CiReleasePreview.ps1') -Destination (Join-Path $source 'install')
  [IO.File]::WriteAllText((Join-Path $source '.gitignore'),"fixture-private.txt`n",[Text.UTF8Encoding]::new($false))
  $stub = @'
param([switch]$SkipTests,[string]$OutputDirectory)
$ErrorActionPreference='Stop'
if(-not $SkipTests -or -not $OutputDirectory){throw 'Preview must use the preview-only build mode.'}
if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'fixture-private.txt')){throw 'Ignored local data entered the preview.'}
New-Item -ItemType Directory -Path $OutputDirectory -Force|Out-Null
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'preview-ok.txt'),'preview fixture only')
'@
  [IO.File]::WriteAllText((Join-Path $source 'Build-Release.ps1'),$stub,[Text.UTF8Encoding]::new($false))
  [void](Git $source @('add','.'))
  [void](Git $source @('-c','commit.gpgsign=false','commit','--quiet','-m','fixture'))
  $originalHead = Git $source @('rev-parse','HEAD')
  $originalTree = Git $source @('rev-parse','HEAD^{tree}')
  [IO.File]::WriteAllText((Join-Path $source 'fixture-private.txt'),'fixture-only ignored data')
  $dirty = Join-Path $source 'dirty-untracked.txt'
  [IO.File]::WriteAllText($dirty,'fixture-only untracked data')
  $rejected = $false
  try { & (Join-Path $source 'install\Invoke-CiReleasePreview.ps1') -FixtureParent $previewParent } catch { $rejected = $_.Exception.Message.Contains('clean source checkout'); if (-not $rejected) { throw } }
  if (-not $rejected) { throw 'CI preview accepted a dirty checkout.' }
  [IO.File]::Delete($dirty)
  & (Join-Path $source 'install\Invoke-CiReleasePreview.ps1') -FixtureParent $previewParent
  $previews = @(Get-ChildItem -LiteralPath $previewParent -Directory -Filter 'ycp-*')
  if ($previews.Count -ne 1) { throw 'Expected exactly one successful local preview fixture.' }
  $checkout = Join-Path $previews[0].FullName 'w'
  $marker = Join-Path $previews[0].FullName 'out\preview-ok.txt'
  if (-not (Test-Path -LiteralPath $marker) -or (Git $checkout @('rev-parse','HEAD^{tree}')) -cne $originalTree) { throw 'Preview did not build the exact committed source tree.' }
  if ((Git $source @('rev-parse','HEAD')) -cne $originalHead -or (Git $source @('status','--porcelain','--untracked-files=all'))) { throw 'Preview modified the original checkout.' }
  [IO.File]::WriteAllText((Join-Path $source 'second-commit.txt'),'fixture second commit')
  [void](Git $source @('add','second-commit.txt'))
  [void](Git $source @('-c','commit.gpgsign=false','commit','--quiet','-m','second fixture commit'))
  $shallow = Join-Path $fixture 'shallow'
  [void](Git $fixture @('clone','--quiet','--no-local','--depth=1','--branch','feature','--',$source,$shallow))
  if ((Git $shallow @('rev-parse','--is-shallow-repository')) -cne 'true') { throw 'Expected a shallow checkout fixture.' }
  $shallowTree = Git $shallow @('rev-parse','HEAD^{tree}')
  & (Join-Path $shallow 'install\Invoke-CiReleasePreview.ps1') -FixtureParent $previewParent
  $previews = @(Get-ChildItem -LiteralPath $previewParent -Directory -Filter 'ycp-*')
  $matching = @($previews | Where-Object { (Git (Join-Path $_.FullName 'w') @('rev-parse','HEAD^{tree}')) -ceq $shallowTree })
  if ($previews.Count -ne 2 -or $matching.Count -ne 1 -or -not (Test-Path -LiteralPath (Join-Path $matching[0].FullName 'out\preview-ok.txt'))) { throw 'Shallow checkout preview did not build the exact source tree.' }
  Write-Output 'PASS: CI preview rejects dirty source, excludes ignored local data, builds exact normal and shallow source trees and leaves the original checkout unchanged.'
} finally {
  if (Test-Path -LiteralPath $fixture) {
    $resolved = (Resolve-Path -LiteralPath $fixture).Path
    if (-not $resolved.StartsWith($testRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test fixture cleanup path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
