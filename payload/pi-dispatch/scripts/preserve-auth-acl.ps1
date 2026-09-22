param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference = 'Stop'
try {
    $sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group
    $sourceSecurity = [System.IO.File]::GetAccessControl($Source, $sections)
    $destinationSecurity = [System.Security.AccessControl.FileSecurity]::new()
    $destinationSecurity.SetSecurityDescriptorBinaryForm($sourceSecurity.GetSecurityDescriptorBinaryForm(), $sections)
    [System.IO.File]::SetAccessControl($Destination, $destinationSecurity)
} catch { exit 1 }
