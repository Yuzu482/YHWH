# Third-party components and licensing

[简体中文](THIRD_PARTY.md)

Original YHWH code, documentation and configuration use [Apache-2.0](LICENSE). Third-party code, excerpts, dependencies and original license texts retain their own licenses and are not relicensed by this declaration. See [NOTICE](NOTICE).

| Component | Pinned version | License and evidence |
| --- | --- | --- |
| Pi Coding Agent / Pi components from the same repository | 0.84.4 | MIT; [full upstream text](licenses/pi-0.84.4-MIT.txt), Copyright 2025 Mario Zechner |
| pi-claude-code-provider (historical, removed in 0.6) | 0.1.4 | MIT; [full upstream text](licenses/pi-claude-code-provider-0.1.4-MIT.txt), Copyright 2026 chem |
| pi-lsp-extension | 1.3.0 | Package declares MIT; [original metadata](licenses/pi-lsp-extension-1.3.0.package.json); [missing full text record](licenses/pi-lsp-extension-NOTICE.txt) |
| Claude Code (historical, no longer downloaded in 0.6) | 2.1.250 | [Original notice](licenses/claude-code-2.1.250-NOTICE.txt); governed by Anthropic agreements, not MIT/Apache-2.0 |

Pi's MIT license can coexist with Apache-2.0 for YHWH's original work; retain third-party copyright and license notices. The bridge's MIT license does not grant rights to use Claude services or subscription credentials.

## Distribution scope

Source and installation archives contain YHWH scripts, documentation, configuration, lockfiles and licensing materials. They do not bundle npm dependency directories or dependency binaries such as Node.js, Java, .NET, JDT LS, clangd or Claude Code. The installer downloads dependencies upstream. Each downloaded component remains governed by its own terms; downloading during installation does not waive those obligations.

The [dependency declaration inventory](licenses/dependency-inventory.json) is generated from the Windows gateway and WSL npm lockfiles, including transitive and optional dependencies, versions, declared licenses, distribution URLs and integrity values. It is a metadata inventory, not a full license-text audit. It excludes system/separately downloaded components such as Ubuntu, PowerShell, Node, Java, .NET, JDT LS, csharp-ls, clangd and Bubblewrap. Their versions and sources remain recorded in installation scripts and bootstrap dependency metadata. Bundling them in future requires the corresponding redistribution materials.

`install/patch-pi-lsp.mjs` contains upstream source matching excerpts and modifies the installed LSP extension. Those excerpts and the dependency retain upstream licensing. This work did not complete a file-by-file provenance audit. The missing complete LSP upstream notice remains outstanding; this inventory does not certify compliance of the entire product.

## Maintenance and checks

Run `node install/license-inventory.mjs` to refresh lockfile declarations and standalone plugin notices. Run `node install/license-inventory.mjs --check` to check drift, original-material hashes and Apache metadata. The build enforces this check; one-click package tests check that licensing materials are present and match the sources. Dependency updates also require reassessing original licenses, provenance and service terms.

See the [Claude Code feasibility report](docs/claude-code-feasibility.en.md). Version 0.6 removes the subscription credential bridge and uses native Pi Anthropic API authentication with user-owned keys. Historical upstream notices remain for provenance.

## LSP notice and publication status

The [verified package evidence](licenses/pi-lsp-extension-evidence.json) pins the original npm integrity and source commit. [Standard MIT text](licenses/MIT-standard-reference.txt) is supplied as a reference, with no invented upstream copyright holder. The upstream attribution gap remains pending. `Build-Release.ps1 -PublicRelease` enforces this hold; the default builds local previews. An [upstream request draft](docs/upstream-lsp-license-request.md) is available; its recorded status distinguishes drafting from sending.
