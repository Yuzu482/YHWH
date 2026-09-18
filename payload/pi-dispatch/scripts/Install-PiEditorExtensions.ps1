param(
    [string]$TargetHome=$HOME,
    [string]$PluginRoot=(Join-Path $HOME 'plugins\pi-dispatch'),
    [Parameter(Mandatory)][string]$UnityProject,
    [Parameter(Mandatory)][string]$UnityRelay,
    [Parameter(Mandatory)][string]$BlenderScripts,
    [Parameter(Mandatory)][string]$BlenderAssetRoot,
    [ValidateRange(1024,65535)][int]$BlenderPort=17431,
    [switch]$EnableWrites
)
$ErrorActionPreference='Stop'
foreach($path in @($TargetHome,$PluginRoot,$UnityProject,$UnityRelay,$BlenderScripts,$BlenderAssetRoot)) {
    if(-not [IO.Path]::IsPathFullyQualified($path)){throw 'All paths must be absolute'}
}
if(-not (Test-Path (Join-Path $UnityProject 'ProjectSettings\ProjectVersion.txt'))){throw 'Unity project is invalid'}
if(-not (Test-Path -LiteralPath $UnityRelay -PathType Leaf)){throw 'Unity native relay is missing'}
if(-not (Test-Path (Join-Path $PluginRoot 'node_modules\@modelcontextprotocol\sdk'))){throw 'Install Pi gateway dependencies first'}
$source=Join-Path (Split-Path -Parent $PSScriptRoot) 'pi-extensions'
$configRoot=Join-Path $TargetHome '.pi\agent\editors'
$backup=Join-Path $TargetHome ('.pi\agent\backups\editor-extensions-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $configRoot,$backup,$BlenderAssetRoot | Out-Null
foreach($name in @('editor-common','unity','blender')) {
    $dest=Join-Path $PluginRoot ('pi-extensions\'+$name)
    if((Join-Path $source $name) -ne $dest){
        if(Test-Path -LiteralPath $dest){Copy-Item -LiteralPath $dest -Destination $backup -Recurse}
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        $sourcePart=Join-Path $source $name
        Get-ChildItem -LiteralPath $sourcePart -Recurse -File | Where-Object {$_.Extension -ne '.pyc' -and $_.FullName -notmatch '[\\/]__pycache__[\\/]'} | ForEach-Object {
            $relative=[IO.Path]::GetRelativePath($sourcePart,$_.FullName)
            $target=Join-Path $dest $relative
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
            Copy-Item -LiteralPath $_.FullName -Destination $target -Force
        }
    }
}
$unityPath=Join-Path $configRoot 'unity.json'
if(-not (Test-Path -LiteralPath $unityPath)) {
    @{version=1;enabled=$true;allowWrites=[bool]$EnableWrites;assetRoot='Assets/PiGenerated';timeoutMs=30000;
      transport=@{type='stdio';command=$UnityRelay;args=@('--mcp','--project-path',$UnityProject,'--name','Pi Unity Bridge');cwd=$UnityProject};
      tools=@{unity_scene_info='read';unity_get_logs='read';unity_create_object='write';unity_set_transform='write';unity_delete_object='write';unity_create_material='write';unity_save_prefab='write'}
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $unityPath -Encoding utf8NoBOM
}
$tokenFile=Join-Path $configRoot 'blender-token.txt'
if(-not (Test-Path -LiteralPath $tokenFile)) {
    [IO.File]::WriteAllText($tokenFile,[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)))
    & icacls.exe $tokenFile /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null
    if($LASTEXITCODE){throw 'Failed to protect Blender token'}
}
$blenderPath=Join-Path $configRoot 'blender.json'
if(-not (Test-Path -LiteralPath $blenderPath)) {
    @{version=1;enabled=$true;allowWrites=[bool]$EnableWrites;timeoutMs=30000;
      transport=@{type='http';url="http://127.0.0.1:$BlenderPort/mcp";tokenFile=$tokenFile};
      tools=@{blender_scene_info='read';blender_create_object='write';blender_set_transform='write';blender_delete_object='write';blender_set_material='write';blender_save_copy='write';blender_export_glb='write'}
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $blenderPath -Encoding utf8NoBOM
}
$serverPath=Join-Path $configRoot 'blender-server.json'
if(-not (Test-Path -LiteralPath $serverPath)) {
    @{version=1;port=$BlenderPort;tokenFile=$tokenFile;assetRoot=$BlenderAssetRoot;allowWrites=[bool]$EnableWrites} | ConvertTo-Json | Set-Content -LiteralPath $serverPath -Encoding utf8NoBOM
}
$addons=Join-Path $BlenderScripts 'addons'
New-Item -ItemType Directory -Force -Path $addons | Out-Null
$addonTarget=Join-Path $addons 'pi_blender_bridge.py'
if(Test-Path -LiteralPath $addonTarget){Copy-Item -LiteralPath $addonTarget -Destination $backup}
Copy-Item -LiteralPath (Join-Path $source 'blender\addon\pi_blender_bridge.py') -Destination $addonTarget -Force
$settingsPath=Join-Path $TargetHome '.pi\agent\settings.json'
$settings=if(Test-Path -LiteralPath $settingsPath){Copy-Item -LiteralPath $settingsPath -Destination $backup;Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json -AsHashtable}else{@{}}
foreach($name in @('unity','blender')) {
    $package=(Join-Path $PluginRoot ('pi-extensions\'+$name)).Replace('\','/')
    if(@($settings.packages) -notcontains $package){$settings.packages=@($settings.packages | Where-Object {$null -ne $_})+@($package)}
}
$settings | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $settingsPath -Encoding utf8NoBOM
[pscustomobject]@{unityConfig=$unityPath;blenderConfig=$blenderPath;blenderServerConfig=$serverPath;addon=$addonTarget;backup=$backup;note='Existing configs preserved. Reload Pi. Enable Pi Blender Bridge addon and use F3 > Start Pi Blender Bridge in Blender.'} | ConvertTo-Json
