param([string]$TargetHome=$HOME,[switch]$CheckOnly)
$ErrorActionPreference='Stop'
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administrators=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$seenIdentities=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$allowed=@(foreach($identity in @($user,$system,$administrators)){if($seenIdentities.Add($identity.Value)){$identity}})
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
function Test-PiStateAcl([Security.AccessControl.FileSystemSecurity]$Acl,[bool]$Directory,[bool]$AllowTraversalExtras=$false) {
    if(-not $Acl.AreAccessRulesProtected){return $false}
    $rules=@($Acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
    if($rules.Count -lt $script:allowed.Count -or $rules.Count -gt ($script:allowed.Count+16)){return $false}
    $expectedInheritance=if($Directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($rule in $rules){
        $matches=@($script:allowed | Where-Object { $_.Value -eq $rule.IdentityReference.Value })
        if($matches.Count -eq 1){
            if(-not $seen.Add($rule.IdentityReference.Value) -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or [int]$rule.FileSystemRights -ne $script:fullControl -or $rule.InheritanceFlags -ne $expectedInheritance -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or $rule.IsInherited){return $false}
        } else {
            # Existing sandbox traversal grants are retained only on the state
            # directory itself. They cannot write, list contents, or inherit;
            # SYNCHRONIZE may be added by Windows to an allow ACE.
            $rights=[int]$rule.FileSystemRights
            if(-not $AllowTraversalExtras -or -not $Directory -or $matches.Count -ne 0 -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rights -eq 0 -or ($rights -band (-bnot 1048736)) -ne 0 -or $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or $rule.IsInherited){return $false}
        }
    }
    return $seen.Count -eq $script:allowed.Count
}

foreach($relative in @('.pi\agent','.pi\agent\auth.json','.local\state\pi-kether')) {
    $path=Join-Path $TargetHome $relative
    if(-not (Test-Path -LiteralPath $path)){continue}
    $directory=Test-Path -LiteralPath $path -PathType Container
    $acl=Get-PiStateAcl $path $directory
    $allowTraversalExtras=$relative -eq '.local\state\pi-kether'
    if(Test-PiStateAcl $acl $directory $allowTraversalExtras){continue}
    if($CheckOnly){throw "Existing Pi state permissions would change; preserve them and reconcile before installation: $path"}

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
    if(-not (Test-PiStateAcl $verified $directory $allowTraversalExtras)){throw "ACL hardening verification failed: $path"}
}
