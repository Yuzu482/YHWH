# Convert text only; callers perform backups and writes.
param([AllowEmptyString()][string]$Text='')
$ErrorActionPreference='Stop'
if ($Text -match '(?m)^\s*features\s*=') { throw 'Inline features configuration requires manual migration to a [features] table before installation.' }
$header = [regex]::Match($Text, '(?m)^\s*\[features\][ \t]*(?:#[^\r\n]*)?\r?$')
if ($header.Success) {
  $start = $header.Index + $header.Length
  $next = [regex]::Match($Text.Substring($start), '(?m)^[ \t]*\[')
  $end = if ($next.Success) { $start + $next.Index } else { $Text.Length }
  $section = $Text.Substring($start, $end - $start)
  if ($section -match '(?m)^[ \t]*multi_agent\s*=') { $section = [regex]::Replace($section, '(?m)^[ \t]*multi_agent\s*=[^\r\n]*', 'multi_agent = false') }
  else { $section = "`r`nmulti_agent = false" + $section }
  if (-not $section.EndsWith("`n")) { $section += "`r`n" }
  return $Text.Substring(0,$start) + $section + $Text.Substring($end)
}
# Remove the legacy root-level spelling without touching unrelated tables.
$firstTable = [regex]::Match($Text, '(?m)^[ \t]*\[')
$rootEnd = if ($firstTable.Success) { $firstTable.Index } else { $Text.Length }
$prefix = [regex]::Replace($Text.Substring(0,$rootEnd), '(?m)^[ \t]*multi_agent\s*=[^\r\n]*(?:\r?\n)?', '')
return ($prefix + $Text.Substring($rootEnd)).TrimEnd() + "`r`n`r`n[features]`r`nmulti_agent = false`r`n"
