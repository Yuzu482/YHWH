#Requires -Version 7.0
param([string]$Archive = $env:YHWH_LSP_ARCHIVE)
$ErrorActionPreference='Stop'
$tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
$fixture=Join-Path $tempRoot ('yhwh-lsp14-release-check-'+[guid]::NewGuid().ToString('N'))
if(-not [IO.Path]::GetFullPath($fixture).StartsWith($tempRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe LSP test directory.'}
New-Item -ItemType Directory -Path $fixture -ErrorAction Stop|Out-Null
$oldPristine=$env:YHWH_LSP_PRISTINE_ROOT
try {
  if(-not $Archive){
    Push-Location $fixture
    try {
      & npm.cmd pack 'pi-lsp-extension@1.4.0' --ignore-scripts --pack-destination $fixture --no-audit --no-fund
      if($LASTEXITCODE -ne 0){throw 'Could not retrieve the pinned LSP archive.'}
    } finally {Pop-Location}
    $Archive=Join-Path $fixture 'pi-lsp-extension-1.4.0.tgz'
  }
  if(-not (Test-Path -LiteralPath $Archive -PathType Leaf)){throw 'Pinned LSP archive is missing.'}
  $item=Get-Item -LiteralPath $Archive -Force
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Refusing linked LSP archive.'}
  $hash=(Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if($hash -cne '4f59ab58e8b508185be39916119887a9dbb83c295dff2790faa57ad44065ec74'){throw 'Pinned LSP archive digest mismatch.'}
  $extract=Join-Path $fixture 'extract';New-Item -ItemType Directory -Path $extract|Out-Null
  & tar.exe -xzf $item.FullName -C $extract -- 'package/package.json' 'package/LICENSE' 'package/dist/index.js' 'package/dist/lsp-daemon.js'
  if($LASTEXITCODE -ne 0){throw 'Could not extract the verified LSP test inputs.'}
  $env:YHWH_LSP_PRISTINE_ROOT=Join-Path $extract 'package'
  if((Get-FileHash -LiteralPath (Join-Path $env:YHWH_LSP_PRISTINE_ROOT 'LICENSE') -Algorithm SHA256).Hash.ToLowerInvariant() -cne '65966b294b74544c0fbd282e30d64a736956110370a20d3f86dc2b7358cda3ba'){throw 'LSP archive license digest mismatch.'}
  if((Get-FileHash -LiteralPath (Join-Path $env:YHWH_LSP_PRISTINE_ROOT 'package.json') -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'aa8397831f96fd352af2ccb7283756e467edaa0a55aa5c7ccf386c659832daee'){throw 'LSP archive metadata digest mismatch.'}
  & node.exe --test (Join-Path $PSScriptRoot 'Test-PiLspPatch.mjs')
  if($LASTEXITCODE -ne 0){throw 'LSP security patch verification failed.'}
} finally {
  $env:YHWH_LSP_PRISTINE_ROOT=$oldPristine
  if(Test-Path -LiteralPath $fixture){
    $resolved=(Resolve-Path -LiteralPath $fixture).Path
    if(-not $resolved.StartsWith($tempRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or ((Get-Item -LiteralPath $fixture -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe LSP test cleanup path.'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
