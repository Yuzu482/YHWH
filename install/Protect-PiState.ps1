param([string]$TargetHome=$HOME)
$ErrorActionPreference='Stop'
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administrators=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$allowed=@($user,$system,$administrators)
$fullControl=[int][Security.AccessControl.FileSystemRights]::FullControl
$accessSections=[Security.AccessControl.AccessControlSections]::Access

function Get-PiStateAcl([string]$Path,[bool]$Directory) {
    if($PSVersionTable.PSVersion.Major -le 5){
        if($Directory){return [System.IO.Directory]::GetAccessControl($Path,$script:accessSections)}
        return [System.IO.File]::GetAccessControl($Path,$script:accessSections)
    }
    if($Directory){return [System.IO.FileSystemAclExtensions]::GetAccessControl([System.IO.DirectoryInfo]::new($Path),$script:accessSections)}
    return [System.IO.FileSystemAclExtensions]::GetAccessControl([System.IO.FileInfo]::new($Path),$script:accessSections)
}
function Set-PiStateAcl([string]$Path,[bool]$Directory,[Security.AccessControl.FileSystemSecurity]$Acl) {
    if($PSVersionTable.PSVersion.Major -le 5){
        if($Directory){[System.IO.Directory]::SetAccessControl($Path,[Security.AccessControl.DirectorySecurity]$Acl)}else{[System.IO.File]::SetAccessControl($Path,[Security.AccessControl.FileSecurity]$Acl)}
        return
    }
    if($Directory){[System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.DirectoryInfo]::new($Path),[Security.AccessControl.DirectorySecurity]$Acl)}else{[System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.FileInfo]::new($Path),[Security.AccessControl.FileSecurity]$Acl)}
}
function Test-PiStateAcl([Security.AccessControl.FileSystemSecurity]$Acl,[bool]$Directory) {
    if(-not $Acl.AreAccessRulesProtected){return $false}
    $rules=@($Acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
    if($rules.Count -ne $script:allowed.Count){return $false}
    $expectedInheritance=if($Directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
    foreach($rule in $rules){
        $matches=@($script:allowed | Where-Object { $_.Value -eq $rule.IdentityReference.Value })
        if($matches.Count -ne 1 -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or [int]$rule.FileSystemRights -ne $script:fullControl -or $rule.InheritanceFlags -ne $expectedInheritance -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or $rule.IsInherited){return $false}
    }
    return $true
}

foreach($relative in @('.pi\agent','.pi\agent\auth.json','.local\state\pi-kether')) {
    $path=Join-Path $TargetHome $relative
    if(-not (Test-Path -LiteralPath $path)){continue}
    $directory=Test-Path -LiteralPath $path -PathType Container
    $acl=Get-PiStateAcl $path $directory
    if(Test-PiStateAcl $acl $directory){continue}

    # Fetch only the DACL. This leaves owner, group, and SACL/audit data untouched.
    $acl.SetAccessRuleProtection($true,$false)
    foreach($rule in @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))){
        [void]$acl.RemoveAccessRuleSpecific($rule)
    }
    $inherit=if($directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
    foreach($identity in $allowed){
        $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
    }
    Set-PiStateAcl $path $directory $acl
    $verified=Get-PiStateAcl $path $directory
    if(-not (Test-PiStateAcl $verified $directory)){throw "ACL hardening verification failed: $path"}
}
