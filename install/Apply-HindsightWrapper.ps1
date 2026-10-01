#Requires -Version 7.0
[CmdletBinding()]
param(
  [string]$TargetHome = $HOME,
  [switch]$Check
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$template = Join-Path $root 'templates/hindsight-coding-agent/SKILL.md'
$homePath = [IO.Path]::GetFullPath($TargetHome)
if (-not [IO.Path]::IsPathFullyQualified($TargetHome) -or -not (Test-Path -LiteralPath $homePath -PathType Container)) { throw 'TargetHome must be an existing absolute directory.' }
if ($homePath.TrimEnd([IO.Path]::DirectorySeparatorChar) -eq [IO.Path]::GetPathRoot($homePath).TrimEnd([IO.Path]::DirectorySeparatorChar)) { throw 'TargetHome cannot be a filesystem root.' }

function Assert-SafePath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  $relative = [IO.Path]::GetRelativePath($homePath, $full)
  if ($relative -eq '..' -or $relative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar) -or [IO.Path]::IsPathRooted($relative)) { throw "Path escapes TargetHome: $full" }
  $walk = [IO.Path]::GetPathRoot($homePath)
  foreach ($part in $homePath.Substring($walk.Length) -split '[\\/]') {
    if (-not $part) { continue }
    $walk = Join-Path $walk $part
    if ((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point in TargetHome: $walk" }
  }
  $walk = $homePath
  foreach ($part in $relative -split '[\\/]') {
    if (-not $part -or $part -eq '.') { continue }
    $walk = Join-Path $walk $part
    if (Test-Path -LiteralPath $walk) {
      if ((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point in target: $walk" }
    }
  }
}

$skillDir = Join-Path $homePath '.agents/skills/hindsight-coding-agent'
$skillFile = Join-Path $skillDir 'SKILL.md'
$referencesDir = Join-Path $skillDir 'references'
foreach ($path in @($skillDir, $skillFile, $referencesDir)) { Assert-SafePath $path }
if (-not (Test-Path -LiteralPath $skillFile -PathType Leaf)) { Write-Host 'Hindsight skill is absent; wrapper skipped.'; return }
if (-not (Test-Path -LiteralPath $template -PathType Leaf)) { throw "Wrapper template missing: $template" }

$sections = [ordered]@{
  'overview.md' = '# Hindsight Coding-Agent Memory'
  'installation.md' = '## Install / update'
  'configuration-basics.md' = '## Configuration'
  'configuration-opt-in.md' = '### Opt-in only'
  'configuration-reference.md' = '### Reference'
  'bank-resolution.md' = '### Bank resolution'
  'diagnostics.md' = '## Diagnostics & logging'
}
$referenceFiles = @($sections.Keys | ForEach-Object { Join-Path $referencesDir $_ })
$templateHash = (Get-FileHash -LiteralPath $template -Algorithm SHA256).Hash
$installedHash = (Get-FileHash -LiteralPath $skillFile -Algorithm SHA256).Hash
$allReferences = @($referenceFiles | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }).Count -eq $referenceFiles.Count
if ($Check) {
  if ($installedHash -ne $templateHash -or -not $allReferences) { throw 'Hindsight wrapper differs from repository template or reference files are missing.' }
  Write-Host 'Hindsight wrapper and seven references are installed.'
  return
}
if ($installedHash -eq $templateHash -and $allReferences) { Write-Host 'Hindsight wrapper already current.'; return }

$current = [IO.File]::ReadAllText($skillFile).Replace("`r`n", "`n")
$isWrapper = $current.Contains('progressive-disclosure wrapper')
if ($isWrapper -and -not $allReferences) { throw 'Existing Hindsight wrapper has missing references; restore the upstream SKILL.md before reapplying.' }
$content = [ordered]@{}
if (-not $isWrapper) {
  if (-not $current.StartsWith("---`n")) { throw 'Unexpected Hindsight source skill format; no files changed.' }
  $positions = @()
  foreach ($heading in $sections.Values) {
    $matches = [regex]::Matches($current, '(?m)^' + [regex]::Escape($heading) + '[ \t]*$')
    if ($matches.Count -ne 1) { throw "Expected one Hindsight section '$heading'; found $($matches.Count). No files changed." }
    $positions += $matches[0].Index
  }
  for ($i=1; $i -lt $positions.Count; $i++) {
    if ($positions[$i] -le $positions[$i-1]) { throw 'Hindsight section order changed; no files changed.' }
  }
  $names = @($sections.Keys)
  for ($i=0; $i -lt $names.Count; $i++) {
    $end = if ($i+1 -lt $positions.Count) { $positions[$i+1] } else { $current.Length }
    $content[$names[$i]] = $current.Substring($positions[$i], $end-$positions[$i])
  }
}

$backupBase = Join-Path $homePath '.codex/backups/yhwh-hindsight'
Assert-SafePath $backupBase
$backupRoot = Join-Path $backupBase (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
Assert-SafePath $backupRoot
if (Test-Path -LiteralPath $backupRoot) { throw "Backup collision: $backupRoot" }
if (Test-Path -LiteralPath $referencesDir -PathType Container) {
  foreach ($item in Get-ChildItem -LiteralPath $referencesDir -Recurse -Force) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point in Hindsight references: $($item.FullName)" }
  }
}
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
Copy-Item -LiteralPath $skillFile -Destination (Join-Path $backupRoot 'SKILL.original.md')
if (Test-Path -LiteralPath $referencesDir -PathType Container) { Copy-Item -LiteralPath $referencesDir -Destination (Join-Path $backupRoot 'references') -Recurse }
New-Item -ItemType Directory -Force -Path $referencesDir | Out-Null
foreach ($name in $content.Keys) {
  [IO.File]::WriteAllText((Join-Path $referencesDir $name), $content[$name], [Text.UTF8Encoding]::new($false))
}
Copy-Item -LiteralPath $template -Destination $skillFile -Force
Write-Host "Hindsight wrapper applied; original backed up at $backupRoot"
