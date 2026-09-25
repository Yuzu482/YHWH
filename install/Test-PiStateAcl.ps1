# Synthetic Windows fixture only; never targets the real user profile.
$ErrorActionPreference='Stop'
$root=Join-Path ([IO.Path]::GetTempPath()) ('pi-state-acl-'+[guid]::NewGuid().ToString('N'))
$helper=Join-Path $PSScriptRoot 'Protect-PiState.ps1'
$access=[Security.AccessControl.AccessControlSections]::Access
function Get-FixtureAcl([string]$Path,[bool]$Directory) {
    if($PSVersionTable.PSVersion.Major -le 5){
        if($Directory){return [System.IO.Directory]::GetAccessControl($Path,$script:access)}
        return [System.IO.File]::GetAccessControl($Path,$script:access)
    }
    if($Directory){return [System.IO.FileSystemAclExtensions]::GetAccessControl([System.IO.DirectoryInfo]::new($Path),$script:access)}
    return [System.IO.FileSystemAclExtensions]::GetAccessControl([System.IO.FileInfo]::new($Path),$script:access)
}
function Set-FixtureAcl([string]$Path,[bool]$Directory,[Security.AccessControl.FileSystemSecurity]$Acl) {
    if($PSVersionTable.PSVersion.Major -le 5){
        if($Directory){[System.IO.Directory]::SetAccessControl($Path,[Security.AccessControl.DirectorySecurity]$Acl)}else{[System.IO.File]::SetAccessControl($Path,[Security.AccessControl.FileSecurity]$Acl)}
        return
    }
    if($Directory){[System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.DirectoryInfo]::new($Path),[Security.AccessControl.DirectorySecurity]$Acl)}else{[System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.FileInfo]::new($Path),[Security.AccessControl.FileSecurity]$Acl)}
}
try {
    $agent=Join-Path $root '.pi\agent'
    $state=Join-Path $root '.local\state\pi-kether'
    New-Item -ItemType Directory -Force -Path $agent,$state | Out-Null
    $auth=Join-Path $agent 'auth.json'
    $authBytes=[Text.Encoding]::UTF8.GetBytes('{"fixture":"unchanged"}' + "`n")
    [IO.File]::WriteAllBytes($auth,$authBytes)

    # Simulate a fresh install beneath a broadly inheritable parent DACL.
    $rootAcl=Get-FixtureAcl $root $true
    $everyone=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    $broad=[Security.AccessControl.FileSystemAccessRule]::new($everyone,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
    $rootAcl.AddAccessRule($broad)
    Set-FixtureAcl $root $true $rootAcl
    $authAcl=Get-FixtureAcl $auth $false
    $authAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
    Set-FixtureAcl $auth $false $authAcl

    & $helper -TargetHome $root
    $targets=@($agent,$auth,$state)
    $allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')
    foreach($target in $targets){
        $isDirectory=Test-Path -LiteralPath $target -PathType Container
        $acl=Get-FixtureAcl $target $isDirectory
        if(-not $acl.AreAccessRulesProtected){throw "ACL remains inheritable: $target"}
        $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
        if($rules.Count -ne 3){throw "Unexpected ACL rule count on $target"}
        $inherit=if($isDirectory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
        foreach($rule in $rules){
            if($rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or [int]$rule.FileSystemRights -ne [int][Security.AccessControl.FileSystemRights]::FullControl -or $rule.InheritanceFlags -ne $inherit -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or $rule.IsInherited){throw "Unexpected access rule on $target"}
        }
    }
    $first=foreach($target in $targets){
        $isDirectory=Test-Path -LiteralPath $target -PathType Container
        (Get-FixtureAcl $target $isDirectory).GetSecurityDescriptorSddlForm($access)
    }
    & $helper -TargetHome $root
    $second=foreach($target in $targets){
        $isDirectory=Test-Path -LiteralPath $target -PathType Container
        (Get-FixtureAcl $target $isDirectory).GetSecurityDescriptorSddlForm($access)
    }
    if((Compare-Object @($first) @($second))){throw 'Repeat hardening mutated a compliant DACL.'}
    if([Convert]::ToBase64String($authBytes) -ne [Convert]::ToBase64String([IO.File]::ReadAllBytes($auth))){throw 'Hardening changed fixture file contents.'}
    Write-Host '[PASS] Broad inherited ACL hardened; repeat is idempotent; file contents unchanged.'
} finally {
    if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force}
}
