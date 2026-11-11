#Requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$FixtureParent)
$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'DeploymentMainPolicy.ps1')
if (-not [IO.Path]::IsPathFullyQualified($FixtureParent)) { throw 'CI fixture parent must be an absolute path.' }
$parent = [IO.Path]::GetFullPath($FixtureParent).TrimEnd('\','/')
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'CI fixture parent does not exist.' }
if ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'CI fixture parent cannot be a link.' }
if (-not (Test-Path -LiteralPath (Join-Path $source '.git'))) { throw 'CI preview requires a Git checkout.' }
function Git([string]$Directory,[string[]]$Arguments) {
  $result = Invoke-DeploymentGit -Repository $Directory -GitArguments (@('-c','core.longpaths=true')+$Arguments) -IsolatedGit
  if (-not (Test-DeploymentProcessSuccess $result)) { throw "CI fixture Git command failed (exit $($result.status); timeout=$($result.timedOut); outputLimit=$($result.outputLimit)): $($result.stderr) $($result.error)" }
  return $result.stdout.Trim()
}
$status = Git $source @('status','--porcelain','--untracked-files=all')
if ($status) { throw 'CI preview requires a clean source checkout.' }
$sourceTree = Git $source @('rev-parse','--verify','HEAD^{tree}')
if ($sourceTree -cnotmatch '^[a-f0-9]{40,64}$') { throw 'Cannot identify the CI source tree.' }
$fixture = Join-Path $parent ('ycp-'+[guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $fixture) { throw 'CI fixture destination already exists.' }
New-Item -ItemType Directory -Path $fixture | Out-Null
$mirror = Join-Path $fixture 'm'
$origin = Join-Path $fixture 'o.git'
$checkout = Join-Path $fixture 'w'
$output = Join-Path $fixture 'out'
Write-Host 'CI preview: local disposable Git origin; this is not a published or mainline release.'
[void](Git $fixture @('clone','--quiet','--no-local','--no-checkout','--',$source,$mirror))
$mirrorTree = Git $mirror @('rev-parse','--verify','HEAD^{tree}')
if ($mirrorTree -cne $sourceTree) { throw 'CI source tree changed while creating the preview.' }
$previewCommit = Git $mirror @('-c','user.name=CI Preview','-c','user.email=ci-preview@invalid.example','-c','commit.gpgsign=false','commit-tree',$sourceTree,'-m','Temporary CI preview; not a release')
if ($previewCommit -cnotmatch '^[a-f0-9]{40,64}$') { throw 'Cannot create the temporary CI preview commit.' }
[void](Git $fixture @('init','--quiet','--bare','--initial-branch=main',$origin))
[void](Git $mirror @('push','--quiet','--no-verify','--',$origin,($previewCommit+':refs/heads/main')))
[void](Git $fixture @('-c','core.autocrlf=false','clone','--quiet','--no-local','--branch','main','--',$origin,$checkout))
if ((Git $checkout @('rev-parse','--verify','HEAD')) -cne $previewCommit -or (Git $checkout @('rev-parse','--verify','HEAD^{tree}')) -cne $sourceTree -or (Git $checkout @('status','--porcelain','--untracked-files=all'))) { throw 'CI preview does not match the clean source tree.' }
if ((Git $source @('rev-parse','--verify','HEAD^{tree}')) -cne $sourceTree -or (Git $source @('status','--porcelain','--untracked-files=all'))) { throw 'CI source changed during preview setup.' }
& (Join-Path $checkout 'Build-Release.ps1') -SkipTests -OutputDirectory $output
Write-Host 'CI preview completed; no preview artifact is published by this workflow.'
