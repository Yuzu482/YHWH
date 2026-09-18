param([Parameter(Mandatory)][string]$ConfigFile)
$ErrorActionPreference='Stop'
$config=Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json -AsHashtable
if($config -isnot [Collections.IDictionary]){throw 'Workflow configuration must be a JSON object.'}
$defaults=@{schemaVersion=1;wslDistro='Ubuntu-24.04';installWsl=$true;allowDistroHardening=$false;installTunnel=$false;tunnelId='';tunnelRuntimeKeyFile='';tunnelClientPath=''}
$allowed=@('workspaceRoots')+@($defaults.Keys)
foreach($key in $config.Keys){if($key -notin $allowed){throw "Unknown configuration field: $key"}}
foreach($key in $defaults.Keys){if(-not $config.Contains($key)){$config[$key]=$defaults[$key]}}
if($config.schemaVersion -ne 1){throw 'Unsupported workflow schemaVersion.'}
if($config.workspaceRoots -isnot [array] -or $config.workspaceRoots.Count -eq 0){throw 'workspaceRoots must be a non-empty array.'}
foreach($root in $config.workspaceRoots){if($root -isnot [string] -or [string]::IsNullOrWhiteSpace($root)){throw 'Each workspace root must be a non-empty string.'}}
foreach($key in @('installWsl','allowDistroHardening','installTunnel')){if($config[$key] -isnot [bool]){throw "$key must be a JSON boolean."}}
foreach($key in @('wslDistro','tunnelId','tunnelRuntimeKeyFile','tunnelClientPath')){if($config[$key] -isnot [string]){throw "$key must be a string."}}
if([string]::IsNullOrWhiteSpace($config.wslDistro)){throw 'wslDistro cannot be empty.'}
return [pscustomobject]$config
