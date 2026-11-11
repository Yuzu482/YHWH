#Requires -Version 7.0
# Shared inventory for staging and for proving that a package matches a clean
# Git checkout. The caller loads DeploymentMainPolicy.ps1 first.
function Get-ReleaseSourceFiles {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$SourceRoot,[switch]$IsolatedGit)
  $root=[IO.Path]::GetFullPath($SourceRoot).TrimEnd('\','/')
  $prefix=$root+[IO.Path]::DirectorySeparatorChar
  if((Get-Item -LiteralPath $root -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Refusing linked source root.'}
  $allowed=@('install','payload','templates','docs','.readme-assets','.test','Workflow.ps1','Build-Release.ps1','Build-OneClick.ps1','Install-YHWH.ps1','Install.cmd','install.config.example.json','portable.manifest.json','README.md','README.en.md','VERIFICATION.md','SECURITY-HARDENING.md','THIRD_PARTY.md','THIRD_PARTY.en.md','LICENSE','NOTICE','licenses','.gitignore')
  # These are exact, original-host-only historical operators, not general
  # installers. Their source and history remain in the checkout unchanged.
  $localOnly=@(
    'install/Upgrade-CodexDirectHost.ps1','install/Test-CodexDirectHostUpgrade.ps1',
    # Preserve origin/main's repository-only synthetic fixture exclusions.
    'payload/pi-dispatch/tests/card-lab-interrupted-request-recovery.test.mjs',
    'payload/pi-dispatch/tests/review-quota-adjudication.test.mjs',
    'payload/pi-dispatch/tests/review-quota-material-reconsideration.test.mjs',
    # These tests and their pinned ledger refer to original-host history. They
    # remain in the source checkout but are not portable release material.
    'payload/pi-dispatch/tests/review-quota-exception.test.mjs',
    'payload/pi-dispatch/tests/review-quota-recovery.test.mjs',
    'payload/pi-dispatch/tests/fixtures/card-lab-review-ledger-five.json',
    'payload/pi-dispatch/tests/helpers/legacy-state-fixtures.mjs',
    'payload/pi-dispatch/tests/fixtures/legacy-state-pins.json'
  )
  $git=Invoke-DeploymentGit -Repository $root -GitArguments @('ls-files','--stage','-z') -IsolatedGit:$IsolatedGit
  if(-not (Test-DeploymentProcessSuccess $git)){throw 'Cannot enumerate the Git index for release.'}
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($record in ($git.stdout -split "`0")) {
    if(-not $record){continue}
    if($record -cnotmatch '^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$'){throw 'Invalid Git release index entry.'}
    $mode=$Matches[1];$objectHash=$Matches[2];$stage=$Matches[3];$relative=$Matches[4]
    $relative=$relative.Replace('\','/')
    if($relative.StartsWith('/') -or $relative -match '(^|/)\.\.?(/|$)|[:\x00-\x1f]'){throw 'Unsafe tracked release path.'}
    $parts=$relative.Split('/')
    if($parts[0] -cnotin $allowed -or $relative -cin $localOnly -or $relative.StartsWith('payload/pi-dispatch/tests/historical-local-evidence/',[StringComparison]::Ordinal) -or $relative.StartsWith('payload/pi-dispatch/tests/historical-synthetic-source/',[StringComparison]::Ordinal)){continue}
    $isBaseline=$relative -ceq '.test/baseline-failures.json';$skip=$false
    foreach($part in $parts){
      if($part -match '(?i)^(node_modules|\.git|\.runtime|diagnostics|release)$|^\.env|^auth\.json$|^(anthropic-api-key|provider-config|provider-credentials)\.json$|\.local\.|\.(log|bak|backup|pyc)$|^(?:.*token|.*key).*\.txt$'){$skip=$true;break}
      if($part -ceq '.test' -and -not $isBaseline){$skip=$true;break}
    }
    if($skip){continue}
    if($stage -cne '0' -or $mode -cnotin @('100644','100755')){throw 'Release index contains an unresolved or non-file entry.'}
    if(-not $seen.Add($relative)){throw 'Case-colliding release paths.'}
    $file=[IO.Path]::GetFullPath((Join-Path $root ($relative.Replace('/',[IO.Path]::DirectorySeparatorChar))))
    if(-not $file.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Release path escapes source root.'}
    $cursor=$file
    while($cursor -and $cursor.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){
      $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
      if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Refusing release link.'}
      $cursor=Split-Path -Parent $cursor
    }
    if(-not (Test-Path -LiteralPath $file -PathType Leaf)){throw 'Tracked release file is missing.'}
    [pscustomobject]@{relative=$relative;fullPath=$file;objectHash=$objectHash}
  }
}

function Test-ReleaseSourceBytes {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$SourceRoot,[Parameter(Mandatory)][object[]]$Files,[Parameter(Mandatory)][string]$FilesRoot,[switch]$IsolatedGit)
  # Git status normalizes text. Compare raw bytes with the committed blobs too,
  # so a clean-looking CRLF checkout cannot produce a different package.
  for($offset=0;$offset -lt $Files.Count;$offset+=32){
    $batch=@($Files | Select-Object -Skip $offset -First 32)
    $paths=@($batch | ForEach-Object {Join-Path $FilesRoot ($_.relative.Replace('/',[IO.Path]::DirectorySeparatorChar))})
    $gitArgs=@('hash-object','--no-filters','--')+$paths
    $result=Invoke-DeploymentGit -Repository $SourceRoot -GitArguments $gitArgs -IsolatedGit:$IsolatedGit
    if(-not (Test-DeploymentProcessSuccess $result)){throw 'Could not compare release bytes with Git objects.'}
    $hashes=@($result.stdout -split '\r?\n' | Where-Object {$_})
    if($hashes.Count -ne $batch.Count){throw 'Git release byte comparison was incomplete.'}
    for($i=0;$i -lt $batch.Count;$i++){if($hashes[$i] -cne $batch[$i].objectHash){throw ('Release bytes differ from the committed Git blob; use a clean LF checkout: '+$batch[$i].relative)}}
  }
}
