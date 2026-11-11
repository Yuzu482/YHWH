#Requires -Version 7.0
# Read-only preflight: an existing user's governance and plugin registration
# must not be replaced by a different policy during a portable reinstall.
function Assert-HostPolicyPreserved([string]$TargetHome,[string]$PackageRoot) {
  $template=Join-Path $PackageRoot 'templates/AGENTS.kether.md'
  $references=Join-Path $PackageRoot 'templates/agent-references'
  $skills=Join-Path $PackageRoot 'payload/workflow-skills'
  $agents=Join-Path $TargetHome '.codex/AGENTS.md'
  $config=Join-Path $TargetHome '.codex/config.toml'
  $marketplace=Join-Path $TargetHome '.agents/plugins/marketplace.json'
  $installedSkill=Join-Path $TargetHome '.agents/skills/kether-governance'
  foreach($p in @($agents,$config,$marketplace,$installedSkill)){Assert-NoReparse $p $TargetHome}
  $reuseAgents=$false;$reuseSkill=$false;$reuseConfig=$false;$reuseMarketplace=$false
  if(Test-Path -LiteralPath $agents){
    if(-not (Test-Path -LiteralPath $agents -PathType Leaf) -or (Get-Item -LiteralPath $agents).Length -gt 2MB){throw 'Existing agent instructions cannot be safely classified.'}
    $text=Get-Content -LiteralPath $agents -Raw
    $begin='<!-- PI-KETHER:BEGIN -->';$end='<!-- PI-KETHER:END -->'
    $begins=[regex]::Matches($text,[regex]::Escape($begin)).Count;$ends=[regex]::Matches($text,[regex]::Escape($end)).Count
    if($begins -gt 1 -or $begins -ne $ends){throw 'Existing managed agent instructions are ambiguous; preserve them before reinstalling.'}
    if($begins -eq 1){
      $matches=[regex]::Matches($text,'(?s)'+[regex]::Escape($begin)+'(.*?)'+[regex]::Escape($end))
      if($matches.Count -ne 1){throw 'Existing managed agent instructions are malformed.'}
      $current=$matches[0].Groups[1].Value.Replace("`r`n","`n").Trim()
      $expected=(Get-Content -LiteralPath $template -Raw).Replace("`r`n","`n").Trim()
      if($current -cne $expected){throw 'Existing managed agent instructions differ; preserve them and reconcile before reinstalling.'}
      $reuseAgents=$true
    }
  }
  $sourceSkill=Join-Path $skills 'kether-governance'
  if(Test-Path -LiteralPath $installedSkill){
    if(-not (Test-Path -LiteralPath $installedSkill -PathType Container)){throw 'Existing governance skill is not a directory.'}
    $sourceFiles=@(Get-ChildItem -LiteralPath $sourceSkill -Recurse -Force -File)
    $targetFiles=@(Get-ChildItem -LiteralPath $installedSkill -Recurse -Force -File)
    if($sourceFiles.Count -ne $targetFiles.Count -or $sourceFiles.Count -gt 4096){throw 'Existing governance skill differs; preserve it before reinstalling.'}
    foreach($item in $targetFiles){
      Assert-NoReparse $item.FullName $TargetHome
      $relative=[IO.Path]::GetRelativePath($installedSkill,$item.FullName)
      $expected=Join-Path $sourceSkill $relative
      if(-not (Test-Path -LiteralPath $expected -PathType Leaf) -or $item.Length -gt 16MB -or (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $expected -Algorithm SHA256).Hash){throw 'Existing governance skill differs; preserve it before reinstalling.'}
    }
    $reuseSkill=$true
  }
  foreach($skill in @(Get-ChildItem -LiteralPath $skills -Directory | Where-Object {$_.Name -ne 'kether-governance'})){
    $existing=Join-Path $TargetHome ('.agents/skills/'+$skill.Name);Assert-NoReparse $existing $TargetHome
    if(Test-Path -LiteralPath $existing){throw 'An existing governance-related skill would be retired; preserve it before reinstalling.'}
  }
  foreach($reference in @(Get-ChildItem -LiteralPath $references -File -Filter '*.md')){
    $existing=Join-Path $TargetHome ('.codex/agent-references/'+$reference.Name);Assert-NoReparse $existing $TargetHome
    if((Test-Path -LiteralPath $existing) -and (-not (Test-Path -LiteralPath $existing -PathType Leaf) -or (Get-FileHash -LiteralPath $existing -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $reference.FullName -Algorithm SHA256).Hash)){throw 'Existing agent reference differs; preserve it before reinstalling.'}
  }
  $retired=Join-Path $TargetHome '.codex/agent-references/governance.md';Assert-NoReparse $retired $TargetHome
  if((Test-Path -LiteralPath $retired) -and -not (Test-Path -LiteralPath (Join-Path $references 'governance.md') -PathType Leaf)){throw 'An existing governance reference would be retired; preserve it before reinstalling.'}
  if(Test-Path -LiteralPath $config){
    if(-not (Test-Path -LiteralPath $config -PathType Leaf) -or (Get-Item -LiteralPath $config).Length -gt 2MB){throw 'Existing Codex configuration cannot be safely classified.'}
    $current=Get-Content -LiteralPath $config -Raw
    $updated=& (Join-Path $PackageRoot 'install/Set-CodexFeatures.ps1') -Text $current
    if($current -cne $updated){throw 'Existing Codex feature settings would change; preserve them before reinstalling.'}
    $reuseConfig=$true
  }
  if(Test-Path -LiteralPath $marketplace){
    if(-not (Test-Path -LiteralPath $marketplace -PathType Leaf) -or (Get-Item -LiteralPath $marketplace).Length -gt 2MB){throw 'Existing plugin marketplace cannot be safely classified.'}
    $market=Get-Content -LiteralPath $marketplace -Raw | ConvertFrom-Json -AsHashtable
    $entries=@($market.plugins | Where-Object {$_.name -ceq 'pi-dispatch'})
    if($entries.Count -gt 1){throw 'Existing Pi plugin registration is ambiguous.'}
    if($entries.Count -eq 1){
      $entry=$entries[0]
      if((($entry.Keys|Sort-Object) -join ',') -cne 'category,name,policy,source' -or (($entry.source.Keys|Sort-Object) -join ',') -cne 'path,source' -or (($entry.policy.Keys|Sort-Object) -join ',') -cne 'authentication,installation' -or $entry.source.source -cne 'local' -or $entry.source.path -cne './plugins/pi-dispatch' -or $entry.policy.installation -cne 'AVAILABLE' -or $entry.policy.authentication -cne 'ON_INSTALL' -or $entry.category -cne 'Productivity'){throw 'Existing Pi plugin registration differs; preserve it before reinstalling.'}
      $reuseMarketplace=$true
    }
  }
  return [pscustomobject]@{reuseAgents=$reuseAgents;reuseSkill=$reuseSkill;reuseConfig=$reuseConfig;reuseMarketplace=$reuseMarketplace}
}
