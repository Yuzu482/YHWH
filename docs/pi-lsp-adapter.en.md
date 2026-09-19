# YHWH first-party Pi LSP adapter

[简体中文](pi-lsp-adapter.md)

`yhwh-pi-lsp` 1.6.0 is a YHWH-owned Apache-2.0 adapter exposing the existing multilspy probes to governed Pi workers. It is not a Microsoft Pi plugin and does not remove all dependencies on the old extension.

## Scope and usage

The installer provisions the plugin and trusted channel in WSL. Governed tasks with `access:read` or `access:workspace-write` automatically load it; reviewers with `access:none` receive neither the extension nor its tools. The primary agent's existing `lsp_request` entry point is unchanged.

| Tool | Purpose |
| --- | --- |
| `yhwh_lsp_diagnostics` | Current-file diagnostics |
| `yhwh_lsp_hover` | Type information and documentation |
| `yhwh_lsp_definition` | Definition locations |
| `yhwh_lsp_references` | Reference locations |
| `yhwh_lsp_symbols` | File symbols, optionally filtered by exact name |
| `yhwh_lsp_completions` | Completion suggestions |
| `yhwh_lsp_code_actions` | Action suggestions; never applies edits or executes commands |

Inputs contain `path`; positioned queries additionally take paired `line` and `character`, or an exact unique-symbol `query`. Positions are 1-based UTF-16. User commands, endpoints, credentials, environment overrides and arbitrary workspace roots are rejected. Paths must belong to the task's admitted workspace snapshot.

Examples: `yhwh_lsp_diagnostics({"path":"src/main.ts"})`; `yhwh_lsp_hover({"path":"src/main.ts","line":3,"character":8})`.

This plugin requires a YHWH-managed WSL Pi task. Loading the package alone in an arbitrary host Pi session does not establish the trusted channel; a missing channel fails explicitly without an unsandboxed fallback. The plugin needs no API key configuration.

## Isolation and lifecycle

The Pi subprocess sends dedicated IPC messages to a trusted launcher-side broker. The broker must belong to the task cgroup with CPU, memory and process-count limits and reads files only from its fixed task directory. Descriptor-by-descriptor traversal with `O_NOFOLLOW` prevents symlinks and parent-directory substitution from redirecting privileged reads. Special files, files over 4 MiB and files changed during reading are rejected.

Each task retains servers for one unchanged file, keyed by file path and content SHA-256. Python keeps two backends on demand: Pyright for diagnostics and code-action suggestions, and Jedi for the remaining semantic queries. Alternating queries reuse each backend; other languages retain at most one server. Every call still sends a real LSP query; answers are not cached. A content or path change awaits termination of all old servers before creating new read-only single-file snapshots. Before returning, the broker rereads the current file and checks its hash; a change fails explicitly. Completed worker edits are visible without accepting diagnostics from an older version.

Language servers run in separate PID/network namespaces with a cleared environment and temporary storage; they never inherit credential FD3. Normally `/proc` is empty. C# (.NET) and Go (gopls executable discovery) receive a read-only `/proc` showing only its private probe PID namespace, with no host process visibility. The probe shares its parent model task's total resource budget and does not request another gateway task slot. Two Python backends increase memory use without raising task resource limits. Each backend independently closes after 15 idle seconds; query failure, cancellation or task completion closes and cleans all backends, with no cross-task sharing. Each query has a 60-second deadline and the plugin channel a 70-second wait limit; a shorter overall task deadline still takes precedence. The plugin admits at most four queued calls and executes them serially, with at most 64 probe requests per task.

Retained results include `serverSession` (content hash, session generation, reuse status, `poolSlot` and `poolCapacity`), and explicitly report `serverCleanup.ok:null` with `state:retained-until-session-close`. This means the server is still running, not that cleanup has completed. The launcher awaits final cleanup at task completion and fails the task if cleanup fails. Cancellation may terminate probe namespaces; pool cleanup reports `pool-terminated` and returns `ok:true` only when all cleanup succeeds. The primary agent's direct `lsp_request` retains its one-process-per-call and per-call cleanup semantics.

Cancellation stops the probe; channel closure cancels pending work. Invalid protocol, server failures and missing cleanup evidence cannot become a passing check. JS/TS diagnostics retain three-phase completion evidence. A result's `modelCalls:0` describes only the probe, not the surrounding model task.

C/C++ uses installed clangd and reuses one backend. Its cleanup waits for actual process exit and drains closed output pipes, replacing a fixed half-second delay. Failure to finish within two seconds explicitly fails cleanup; the parent isolation layer still performs final reclamation. This reduces cleanup time at task completion, edit-triggered replacement and direct probes without changing clangd diagnostic or indexing settings. Cleanup implementations for Python and JS/TS are unchanged. The installer already declares clangd; older runtimes missing it must provision it first. Single-file snapshots omit project headers and compilation databases, so they do not establish full-project compilation results.

## Compatibility and licensing

C# uses the installer's pinned .NET 10 SDK and csharp-ls 0.26.0. The probe generates a first-party minimal project referencing only the admitted `.cs` file. It loads no user project configuration, external dependencies or custom build tasks, performs no NuGet downloads, and writes intermediate files only under `/tmp`. Its fixed environment disables telemetry, diagnostic ports and MSBuild node reuse, and caps each .NET process's managed heap at 512 MiB; the entire task still obeys its existing cgroup limits. C# reuses one server and uses exit-aware cleanup. Early process exit immediately returns unavailable instead of waiting for the full query timeout. Cold startup remains significant and edits still require a restart. This single-file .NET 10 analysis does not establish correctness of Unity assemblies, custom frameworks or full-project compilation.

Existing `lsp_*`, `code_overview`, `ast_search`, `code_rewrite` and other compatibility tools remain available. The task prompt prefers `yhwh_lsp_*` for single-file semantic checks without silently replacing a failed check with successful structural analysis. Rename, project-wide symbols and cross-file completeness are outside the new guarantees.

This stage still installs pi-lsp-extension and retains the public-release license hold. Complete removal requires migrating the structural backend and remaining compatibility features, then removing the dependency and upstream source excerpts. See [LSP component notes](lsp-component.en.md).

## Verification

Java uses fixed Java 21 and JDT LS 1.60.0 through a dedicated launcher that sets runtime and shared-library paths. It mounts only the JDK `security` configuration directory read-only, excluding management credential directories, and retains empty `/proc` and network isolation. Eclipse configuration copies, indexes and caches live only in the probe's disposable `/tmp`. Fixed settings disable Maven/Gradle import, automatic builds and additional referenced libraries; user build configuration is not loaded. Java retains one reusable server, exit-aware cleanup and immediate failure on early server exit. Non-project/off-classpath diagnostics return unavailable rather than passing as semantic checks.

The Java probe uses one processor, Serial GC, a 64 MiB initial heap, a 512 MiB maximum heap and tier-1 JIT compilation to reduce startup and first-index costs in short tasks. Existing whole-task resource limits still apply. This profile targets task-local reuse with at most 64 calls; it is not general JVM advice for persistent Java services. Cold startup and first references still take seconds; edits require restart. Single-file and standard-library analysis does not establish correct Maven/Gradle, Android or multi-module builds.

Run `npm test` under `payload/pi-dispatch` for ordinary regression checks. Maintainers with the provisioned WSL runtime can run `python install/Test-PiLspAdapter.py`: it loads the plugin through the real Pi SDK and checks all seven tools, visibility of newly written files, cancellation, file confinement and network/read-only isolation through IPC and real servers, then cleans up temporary tasks. It invokes no model and deploys no files. It does not establish every language, clean-machine installation or autonomous tool selection by a model.

Add `--installed` to check the installed runtime adapter bytes. They are copied into a temporary test directory without modifying the running service.

Add `--benchmark` to alternate two rounds of cold and reused queries. Each round requests diagnostics, hover, symbols, definition, references and diagnostics, asserts complete semantic result equivalence, and verifies real-server idle cleanup. Timings include startup and final cleanup. This single-file TypeScript fixture does not establish speedups for every language, large projects or actual model tasks.

Add `--python-benchmark` to alternate two rounds of Python single-slot and dual-backend policies. Each round alternates eight diagnostic/semantic queries, asserting equivalent results, backend reuse, at most two snapshots, and final/idle cleanup. It also samples memory for the whole test cgroup, including test processes, servers and file cache. The ordinary real SDK checks also cover Python dual-backend reuse and invalidation of both backends after an edit. These tests invoke no model; their memory use and timings do not establish full model-task or large-project performance.

Add `--cpp-benchmark` to alternate old and exit-aware cleanup for both C and C++, with identical commands, inputs and resource limits. Each eight-call round covers all seven tools, checks complete result equivalence and samples cgroup memory and task counts (including threads). Ordinary real SDK checks cover C/C++ tools, reuse and disappearance of erroneous diagnostics after editing. Benchmark timings include startup and final cleanup; they do not imply the same speedup for reused queries or compiler analysis itself.

Add `--csharp-benchmark` to compare two rounds of old and exit-aware C# cleanup. Both profiles include the .NET compatibility fixes. Each eight-call round covers all seven tools and asserts session reuse, real error diagnostics and final cleanup. Random completion resolve handles are validated as UUIDs and excluded from semantic comparison; all remaining results are compared. Reports include startup, query and cleanup time, whole-test-cgroup memory and task counts. Ordinary SDK tests also verify fresh diagnostics after editing; isolation tests check read-only private process visibility, no host-root access and no network. These results do not guarantee performance for large C# projects or model tasks.

Add `--java-benchmark` to alternate two rounds of default tiered JIT and tier-1 JIT, with eight calls covering all seven tools per round. Both profiles share the Java compatibility fixes, heap cap, single processor and cleanup logic; only JIT tiering differs. Complete results are compared, with assertions for type-error diagnostics, reuse and final cleanup, plus whole-test-cgroup memory and task counts (including threads). Ordinary SDK tests verify seven Java tools and updated-file diagnostics; isolation checks cover read-only security configuration, empty `/proc` and no network. Upstream references: [JDT LS initialization](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.60.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/handlers/BaseInitHandler.java) and [diagnostic boundaries](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.60.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/handlers/DiagnosticsHandler.java).

### Go and Rust single-file support

Go automatically selects pinned Go 1.27.1 / gopls 0.23.0; Rust selects Rust 1.98.1 / rust-analyzer 1.98.1. Both provide diagnostics, hover, definitions, references, symbols, completion and code-action previews, with task-local server reuse, edit invalidation and final cleanup. No model or API key is required.

Go returns a completed `textDocument/diagnostic` pull response and also requires independent diagnostic publication. The pinned gopls may leave `kind` empty on a full response; only its completed response containing `items` is accepted, never `unchanged`. Module downloads, automatic toolchain downloads, workspace configuration, cgo, external package drivers and telemetry are disabled. A read-only private PID view lets gopls read its own executable. External dependencies and multi-file modules are outside the snapshot scope.

Rust uses a fixed edition-2024 single-file library crate and standard library, without reading Cargo projects. Build scripts, procedural macros, Cargo checks and experimental analyzer diagnostics are disabled. Diagnostics and code actions additionally run a bounded `rustc --emit=metadata` check, await compiler termination and cleanup, and require language-server publication. Every diagnostic request checks again; an initial empty notification cannot prove a clean file. Only temporary metadata is generated: user programs are neither linked nor executed, and this does not establish a successful Cargo workspace build. UTF-8 compiler byte offsets are converted to LSP UTF-16 positions.

Probes have no network or credentials and read only their source snapshot; Rust retains an empty `/proc`. Initial installation downloads official Go/Rust archives with pinned SHA-256 checks and builds gopls using the official module proxy and checksum database. Toolchains are installed only into the managed runtime, without replacing host PATH, rustup or Go settings. See the [Go/Rust materials](../licenses/go-rust-runtime.json). The normal `install/Test-PiLspAdapter.py` suite covers real seven-tool calls, corrected errors, reuse, cleanup and Rust ownership errors. Timings are local small-fixture observations, not large-project performance guarantees.
