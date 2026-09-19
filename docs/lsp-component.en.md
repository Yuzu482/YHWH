# YHWH LSP component notes

[简体中文](lsp-component.md)

## Release status

YHWH v0.8.1 is a prerelease in a private repository. This update separately documents LSP functionality, provenance and the outstanding licensing question; it does not replace the LSP implementation or change runtime behavior. These notes do not replace an upstream license or establish clearance for public distribution.

## Functionality

YHWH exposes code queries through its governed interface. The deterministic `lsp_request` path invokes tools directly without model inference or API keys. Results distinguish a real language server from a Tree-sitter backend.

| Category | Current methods |
| --- | --- |
| Diagnostics and navigation | diagnostics, hover, definition, references, symbols |
| Coding assistance queries | completions, code_actions; query results only, without executing code actions |
| Structural information | overview, search; provided by the Tree-sitter-related implementation |

Installation configuration covers language services for Python, Java, JavaScript, TypeScript, C# and C/C++. A configured service does not establish validation in every project or on every target machine. Results depend on language-server installation, project dependencies, scope and initialization state.

## Provenance and installation

- YHWH-owned gateway, scope checks, sandbox invocation and result adapters use Apache-2.0. Third-party code and excerpts retain their own licenses.
- The underlying dependency is pinned to `pi-lsp-extension@1.3.0`, source commit `5edc932d325b630483f84f7d7f038e88ceba1eba`. Current adapters directly invoke its manager, tool factories and Tree-sitter modules; this is not an independently rewritten implementation.
- Release assets contain YHWH scripts, lockfiles and provenance materials, without bundling this dependency's complete npm directory or language-server binaries. Installation downloads dependencies upstream and applies patches.
- Existing installation paths still include LSP. Separate documentation does not make it a fully optional installation module. `-SkipWsl` skips WSL configuration; it is not a complete LSP exclusion switch.
- Language servers, parsers and transitive dependencies have their own licenses. The lockfile inventory is not a complete license-text audit of all system components.

## Modifications and execution boundaries

Installation patches disable executable configuration from project `.pi-lsp.json` files and automatic Lombok Java agent discovery. The full Windows patch also hides child-process windows and adds C/C++/C# server configuration. The installed dependency includes a `YHWH-PATCH-NOTICE.txt` modification notice.

The deterministic path uses a read-only sandbox with bounded file scope and checks task cleanup. Diagnostics require an actual language-server diagnostic notification; absence of a notification is not treated as an error-free result. Model-free execution does not remove trust in language servers or dependencies, or establish that every language feature has been validated.

## Outstanding license notice

Upstream package.json and README declare MIT. As of 2026-09-19, checks of the pinned npm package and repository did not locate the complete copyright and permission notice. YHWH does not guess holders or years, treat the standard MIT template as an upstream notice, or relabel upstream code as Apache-2.0.

[Upstream issue #14](https://github.com/samfoy/pi-lsp-extension/issues/14) requests the complete notice and confirmation of coverage for 1.3.0. See the [audit and remediation record](lsp-license-remediation.en.md), [original evidence](../licenses/pi-lsp-extension-evidence.json) and [third-party inventory](../THIRD_PARTY.en.md).

`Build-Release.ps1 -PublicRelease` continues to block. A private prerelease, installation-time downloads and these notes do not replace licensing obligations. Upstream confirmation or an independent replacement requires renewed review, verification and a new release.

## Verification scope

v0.8.1 updates documentation, license provenance records and version metadata only. Prepublication checks cover documentation links, licensing-material consistency, the public-release hold, installer generation and inclusion of these notes. The v0.8.0 result of 202/202 gateway tests is the earlier runtime baseline, not a suite rerun for this update.

This update does not rerun language-server feature tests, clean-machine installation, paid model heartbeats or live-service upgrades. Publication does not automatically update the local service or migrate keys.
