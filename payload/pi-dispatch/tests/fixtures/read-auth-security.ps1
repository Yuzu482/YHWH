param([Parameter(Mandatory)][string]$Path)
$ErrorActionPreference='Stop'
$sections=[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access
$security=[IO.File]::GetAccessControl($Path,$sections)
[Console]::Out.Write($security.GetSecurityDescriptorSddlForm($sections))
