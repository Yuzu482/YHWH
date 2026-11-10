param(
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$true)][string]$Candidate,
  [Parameter(Mandatory=$true)][string]$Backup,
  [Parameter(Mandatory=$true)][string]$BeforeSha256,
  [Parameter(Mandatory=$true)][string]$AfterSha256
)
$ErrorActionPreference='Stop'
foreach($file in @($Target,$Candidate)) {
  $item=Get-Item -LiteralPath $file -Force
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe model catalog file.'}
}
if([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Target)) -ne [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Candidate))){throw 'Candidate must share the target directory.'}
if(Test-Path -LiteralPath $Backup){throw 'Backup path already exists.'}
$before=(Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant()
$after=(Get-FileHash -LiteralPath $Candidate -Algorithm SHA256).Hash.ToLowerInvariant()
if($before -cne $BeforeSha256 -or $after -cne $AfterSha256){throw 'Catalog changed before replacement.'}
$originalAcl=Get-Acl -LiteralPath $Target
$acl=$originalAcl.Sddl
try { Set-Acl -LiteralPath $Candidate -AclObject $originalAcl }
catch { throw 'Cannot preserve catalog owner and ACL; replacement was not attempted.' }
if((Get-Acl -LiteralPath $Candidate).Sddl -cne $acl){throw 'Candidate owner or ACL differs; replacement was not attempted.'}
if((Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $BeforeSha256 -or
   (Get-FileHash -LiteralPath $Candidate -Algorithm SHA256).Hash.ToLowerInvariant() -cne $AfterSha256 -or
   (Get-Acl -LiteralPath $Target).Sddl -cne $acl){throw 'Catalog changed before replacement.'}
[IO.File]::Replace($Candidate,$Target,$Backup,$false)
if((Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $AfterSha256 -or
   (Get-FileHash -LiteralPath $Backup -Algorithm SHA256).Hash.ToLowerInvariant() -cne $BeforeSha256 -or
   (Get-Acl -LiteralPath $Target).Sddl -cne $acl){throw 'Catalog replacement postcheck failed; backup retained.'}
