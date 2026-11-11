#Requires -Version 7.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$parent=[IO.Path]::GetFullPath((Join-Path $repo '.test')).TrimEnd('\')+'\'
$fixture=Join-Path $parent ('host-policy-'+[guid]::NewGuid().ToString('N'))
if(-not [IO.Path]::GetFullPath($fixture).StartsWith($parent,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe fixture path.'}
$package=Join-Path $fixture 'package';$target=Join-Path $fixture 'home'
foreach($p in @('templates/agent-references','payload/workflow-skills/kether-governance','payload/workflow-skills/retired-role','install')){New-Item -ItemType Directory -Path (Join-Path $package $p) -Force|Out-Null}
foreach($p in @('.codex/agent-references','.agents/skills/kether-governance','.agents/plugins')){New-Item -ItemType Directory -Path (Join-Path $target $p) -Force|Out-Null}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Set-CodexFeatures.ps1') -Destination (Join-Path $package 'install')
$utf8=[Text.UTF8Encoding]::new($false)
function Put([string]$File,[string]$Text){[IO.File]::WriteAllText($File,$Text,$utf8)}
Put (Join-Path $package 'templates/AGENTS.kether.md') 'fixture managed policy'
Put (Join-Path $package 'templates/agent-references/example.md') 'fixture reference'
Put (Join-Path $package 'payload/workflow-skills/kether-governance/SKILL.md') 'fixture skill'
Put (Join-Path $target '.agents/skills/kether-governance/SKILL.md') 'fixture skill'
Put (Join-Path $target '.codex/agent-references/example.md') 'fixture reference'
$agents=Join-Path $target '.codex/AGENTS.md';$agentText="outside before`n<!-- PI-KETHER:BEGIN -->`nfixture managed policy`n<!-- PI-KETHER:END -->`noutside after`n";Put $agents $agentText
$config=Join-Path $target '.codex/config.toml';Put $config "[features]`nmulti_agent = false`n"
$market=Join-Path $target '.agents/plugins/marketplace.json';$entry=@{name='pi-dispatch';source=@{source='local';path='./plugins/pi-dispatch'};policy=@{installation='AVAILABLE';authentication='ON_INSTALL'};category='Productivity'};@{plugins=@($entry)}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $market -Encoding utf8NoBOM
$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Install-PiKether.ps1'),[ref]$null,[ref]$errors)
if($errors){throw 'Installer did not parse.'}
foreach($fn in $ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){if($fn.Name -in @('Assert-Under','Assert-NoReparse')){. ([scriptblock]::Create($fn.Extent.Text))}}
. (Join-Path $PSScriptRoot 'HostPolicyPreservation.ps1')
$checks=0
function Check([bool]$ok,[string]$label){if(-not $ok){throw "FAIL: $label"};$script:checks++;Write-Output "PASS: $label"}
function Reject([string]$label,[string]$reason){$rejected=$false;try{Assert-HostPolicyPreserved $target $package|Out-Null}catch{$rejected=$_.Exception.Message.Contains($reason);if(-not $rejected){throw}};Check $rejected $label}
try{
 $result=Assert-HostPolicyPreserved $target $package
 Check ($result.reuseAgents -and $result.reuseSkill -and $result.reuseConfig -and $result.reuseMarketplace) 'matching existing policies are reused'
 Check ((Get-Content -LiteralPath $agents -Raw) -ceq $agentText) 'preflight leaves user instructions untouched'
 Put $agents $agentText.Replace('fixture managed policy','custom policy');Reject 'changed managed instructions are preserved and rejected' 'managed agent instructions differ';Put $agents $agentText
 $skill=Join-Path $target '.agents/skills/kether-governance/SKILL.md';Put $skill 'custom skill';Reject 'changed governance skill is preserved and rejected' 'governance skill differs';Put $skill 'fixture skill'
 $ref=Join-Path $target '.codex/agent-references/example.md';Put $ref 'custom reference';Reject 'changed governance reference is preserved and rejected' 'agent reference differs';Put $ref 'fixture reference'
 Put $config "[features]`nmulti_agent = true`n";Reject 'existing Codex feature settings are preserved and rejected' 'Codex feature settings would change';Put $config "[features]`nmulti_agent = false`n"
 $entry.source.path='./plugins/custom';@{plugins=@($entry)}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $market -Encoding utf8NoBOM;Reject 'custom plugin registration is preserved and rejected' 'plugin registration differs'
 $entry.source.path='./plugins/pi-dispatch';@{plugins=@($entry)}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $market -Encoding utf8NoBOM
 New-Item -ItemType Directory -Path (Join-Path $target '.agents/skills/retired-role')|Out-Null;Reject 'existing retired-role skill is not moved' 'governance-related skill would be retired'
 $installer=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Install-PiKether.ps1') -Raw
 Check ($installer.IndexOf('Assert-HostPolicyPreserved $TargetHome $packageRoot') -lt $installer.IndexOf('New-Item -ItemType Directory -Force -Path $TargetHome')) 'policy preflight runs before host mutation'
 Write-Output "PASS: $checks host policy preservation checks; synthetic files only."
}finally{
 if(Test-Path -LiteralPath $fixture){$resolved=(Resolve-Path -LiteralPath $fixture).Path;if(-not $resolved.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe cleanup path.'};Remove-Item -LiteralPath $resolved -Recurse -Force}
}
