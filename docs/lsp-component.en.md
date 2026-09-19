# YHWH LSP component notes

[简体中文](lsp-component.md)

## Development status

The 0.9.0 development source integrates Microsoft `multilspy@0.0.15`; it has not been released; its probe layer has been deployed to the maintainer's running service and checked through the live gateway. Published v0.8.1 assets remain unchanged. In addition to the primary agent's deterministic `lsp_request` semantic queries, a first-party Pi adapter now exposes probes to governed workers, retaining model routes, permissions and the single-file probe scope.

## Operations and actual backends

| Methods | Backend | Behavior |
| --- | --- | --- |
| diagnostics, hover, definition, references, symbols, completions, code_actions | multilspy 0.0.15 official language adapters or controlled protocol profiles + provisioned servers | Model-free, read-only queries; code actions return suggestions only and server-initiated writes are refused |
| overview, search | pi-lsp-extension 1.3.0 / Tree-sitter | Preserves structural analysis; this is neither multilspy nor a fallback for failed semantic requests |
| `yhwh_lsp_*` inside Pi model tasks | First-party YHWH Pi adapter + multilspy | Seven read-only semantic tools using isolated snapshots of current task files; [integration notes](pi-lsp-adapter.en.md) |
| Legacy tool names inside Pi model tasks | Existing pi-lsp-extension | Retained for compatibility; this does not remove the old dependency or resolve its license gap |

`list_capabilities.lsp` exposes semantic and structural engines. Results include `engine`, version, `adapter`, `adapterVersion`, `backend` and `modelCalls:0`. Missing dependencies, unsupported methods or initialization failures return unavailable/failed without reverting to the legacy semantic backend.

## Language services and installation

- Python symbol queries use the official JediServer with locked jedi-language-server 0.41.3; Python diagnostics/code_actions use the controlled Pyright profile. JavaScript/TypeScript (including JSX/TSX) uses the official TypeScriptLanguageServer; Java, C/C++ and C# retain controlled JDT LS, clangd and csharp-ls profiles.
- The TypeScript 7.0.2 compiler is retained. The new probe pins TypeScript 6.0.3 under a separate `typescript-lsp` alias and explicitly selects its tsserver, with automatic type acquisition and configured plugins disabled. The TypeScript 7 package lacks the tsserver.js required by the older server. This configuration does not claim support for new TypeScript 7 semantics.
- WSL provisioning creates `/opt/pi-kether/multilspy-venv`, using fixed wheel versions and SHA-256 for Ubuntu 24.04 x86_64 / Python 3.12. The 18 Python dependencies are recorded in the [lockfile](../payload/multilspy-requirements.txt) and [provenance inventory](../licenses/multilspy-dependencies.json).
- Python uses the official factory to create JediServer; TypeScript subclasses the official adapter, overriding dependency setup to use fixed, preinstalled commands. Neither downloads servers at runtime. Installation still needs PyPI/npm and other distribution sources; deterministic execution retains network and credential isolation.
- `-SkipWsl` does not install this Python runtime and is not a complete LSP exclusion switch. Upgrades require matching gateway files, WSL scripts and dependencies; copying the gateway alone is insufficient.

## Input, results and cleanup

Input positions use **1-based UTF-16** lines/columns; raw LSP results retain **0-based UTF-16**, explicitly labeled in the result. An exact query resolves only when it occurs once in the file. Ambiguous matches require an explicit position rather than guessing a declaration or reference. The symbols query matches symbol names exactly.

The primary agent still supplies a single-file snapshot, so cross-file references and full project dependencies may be unavailable. Files are limited to 4 MiB, with bounded protocol input/output. Missing diagnostics, stale versions, timeouts and unsupported features cannot masquerade as passing checks. Receiving error diagnostics means the tool obtained evidence, not that the code is correct; empty diagnostics describe the observed notification and do not establish a defect-free project.

JavaScript/TypeScript diagnostics and code actions cannot use the first notification as an analysis-completion signal: the server may publish empty syntax results before type errors. Through the upstream-supported `typescript.tsserverRequest`, the adapter awaits three fixed read-only responses: `syntacticDiagnosticsSync`, `semanticDiagnosticsSync`, and `suggestionDiagnosticsSync`. It validates responses and normalizes LSP positions. Only after all three finish and a valid diagnostic notification for the current file arrives does it report `diagnosticCompletion.complete:true`, together with `method:tsserver-sync`, the three commands, and the document version. `diagnosticsPublished` still only records an observed notification. Missing capabilities, partial failures, malformed responses and timeouts cannot report a complete check. This adds no new completeness guarantees for other languages.

The adapter refuses `workspace/applyEdit`. It uses `workspace/executeCommand` only for these fixed TypeScript read-only diagnostics, never arbitrary commands from users or returned code actions; suggested actions are never executed. Servers run in separate process groups, allowing cleanup with an empty `/proc`; outer cgroup and sandbox cleanup checks remain. The existing `.pi-lsp.json` and Lombok-discovery patches still apply to the retained legacy extension.

The gateway pins WSL task, cleanup and health-check launches to `--cd /`; explicit scope arguments still select the workspace. This prevents automatic translation of the host working directory into another job's temporary Windows-drive mount, which can block concurrent unmounts. Cleanup failures remain failures; lazy unmount is not used to claim successful cleanup.

## Licensing boundaries

YHWH-owned adapters use Apache-2.0. The [Microsoft MIT text](../licenses/multilspy-0.0.15-MIT.txt) and the protocol client's embedded [OLSP MIT notice](../licenses/multilspy-OLSP-MIT.txt) are preserved. [Python dependency notices](../licenses/multilspy-dependency-notices.txt) come from hash-verified official wheels.

The pi-lsp-extension structural backend and model tools remain, so its missing complete upstream notice is still outstanding. [Upstream issue #14](https://github.com/samfoy/pi-lsp-extension/issues/14) and the [remediation record](lsp-license-remediation.en.md) remain applicable; `Build-Release.ps1 -PublicRelease` continues to block. Language servers and dependencies retain their own licenses. This inventory does not certify product-wide compliance.

## Reproducing verification

Run `python install/Test-Multilspy.py --wheel-dir <locked-wheel-directory> --typescript-archive <typescript-6.0.3.tgz>` on Windows with the existing Ubuntu-24.04 Pi sandbox and language servers. Use `--distro` for another matching distribution. Download the exact files recorded in the Python inventory and npm lock beforehand; the runner checks their hashes and does not download or update the service. `--skip-live` runs only the protocol fixture tests and does not require the TypeScript archive.

The runner uses temporary WSL files, runs 26 protocol/lifecycle tests (including early-empty notifications followed by errors, three-phase completion, and failure/timeout rejection), then real Python and TypeScript queries, three rounds of small/1,000-function/clean TypeScript checks, and six Bubblewrap checks (four semantic and two structural). It exercises a read-only workspace, no network and empty `/proc`, and checks that source fixtures are unchanged. This verifies the adapter/bootstrap chain, not a clean-machine install, deployed gateway request, or cgroup exhaustion. Java, C/C++ and C# profiles are configured but have not been exercised by these checks. See [verification history](../VERIFICATION.md).

## Official adapter integration boundary

This stage uses official classes from the pinned 0.0.15 release. Official JediServer handles Python hover, definition, references, symbols and completions; official TypeScriptLanguageServer handles all seven JS/TS semantic operations. Their startup, handshake and normal shutdown actually execute upstream code. YHWH retains request orchestration, UTF-16 validation, diagnostic evidence checks, read-only capability declarations, process-group cleanup and timeout recovery. This is a governed wrapper, not the unmodified upstream defaults or a Microsoft-provided/endorsed YHWH plugin.

The result's `adapter` is `official-jedi`, `official-typescript` or `controlled-protocol`. Official startup failure never switches engines automatically. Python type diagnostics explicitly select Pyright in advance rather than treating Jedi analysis as equivalent to type checking. The upstream default editor identity is replaced with YHWH and unsupported write capabilities are not advertised.

The 0.0.15 wheel does not contain the clangd adapter found on the newer main branch. Java/C#/C/C++ retain existing controlled profiles in this change. No Serena or third-party MCP adapter was installed; the running service subsequently received a probe-only upgrade. Queries still have the single-file snapshot scope.

## Current Go / Rust routes

Adapter 1.6.0 adds completed Go/gopls pull diagnostics and Rust/rust-analyzer + rustc single-file metadata diagnostics, both on the `controlled-protocol` route. See the [adapter guide](pi-lsp-adapter.en.md) for language settings, isolation exceptions, completion requirements and Cargo/module scope limits. The 26-test count above describes the earlier stage; the current full runner is `install/Test-PiLspAdapter.py`, including 42 protocol tests and real SDK checks across languages. See the [verification record](../VERIFICATION.md) for current local deployment evidence; this is not a clean-machine install or complete project build.
