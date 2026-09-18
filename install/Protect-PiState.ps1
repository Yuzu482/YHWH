param([string]$TargetHome=$HOME)
$ErrorActionPreference='Stop'
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($relative in @('.pi\agent','.pi\agent\auth.json','.local\state\pi-kether')) {
    $path=Join-Path $TargetHome $relative
    if(-not (Test-Path -LiteralPath $path)){continue}
    $directory=Test-Path -LiteralPath $path -PathType Container
    $acl=if($directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
    $acl.SetAccessRuleProtection($true,$false)
    foreach($identity in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $inherit=if($directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
        $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl',$inherit,'None','Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $path -AclObject $acl
}
