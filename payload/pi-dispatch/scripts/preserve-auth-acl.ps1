param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference = 'Stop'
try {
    $acl = Get-Acl -LiteralPath $Source
    Set-Acl -LiteralPath $Destination -AclObject $acl
} catch { exit 1 }
