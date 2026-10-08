#requires -Version 7.0
param(
  [switch]$Check,
  [switch]$InstallHost,
  [string]$TargetHome = $HOME
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
function Neutral([string]$Text) {
  return $Text.Replace('ChatGPT Work/Codex -> Pi -> openai-codex','primary host -> Pi -> approved role-bound providers').Replace('ChatGPT Work and Codex','the primary host').Replace('ChatGPT and Pi','the primary host and Pi').Replace('this Codex home','this host workflow').Replace('Codex and ChatGPT Work','the primary host').Replace('ChatGPT Work/Codex','the primary host')
}
$topics=[ordered]@{primary=(Get-Content -LiteralPath (Join-Path $root 'templates/host-primary.md') -Raw).Replace("`r`n","`n")}
foreach($file in Get-ChildItem -LiteralPath (Join-Path $root 'templates/agent-references') -Filter '*.md' | Sort-Object Name){$topics[$file.BaseName]=Neutral ((Get-Content -LiteralPath $file.FullName -Raw).Replace("`r`n","`n"))}
$governanceSkill=Join-Path $root 'payload/workflow-skills/kether-governance'
$topics['skill:kether-governance']=Neutral ((Get-Content -LiteralPath (Join-Path $governanceSkill 'SKILL.md') -Raw).Replace("`r`n","`n"))
$json=([ordered]@{version=1;topics=$topics}|ConvertTo-Json -Depth 8)-replace "`r`n","`n"
$path=Join-Path $root 'payload/pi-dispatch/workflow/catalog.json'
if ($Check -and $InstallHost) { throw 'Use -Check or -InstallHost, not both.' }
if ($Check) {
  if (-not(Test-Path -LiteralPath $path) -or ((Get-Content -LiteralPath $path -Raw)-replace "`r`n","`n").Trim() -cne $json.Trim()) { throw 'Workflow catalog is stale. Run install/Sync-HostWorkflow.ps1.' }
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
  [IO.File]::WriteAllText($path, $json+"`n", [Text.UTF8Encoding]::new($false))
}

if ($InstallHost) {
  if (-not [IO.Path]::IsPathFullyQualified($TargetHome)) { throw 'TargetHome must be an absolute path.' }
  $homePath = [IO.Path]::GetFullPath($TargetHome)
  $rootPath = [IO.Path]::GetPathRoot($homePath)
  if ($homePath.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) -eq $rootPath.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)) { throw 'TargetHome cannot be a filesystem root.' }
  if (-not (Test-Path -LiteralPath $homePath -PathType Container)) { throw 'TargetHome must be an existing directory.' }
  $walk = [IO.Path]::GetPathRoot($homePath)
  foreach ($part in $homePath.Substring($walk.Length) -split '[\\/]') {
    if (-not $part) { continue }
    $walk = Join-Path $walk $part
    if ((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing reparse point in TargetHome path: $walk" }
  }

  function Assert-NoReparse([string]$Candidate) {
    $full = [IO.Path]::GetFullPath($Candidate)
    $relative = [IO.Path]::GetRelativePath($homePath, $full)
    if ($relative -eq '..' -or $relative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar) -or [IO.Path]::IsPathRooted($relative)) { throw "Refusing path outside TargetHome: $full" }
    $current = $homePath
    if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing reparse-point TargetHome: $current" }
    foreach ($part in $relative -split '[\\/]') {
      if (-not $part -or $part -eq '.') { continue }
      $current = Join-Path $current $part
      if (Test-Path -LiteralPath $current) {
        $item = Get-Item -LiteralPath $current -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing reparse point: $current" }
      }
    }
  }
  function Assert-TreeNoReparse([string]$Directory) {
    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing reparse point in managed target: $($item.FullName)" }
      if ($item.PSIsContainer) { Assert-TreeNoReparse $item.FullName }
    }
  }
  function Set-ManagedPolicy([string]$FilePath, [string]$TemplateText) {
    $begin = '<!-- PI-KETHER:BEGIN -->'; $end = '<!-- PI-KETHER:END -->'
    $old = if (Test-Path -LiteralPath $FilePath -PathType Leaf) { [IO.File]::ReadAllText($FilePath) } else { '' }
    $pattern = '(?s)<!-- PI-KETHER:BEGIN -->.*?<!-- PI-KETHER:END -->'
    $matches = [regex]::Matches($old, $pattern)
    $beginCount = [regex]::Matches($old, [regex]::Escape($begin)).Count
    $endCount = [regex]::Matches($old, [regex]::Escape($end)).Count
    if ($matches.Count -gt 1 -or $beginCount -ne $endCount -or $beginCount -ne $matches.Count) { throw 'AGENTS.md has ambiguous or unmatched PI-KETHER markers.' }
    $block = "$begin`r`n$($TemplateText.TrimEnd())`r`n$end"
    if ($matches.Count -eq 1) {
      $match = $matches[0]
      $new = $old.Substring(0, $match.Index) + $block + $old.Substring($match.Index + $match.Length)
    }
    elseif ([string]::IsNullOrWhiteSpace($old)) { $new = $block + "`r`n" }
    else { $new = $old.TrimEnd() + "`r`n`r`n" + $block + "`r`n" }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $FilePath) | Out-Null
    [IO.File]::WriteAllText($FilePath, $new, [Text.UTF8Encoding]::new($false))
  }

  $referencesSource = Join-Path $root 'templates/agent-references'
  $governanceSource = Join-Path $root 'payload/workflow-skills/kether-governance'
  $piSkillSource = Join-Path $root 'payload/pi-dispatch/skills/pi-dispatch/SKILL.md'
  $catalogSource = Join-Path $root 'payload/pi-dispatch/workflow/catalog.json'
  $pluginManifestSource = Join-Path $root 'payload/pi-dispatch/.codex-plugin/plugin.json'
  $agentsSource = Join-Path $root 'templates/AGENTS.kether.md'
  $workflowRoot = Join-Path $root 'payload/workflow-skills'
  foreach ($source in @($referencesSource, $governanceSource, $piSkillSource, $catalogSource, $pluginManifestSource, $agentsSource)) { if (-not (Test-Path -LiteralPath $source)) { throw "Required source missing: $source" } }

  $referencesTarget = Join-Path $homePath '.codex/agent-references'
  $governanceTarget = Join-Path $homePath '.agents/skills/kether-governance'
  $agentsTarget = Join-Path $homePath '.codex/AGENTS.md'
  $piSkillTarget = Join-Path $homePath 'plugins/pi-dispatch/skills/pi-dispatch/SKILL.md'
  $catalogTarget = Join-Path $homePath 'plugins/pi-dispatch/workflow/catalog.json'
  $pluginManifestTarget = Join-Path $homePath 'plugins/pi-dispatch/.codex-plugin/plugin.json'
  $hashManifestTarget = Join-Path $homePath '.codex/yhwh-managed-hashes.json'
  $retiredReferenceTarget = Join-Path $referencesTarget 'governance.md'
  $retireGovernanceReference = -not (Test-Path -LiteralPath (Join-Path $referencesSource 'governance.md') -PathType Leaf)
  $skillsRoot = Join-Path $homePath '.agents/skills'
  $retired = @(Get-ChildItem -LiteralPath $workflowRoot -Directory | Where-Object Name -ne 'kether-governance' | Sort-Object Name)
  $targets = [Collections.Generic.List[string]]::new()
  $targets.Add($governanceTarget); $targets.Add($agentsTarget); $targets.Add($piSkillTarget); $targets.Add($catalogTarget); $targets.Add($pluginManifestTarget); $targets.Add($hashManifestTarget)
  if ($retireGovernanceReference) { $targets.Add($retiredReferenceTarget) }
  foreach ($reference in Get-ChildItem -LiteralPath $referencesSource -File -Filter '*.md') { $targets.Add((Join-Path $referencesTarget $reference.Name)) }
  foreach ($skill in $retired) { $targets.Add((Join-Path $skillsRoot $skill.Name)) }
  foreach ($target in $targets) {
    Assert-NoReparse $target
    if (Test-Path -LiteralPath $target -PathType Container) { Assert-TreeNoReparse $target }
  }
  $backupBase = Join-Path $homePath '.codex/backups/yhwh-host-workflow'
  Assert-NoReparse $backupBase
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $backupRoot = Join-Path $backupBase $stamp
  if (Test-Path -LiteralPath $backupRoot) { throw "Backup collision: $backupRoot" }
  foreach ($target in $targets) {
    if (Test-Path -LiteralPath $target) {
      $relative = [IO.Path]::GetRelativePath($homePath, $target)
      $backupPath = Join-Path $backupRoot $relative
      if (Test-Path -LiteralPath $backupPath) { throw "Backup collision: $backupPath" }
    }
  }

  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  $changed = [Collections.Generic.List[string]]::new()
  foreach ($target in $targets) {
    if (Test-Path -LiteralPath $target) {
      $relative = [IO.Path]::GetRelativePath($homePath, $target)
      $backupPath = Join-Path $backupRoot $relative
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupPath) | Out-Null
      if ($target -eq $agentsTarget) { Copy-Item -LiteralPath $target -Destination $backupPath }
      else { Move-Item -LiteralPath $target -Destination $backupPath }
      $changed.Add("Archived: $target -> $backupPath")
    }
  }
  New-Item -ItemType Directory -Force -Path $referencesTarget, $skillsRoot, (Split-Path -Parent $piSkillTarget), (Split-Path -Parent $catalogTarget) | Out-Null
  foreach ($reference in Get-ChildItem -LiteralPath $referencesSource -File -Filter '*.md') {
    Copy-Item -LiteralPath $reference.FullName -Destination (Join-Path $referencesTarget $reference.Name)
    $changed.Add((Join-Path $referencesTarget $reference.Name))
  }
  Copy-Item -LiteralPath $governanceSource -Destination $governanceTarget -Recurse
  $changed.Add($governanceTarget)
  Copy-Item -LiteralPath $piSkillSource -Destination $piSkillTarget
  $changed.Add($piSkillTarget)
  Copy-Item -LiteralPath $catalogSource -Destination $catalogTarget
  $changed.Add($catalogTarget)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pluginManifestTarget) | Out-Null
  Copy-Item -LiteralPath $pluginManifestSource -Destination $pluginManifestTarget
  & (Join-Path $PSScriptRoot 'Set-InstalledPluginVersion.ps1') -PackageRoot $root -PluginRoot (Join-Path $homePath 'plugins/pi-dispatch') | Out-Null
  $changed.Add($pluginManifestTarget)
  Set-ManagedPolicy $agentsTarget ([IO.File]::ReadAllText($agentsSource))
  $changed.Add($agentsTarget)
  $hindsightSkill = Join-Path $homePath '.agents/skills/hindsight-coding-agent/SKILL.md'
  if (Test-Path -LiteralPath $hindsightSkill -PathType Leaf) {
    & (Join-Path $PSScriptRoot 'Apply-HindsightWrapper.ps1') -TargetHome $homePath
    if (-not $?) { throw 'Hindsight wrapper update failed.' }
    $changed.Add($hindsightSkill)
  }
  $hashes = [ordered]@{}
  foreach ($reference in Get-ChildItem -LiteralPath $referencesSource -File -Filter '*.md' | Sort-Object Name) {
    $key = '.codex/agent-references/' + $reference.Name
    $hashes[$key] = (Get-FileHash -LiteralPath $reference.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  foreach ($file in Get-ChildItem -LiteralPath $governanceSource -File -Recurse | Sort-Object FullName) {
    $relative = [IO.Path]::GetRelativePath($governanceSource, $file.FullName).Replace([IO.Path]::DirectorySeparatorChar.ToString(), '/')
    $hashes['.agents/skills/kether-governance/' + $relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $hashes['plugins/pi-dispatch/skills/pi-dispatch/SKILL.md'] = (Get-FileHash -LiteralPath $piSkillSource -Algorithm SHA256).Hash.ToLowerInvariant()
  $hashes['plugins/pi-dispatch/workflow/catalog.json'] = (Get-FileHash -LiteralPath $catalogSource -Algorithm SHA256).Hash.ToLowerInvariant()
  $hashes['plugins/pi-dispatch/.codex-plugin/plugin.json'] = (Get-FileHash -LiteralPath $pluginManifestTarget -Algorithm SHA256).Hash.ToLowerInvariant()
  $managedBlock = "<!-- PI-KETHER:BEGIN -->`r`n$([IO.File]::ReadAllText($agentsSource).TrimEnd())`r`n<!-- PI-KETHER:END -->"
  $blockBytes = [Text.UTF8Encoding]::new($false).GetBytes($managedBlock)
  $hashes['.codex/AGENTS.md#PI-KETHER'] = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($blockBytes)).ToLowerInvariant()
  $manifest = [ordered]@{ schemaVersion = 1; files = $hashes } | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($hashManifestTarget, $manifest + "`n", [Text.UTF8Encoding]::new($false))
  $changed.Add($hashManifestTarget)
  Write-Host "Backup: $backupRoot"
  Write-Host 'Changed targets:'
  foreach ($item in $changed) { Write-Host "  $item" }
}
