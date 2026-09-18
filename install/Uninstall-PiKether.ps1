[CmdletBinding(SupportsShouldProcess)]
param([string]$TargetHome = $HOME, [switch]$KeepWorkflowSkills)
$ErrorActionPreference = 'Stop'
$state = Join-Path $TargetHome '.local\state\pi-kether'
$hostState=Join-Path $state 'installation-hosts.json'
$removeCodex=if(Test-Path -LiteralPath $hostState){(Get-Content -LiteralPath $hostState -Raw|ConvertFrom-Json).hosts -contains 'codex'}else{$true}
$archive = Join-Path $state ('uninstalled-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $archive | Out-Null
if (Get-ScheduledTask -TaskName 'Pi Kether Secure MCP Tunnel' -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName 'Pi Kether Secure MCP Tunnel' -Confirm:$false }
if ($removeCodex -and [IO.Path]::GetFullPath($TargetHome) -eq [IO.Path]::GetFullPath($HOME) -and (Get-Command codex.exe -ErrorAction SilentlyContinue)) { & codex.exe plugin remove pi-dispatch@personal | Out-Host }
$plugin = Join-Path $TargetHome 'plugins\pi-dispatch'
if (Test-Path -LiteralPath $plugin) { Move-Item -LiteralPath $plugin -Destination (Join-Path $archive 'pi-dispatch') }
if ($removeCodex -and -not $KeepWorkflowSkills) {
  $names = Get-ChildItem -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'payload\workflow-skills') -Directory | Select-Object -ExpandProperty Name
  foreach ($name in $names) { $path = Join-Path $TargetHome ".agents\skills\$name"; if (Test-Path -LiteralPath $path) { Move-Item -LiteralPath $path -Destination (Join-Path $archive $name) } }
}
$agents = Join-Path $TargetHome '.codex\AGENTS.md'
if ($removeCodex -and (Test-Path -LiteralPath $agents)) {
  $text = Get-Content -LiteralPath $agents -Raw
  $text = [regex]::Replace($text, '(?s)\r?\n?<!-- PI-KETHER:BEGIN -->.*?<!-- PI-KETHER:END -->\r?\n?', "`r`n")
  [IO.File]::WriteAllText($agents, $text.Trim() + "`r`n", [Text.UTF8Encoding]::new($false))
}
Write-Host "Files archived at $archive"
Write-Host 'The WSL distro and /opt/pi-kether were retained because the distro may contain other data.'
