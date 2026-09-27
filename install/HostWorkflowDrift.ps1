function Get-HostWorkflowDriftKind {
  [CmdletBinding()]
  param(
    [AllowNull()][string]$SourceHash,
    [AllowNull()][string]$InstalledHash,
    [AllowNull()][string]$BaselineHash
  )

  if ([string]::IsNullOrWhiteSpace($SourceHash)) { return 'source-missing' }
  if ([string]::IsNullOrWhiteSpace($InstalledHash)) { return 'installed-missing' }

  foreach ($entry in @(@{ Name = 'SourceHash'; Value = $SourceHash }, @{ Name = 'InstalledHash'; Value = $InstalledHash }, @{ Name = 'BaselineHash'; Value = $BaselineHash })) {
    if (-not [string]::IsNullOrWhiteSpace($entry.Value) -and $entry.Value -notmatch '\A[0-9a-fA-F]{64}\z') {
      throw "Invalid SHA-256 value for $($entry.Name)."
    }
  }

  if ($SourceHash.Equals($InstalledHash, [StringComparison]::OrdinalIgnoreCase)) { return 'in-sync' }
  if ([string]::IsNullOrWhiteSpace($BaselineHash)) { return 'baseline-unknown' }

  $sourceMatchesBaseline = $SourceHash.Equals($BaselineHash, [StringComparison]::OrdinalIgnoreCase)
  $installedMatchesBaseline = $InstalledHash.Equals($BaselineHash, [StringComparison]::OrdinalIgnoreCase)
  if ($sourceMatchesBaseline) { return 'host-changed' }
  if ($installedMatchesBaseline) { return 'source-changed' }
  return 'both-changed'
}
