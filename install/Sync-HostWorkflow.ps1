#requires -Version 7.0
param([switch]$Check)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
function Neutral([string]$Text) {
  return $Text.Replace('ChatGPT Work/Codex -> Pi -> openai-codex','primary host -> Pi -> approved role-bound providers').Replace('ChatGPT Work and Codex','the primary host').Replace('ChatGPT and Pi','the primary host and Pi').Replace('this Codex home','this host workflow').Replace('Codex and ChatGPT Work','the primary host').Replace('ChatGPT Work/Codex','the primary host')
}
$topics=[ordered]@{primary=(Get-Content -LiteralPath (Join-Path $root 'templates/host-primary.md') -Raw).Replace("`r`n","`n")}
foreach($file in Get-ChildItem -LiteralPath (Join-Path $root 'templates/agent-references') -Filter '*.md' | Sort-Object Name){$topics[$file.BaseName]=Neutral ((Get-Content -LiteralPath $file.FullName -Raw).Replace("`r`n","`n"))}
foreach($dir in Get-ChildItem -LiteralPath (Join-Path $root 'payload/workflow-skills') -Directory | Sort-Object Name){$topics['skill:'+$dir.Name]=Neutral ((Get-Content -LiteralPath (Join-Path $dir.FullName 'SKILL.md') -Raw).Replace("`r`n","`n"))}
$json=([ordered]@{version=1;topics=$topics}|ConvertTo-Json -Depth 8)-replace "`r`n","`n"
$path=Join-Path $root 'payload/pi-dispatch/workflow/catalog.json'
if($Check){if(-not(Test-Path -LiteralPath $path) -or ((Get-Content -LiteralPath $path -Raw)-replace "`r`n","`n").Trim() -cne $json.Trim()){throw 'Workflow catalog is stale. Run install/Sync-HostWorkflow.ps1.'}}
else{New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path)|Out-Null;[IO.File]::WriteAllText($path,$json+"`n",[Text.UTF8Encoding]::new($false))}
