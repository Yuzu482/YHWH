#Requires -Version 7.0
# Validate a newly prepared runtime against the old runtime before moving either.
# No access control lists or owners are changed by these functions.
function Get-HostRuntimeSecuritySignature($PathOrItem) {
  $item=if($PathOrItem -is [IO.FileSystemInfo]){$PathOrItem}else{Get-Item -LiteralPath $PathOrItem -Force -ErrorAction Stop}
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Refusing a linked Pi runtime entry.'}
  $parts=[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access
  $acl=if($item.PSIsContainer){[IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]$item,$parts)}else{[IO.FileSystemAclExtensions]::GetAccessControl([IO.FileInfo]$item,$parts)}
  return $acl.GetSecurityDescriptorSddlForm($parts)
}
function Assert-HostRuntimeSecurityPreserved([string]$OldRoot,[string]$StageRoot,[string]$TargetHome) {
  Assert-NoReparse $OldRoot $TargetHome
  Assert-NoReparse $StageRoot $TargetHome
  if((Get-HostRuntimeSecuritySignature $OldRoot) -cne (Get-HostRuntimeSecuritySignature $StageRoot)){throw 'Existing Pi root permissions or owner differ from the staged runtime; preserve both and reconcile before replacement.'}
  $oldModules=Join-Path $OldRoot 'node_modules';$newModules=Join-Path $StageRoot 'node_modules'
  if(-not (Test-Path -LiteralPath $oldModules -PathType Container)) {
    if(@(Get-ChildItem -LiteralPath $OldRoot -Force).Count -ne 0){throw 'Existing Pi runtime is incomplete; preserve it before replacement.'}
    return
  }
  foreach($name in @('package.json','package-lock.json','node_modules')){
    if((Get-HostRuntimeSecuritySignature (Join-Path $OldRoot $name)) -cne (Get-HostRuntimeSecuritySignature (Join-Path $StageRoot $name))){throw "Existing Pi $name permissions or owner differ from the staged runtime; preserve both and reconcile before replacement."}
  }
  $filePolicy=Get-HostRuntimeSecuritySignature (Join-Path $oldModules '.package-lock.json')
  $directoryPolicy=Get-HostRuntimeSecuritySignature (Join-Path $oldModules '.bin')
  $count=0
  foreach($root in @($oldModules,$newModules)){
    foreach($item in Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction Stop){
      $count++;if($count -gt 200000){throw 'Pi security inventory exceeds its bound.'}
      $expected=if($item.PSIsContainer){$directoryPolicy}else{$filePolicy}
      if((Get-HostRuntimeSecuritySignature $item) -cne $expected){throw 'Existing and staged Pi file permissions or owners differ; preserve both and reconcile before replacement.'}
    }
  }
}
function Publish-HostRuntime([string]$Root,[string]$Stage,[string]$Backup,[string]$TargetHome,[string]$BackupRoot) {
  Assert-NoReparse $Root $TargetHome
  Assert-NoReparse $Stage $TargetHome
  Assert-NoReparse $Backup $TargetHome
  if(Test-Path -LiteralPath $Backup){throw 'Pi runtime backup destination already exists.'}
  if(-not (Test-Path -LiteralPath $Stage -PathType Container)){throw 'Prepared Pi runtime is missing.'}
  $moved=$false
  if(Test-Path -LiteralPath $Root){
    Assert-HostRuntimeSecurityPreserved $Root $Stage $TargetHome
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Backup) | Out-Null
    $source=(Resolve-Path -LiteralPath $Root).Path;$backupParent=(Resolve-Path -LiteralPath (Split-Path -Parent $Backup)).Path
    Assert-Under $source $TargetHome;Assert-Under $backupParent $BackupRoot
    Move-Item -LiteralPath $source -Destination (Join-Path $backupParent (Split-Path -Leaf $Backup))
    $moved=$true
  }
  try {
    # A move to the backup parent can alter inherited Windows ACEs. Confirm the
    # backup still has the original security before activating the replacement.
    if($moved){Assert-HostRuntimeSecurityPreserved $Backup $Stage $TargetHome}
    Move-Item -LiteralPath $Stage -Destination $Root
  }
  catch {
    $failure=$_
    if($moved -and -not (Test-Path -LiteralPath $Root) -and (Test-Path -LiteralPath $Backup)){
      Move-Item -LiteralPath $Backup -Destination $Root
      Assert-HostRuntimeSecurityPreserved $Root $Stage $TargetHome
    }
    throw $failure
  }
}
