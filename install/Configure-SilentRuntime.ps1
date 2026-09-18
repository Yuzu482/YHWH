param([string]$TargetHome=$HOME,[Parameter(Mandatory)][string]$NodePath,[Parameter(Mandatory)][string]$PluginPath,[Parameter(Mandatory)][string[]]$Roots,[string]$WslDistro='Ubuntu-24.04',[Parameter(Mandatory)][string]$TunnelClient,[Parameter(Mandatory)][string]$TunnelId,[Parameter(Mandatory)][string]$RuntimeKeyFile,[ValidateRange(1024,65535)][int]$GatewayPort=17331)
$ErrorActionPreference='Stop'
$state=Join-Path $TargetHome '.local\state\pi-kether'
New-Item -ItemType Directory -Force $state | Out-Null
$tokenFile=Join-Path $state 'http-token.txt'
if (-not (Test-Path $tokenFile)) { [IO.File]::WriteAllText($tokenFile,[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))) }
$headerFile=Join-Path $state 'http-header.txt'
[IO.File]::WriteAllText($headerFile,'Bearer '+[IO.File]::ReadAllText($tokenFile).Trim())
foreach($file in @($tokenFile,$headerFile)) {
    & icacls.exe $file /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null
    if ($LASTEXITCODE) { throw 'Failed to protect gateway authentication files' }
}
$gc=Join-Path $state 'gateway-silent.json'
@{host='127.0.0.1';port=$GatewayPort;roots=@($Roots);tokenFile=$tokenFile;auditFile=(Join-Path $state 'audit.jsonl');providerCircuitFile=(Join-Path $state 'provider-circuit.jsonl');requestLedgerDir=(Join-Path $state 'request-ledger')} | ConvertTo-Json | Set-Content $gc -Encoding utf8NoBOM
$settings=Join-Path $state 'silent-runtime.json'
@{nodePath=$NodePath;gatewayScript=(Join-Path $PluginPath 'scripts\gateway.mjs');gatewayConfig=$gc;gatewayUrl=("http://127.0.0.1:"+$GatewayPort);wslDistro=$WslDistro;tokenFile=$tokenFile;headerFile=$headerFile;tunnelClient=$TunnelClient;profileDir=(Join-Path $TargetHome '.config\openai-tunnel-client\profiles');tunnelId=$TunnelId;runtimeKeyFile=$RuntimeKeyFile} | ConvertTo-Json | Set-Content $settings -Encoding utf8NoBOM
$runner=Join-Path $state 'Ensure-SilentRuntime.ps1'
Copy-Item (Join-Path $PSScriptRoot 'Launch-HiddenPowerShell.vbs') (Join-Path $state 'Launch-HiddenPowerShell.vbs') -Force
Copy-Item (Join-Path $PSScriptRoot 'Ensure-SilentRuntime.ps1') $runner -Force
$entry=Join-Path $state 'ensure-tunnel.ps1'
"& '$($runner.Replace("'","''"))' -SettingsFile '$($settings.Replace("'","''"))'" | Set-Content $entry -Encoding utf8NoBOM
return $entry
