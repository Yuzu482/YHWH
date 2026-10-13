#Requires -Version 7.0
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$NodePath,
  [Parameter(Mandatory)][string]$PluginTarget,
  [Parameter(Mandatory)][string]$StateRoot,
  [Parameter(Mandatory)][string[]]$Roots,
  [Parameter(Mandatory)][string]$PiEntry,
  [string]$WslDistro='Ubuntu-24.04',
  [switch]$ConfigurationWillBeCreated
)
$ErrorActionPreference='Stop'
foreach($p in @($NodePath,$PluginTarget,$StateRoot,$PiEntry)) {
  if(-not [IO.Path]::IsPathFullyQualified($p)){throw 'Shared gateway connection requires absolute paths.'}
}
function Canonical-Directory([string]$Directory) {
  if(-not [IO.Path]::IsPathFullyQualified($Directory) -or -not (Test-Path -LiteralPath $Directory -PathType Container)){throw 'Shared gateway roots must be existing absolute directories.'}
  $value=(Resolve-Path -LiteralPath $Directory).ProviderPath.TrimEnd([IO.Path]::DirectorySeparatorChar)
  if($IsWindows){return $value.ToLowerInvariant()}
  return $value
}
$expectedRoots=@($Roots | ForEach-Object {Canonical-Directory $_} | Sort-Object -Unique)
if($expectedRoots.Count -eq 0){throw 'Shared gateway needs at least one root.'}
$gatewayConfig=Join-Path $StateRoot 'gateway-silent.json'
if(Test-Path -LiteralPath $gatewayConfig -PathType Leaf) {
  try {$shared=Get-Content -LiteralPath $gatewayConfig -Raw | ConvertFrom-Json -ErrorAction Stop} catch {throw 'Shared gateway configuration is malformed; no credentials were changed.'}
  $hostName=if($null -eq $shared.host){'127.0.0.1'}else{$shared.host}
  $port=if($null -eq $shared.port){7331}else{$shared.port}
  if(($hostName -notin @('127.0.0.1','localhost','::1')) -or (-not ($port -is [int] -or $port -is [long])) -or $port -lt 1 -or $port -gt 65535){throw 'Shared gateway must use a valid loopback address and port.'}
  if($shared.roots -isnot [Array]){throw 'Shared gateway roots must be an array.'}
  $actualRoots=@($shared.roots | ForEach-Object {Canonical-Directory $_} | Sort-Object -Unique)
  if(@(Compare-Object $expectedRoots $actualRoots -CaseSensitive).Count){throw 'Shared gateway roots differ from the approved installation roots; update the approved runtime configuration separately.'}
  if($shared.tokenFile -isnot [string] -or [string]::IsNullOrWhiteSpace($shared.tokenFile)){throw 'Shared gateway token reference is missing.'}
  $tokenPath=if([IO.Path]::IsPathFullyQualified($shared.tokenFile)){$shared.tokenFile}else{Join-Path $StateRoot $shared.tokenFile}
  if(-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)){throw 'Shared gateway referenced token file is missing; no credentials were created.'}
} elseif(-not $ConfigurationWillBeCreated) {
  throw 'Shared gateway configuration is required before a non-Tunnel installation. Configure the local shared runtime first; standalone fallback is disabled.'
}
# Only the existing Tunnel installer may create missing configuration later.
# This builder never reads token contents, creates files, starts a runtime or grants approval.
return [pscustomobject][ordered]@{
  command=$NodePath
  args=@((Join-Path $PluginTarget 'scripts/stdio-server.mjs'))
  env=[ordered]@{
    PATH=((Split-Path -Parent $NodePath)+';'+$env:PATH)
    PI_DISPATCH_PI_ENTRY=$PiEntry
    PI_GATEWAY_ROOTS=(ConvertTo-Json -InputObject @($Roots) -Compress)
    PI_GATEWAY_AUDIT_FILE=(Join-Path $StateRoot 'audit.jsonl')
    PI_GATEWAY_PROVIDER_CIRCUIT_FILE=(Join-Path $StateRoot 'provider-circuit.jsonl')
    PI_GATEWAY_REQUEST_LEDGER_DIR=(Join-Path $StateRoot 'request-ledger')
    PI_DISPATCH_SANDBOX='wsl2-bwrap'
    PI_SANDBOX_DISTRO=$WslDistro
    PI_GATEWAY_CONFIG=$gatewayConfig
  }
  enabled=$true
  enabled_tools=@('get_workflow','list_capabilities','dispatch_subagent','submit_subagent','get_subagent_status','wait_subagent','get_task_handoff','wait_task_handoff','get_subagent_result','list_subagents','cancel_subagent','render_subagent_monitor','probe_model','lsp_request','check_claude_auth','diagnose_milestone_failure','abandon_artifact','reconcile_milestone')
  startup_timeout_sec=30
}
