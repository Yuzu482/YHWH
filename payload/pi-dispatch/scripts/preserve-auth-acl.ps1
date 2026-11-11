param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference = 'Stop'
try {
    $sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group
    $sourceSecurity = [System.IO.File]::GetAccessControl($Source, $sections)
    $existingSecurity = [System.IO.File]::GetAccessControl($Destination, $sections)
    $sidType = [System.Security.Principal.SecurityIdentifier]
    if ($sourceSecurity.GetOwner($sidType).Value -cne $existingSecurity.GetOwner($sidType).Value -or
        $sourceSecurity.GetGroup($sidType).Value -cne $existingSecurity.GetGroup($sidType).Value) { throw 'owner or group mismatch' }
    $destinationSecurity = [System.Security.AccessControl.FileSecurity]::new()
    # Owner and group already match. Do not request WRITE_OWNER just to set them
    # to their existing values; copy only the DACL and fail closed on mismatch.
    $destinationSecurity.SetSecurityDescriptorBinaryForm($sourceSecurity.GetSecurityDescriptorBinaryForm(), [System.Security.AccessControl.AccessControlSections]::Access)
    [System.IO.File]::SetAccessControl($Destination, $destinationSecurity)
    $verified = [System.IO.File]::GetAccessControl($Destination, $sections)
    if ($sourceSecurity.GetOwner($sidType).Value -cne $verified.GetOwner($sidType).Value -or
        $sourceSecurity.GetGroup($sidType).Value -cne $verified.GetGroup($sidType).Value -or
        $sourceSecurity.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access) -cne $verified.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)) { throw 'security descriptor mismatch' }
} catch { exit 1 }
