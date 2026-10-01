$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'HostWorkflowDrift.ps1')

$baseline = 'a' * 64
$other = 'b' * 64
$third = 'c' * 64
$cases = @(
  @{ Name = 'in-sync'; Source = $baseline.ToUpperInvariant(); Installed = $baseline; Baseline = $null; Expected = 'in-sync' },
  @{ Name = 'source-changed'; Source = $other; Installed = $baseline; Baseline = $baseline; Expected = 'source-changed' },
  @{ Name = 'host-changed'; Source = $baseline; Installed = $other; Baseline = $baseline; Expected = 'host-changed' },
  @{ Name = 'both-changed'; Source = $other; Installed = $third; Baseline = $baseline; Expected = 'both-changed' },
  @{ Name = 'baseline-unknown'; Source = $baseline; Installed = $other; Baseline = ''; Expected = 'baseline-unknown' },
  @{ Name = 'source-missing'; Source = $null; Installed = $other; Baseline = $baseline; Expected = 'source-missing' },
  @{ Name = 'installed-missing'; Source = $baseline; Installed = ''; Baseline = $baseline; Expected = 'installed-missing' },
  @{ Name = 'missing takes precedence'; Source = $null; Installed = 'invalid'; Baseline = $baseline; Expected = 'source-missing' }
)
foreach ($case in $cases) {
  $actual = Get-HostWorkflowDriftKind -SourceHash $case.Source -InstalledHash $case.Installed -BaselineHash $case.Baseline
  if ($actual -cne $case.Expected) { throw "$($case.Name): expected '$($case.Expected)', got '$actual'." }
}

$threw = $false
try { Get-HostWorkflowDriftKind -SourceHash 'not-a-hash' -InstalledHash $baseline -BaselineHash $baseline | Out-Null }
catch { $threw = $true }
if (-not $threw) { throw 'Invalid hash input was not rejected.' }

# Exercise diagnostic formatting/classification with isolated representative artifact keys.
$diagnosticFixture = Join-Path ([IO.Path]::GetTempPath()) ('yhwh-drift-diagnostic-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $diagnosticFixture | Out-Null
try {
  $diagnosticCases = @(
    @{ Key = '.codex/agent-references/a.md'; Source = $other; Installed = $baseline; Baseline = $baseline; Expected = 'source-changed' },
    @{ Key = 'plugins/pi-dispatch/workflow/catalog.json'; Source = $baseline; Installed = $other; Baseline = $baseline; Expected = 'host-changed' },
    @{ Key = '.agents/skills/kether-governance/SKILL.md'; Source = $other; Installed = $third; Baseline = $baseline; Expected = 'both-changed' },
    @{ Key = 'plugins/pi-dispatch/skills/pi-dispatch/SKILL.md'; Source = $other; Installed = $third; Baseline = $null; Expected = 'baseline-unknown' }
  )
  foreach ($case in $diagnosticCases) {
    $line = "[DRIFT] $(Get-HostWorkflowDriftKind -SourceHash $case.Source -InstalledHash $case.Installed -BaselineHash $case.Baseline) $($case.Key)"
    if ($line -notmatch ('^\[DRIFT\] ' + [regex]::Escape($case.Expected) + ' ' + [regex]::Escape($case.Key) + '$')) { throw "Unexpected diagnostic for $($case.Key): $line" }
  }
} finally { Remove-Item -LiteralPath $diagnosticFixture -Recurse -Force }

Write-Host '[PASS] Host workflow drift classifications, diagnostics, and invalid input.'
