# YHWH

[![简体中文](.readme-assets/zh.svg)](README.md) [![English](.readme-assets/en.svg)](README.en.md)

**Primary reasoning and orchestration only:** Astra (or the host-selected primary model) owns planning, scheduling, patch integration and acceptance. Pi subagents author code, tests and implementation repairs. Native workers default to Luna/medium, with explicit low, high or max effort chosen for task complexity. Worker failure never silently falls back to primary coding. This is a host instruction policy, not a mechanism disabling every client's editing tools; see [ownership and failure handling](docs/coordinator-only.en.md) and [worker thinking and delivery budgets](docs/worker-budgets.en.md).

**Subagent supervision heartbeats:** Local timers provide heartbeats without model calls and track execution progress separately; silence never triggers automatic retries. This does not prove remote-model health or automatically wake the primary; see [heartbeat behavior and deployment boundaries](docs/subagent-heartbeat.en.md).

**Delivery diagnostics (unreleased):** Thinking, text and tool event counts plus recent activity timings help explain worker timeouts, without retaining raw content or changing budgets and success criteria. Existing installations require an upgrade. This is not a completion-wait interface; see [diagnostic fields and evidence boundaries](docs/worker-delivery-diagnostics.en.md).

Sequential-call improvements: `HeadlessBatchEvents` streams per-request phases, waiting status and results. Session caches reduce repeated file reads and hashing while retaining exact version checks. Entire batches are validated before execution; session calls are serialized and stop after failure, with cache and phase timings reported. See [operations and acceptance boundaries](docs/workflow-operations.md#english).

**v0.12 workflow improvements:** live CLI echo acceptance, sequential batches and timing evidence, optional Windows Job Object cleanup, managed plugin upgrade/rollback, Git change-impact candidates and Windows CI configuration. Antigravity remains disabled with an empty path; CI still has failures. Source capabilities, deployment and publication are tracked separately; see the [operations and acceptance guide](docs/workflow-operations.md#english).

New optional feature: official Codex, Claude Code and Antigravity headless primary-host entries, with exact version checks, normalized results, bounded execution and release/local file comparison. Existing Pi routes are unchanged; clients are disabled by default. See the [guide](docs/headless-cli.md#english).

**0.11 persistent code relationships.** `.yhwh/code-graph/index.json` initially covers files, classes, functions and syntax relationships in JS/TS (including JSX/TSX) and Python. Read-only `code_graph` searches relationships and reverse relative-import impact; the host CLI incrementally refreshes by source hash and offers explicit bounded watching. Unresolved calls, syntax errors and stale state are reported; this is not a complete semantic call graph. See [usage, Git management and limits](docs/code-graph.md#english). The maintainer's local Pi has been updated and verified through actual MCP and incremental refresh checks; this feature shipped in v0.11.0.

A private source repository for Kether governance rules and the Pi execution workflow. The primary agent owns intent, authorization, task decomposition, integration and acceptance. Pi provides governed model calls, deterministic LSP, resource limits, result validation and runtime monitoring.

**v0.13.0:** Native Luna workers now use task-proportional thinking (medium by default), with delivery and cleanup budgets, separate thinking/text/tool diagnostics, and Windows plus credential-free test compatibility fixes. Retains sequential calls, heartbeats, code relationships and deterministic probes. Local services need a separate upgrade and performance benefits have not been benchmarked; see [bilingual release notes](docs/release-notes-0.13.0.md).

See the [architecture development history (Chinese)](docs/architecture-history.md) for the background, evolution, key decisions and historical verification limits. The [history evidence index (Chinese)](docs/history-evidence.json) contains the corresponding sanitized records.

Every maintained README in this repository has complete Chinese and English versions with language buttons at the top. Keep both versions synchronized when adding or editing documentation. See [AGENTS.md](https://github.com/Yuzu482/YHWH/blob/main/AGENTS.md) for the maintenance rules (a repository file, excluded from the installation package).

**0.7 controlled API configuration:** OpenCode Go, CommandCode, OpenRouter and custom HTTPS platforms have optional host-configured API routes. Luna/Sonnet 5 and max bindings, no-tools reviewers and no automatic downgrade remain enforced. New `Configure-Providers.cmd`; see the [platform configuration guide](docs/provider-configuration.en.md). Real accounts and paid heartbeats remain unverified.

**0.8 API key encryption:** Anthropic and aggregator keys use Windows DPAPI user encryption. Runtime uses private pipes without plaintext API credential files. After upgrading, run `Migrate-API-Keys.cmd` for legacy keys. See [configuration and migration](docs/provider-configuration.en.md).

**0.10 long-term project knowledge:** `.yhwh/memory/` stores source-backed Markdown knowledge with draft, accepted and deprecated states. The read-only `project_memory` tool provides Chinese/English search, source-change detection and Git review of staged, unstaged and untracked entries. Updates use the primary's existing file permissions without automatic commits. Git is required on the runtime machine; existing services need an upgrade to discover the tool. See the [usage and management guide](docs/project-memory.md#english).

## Repository layout

**0.5 multi-host integration:** 18 host IDs now include Cursor, VS Code/Copilot, Windsurf Cascade, Cline, Roo Code, Gemini CLI, Kiro, Zed, Continue and LM Studio, alongside existing Codex, Cherry Studio, OpenCode, DeepSeek Harness, Claude and generic profiles. Select the primary model in the host. See the [common client guide](docs/common-clients.en.md) and [multi-host guide](docs/host-integration.en.md); configuration and protocol checks do not validate client UIs or the complete governance chain.

- `payload/pi-dispatch/`: gateway source, plugin, editor bridges, tests and module lifecycle implementation.
- `payload/workflow-skills/`: Kether role skills and primary-agent routing skills.
- `templates/AGENTS.kether.md`: compact global policy entry point.
- `templates/agent-references/`: on-demand governance, routing, contract, authentication and evidence rules.
- `install/`: installation, validation, host authentication configuration and WSL sandbox provisioning tools.

The current policy pins native workers to Luna, with the primary selecting task-proportional thinking (medium by default); reviewers remain Sonnet/max. Actual availability still depends on the destination account, model service and gateway capability checks. Lifecycle management supports dependency-ordered startup, failure rollback and reverse-order disposal. Only a trusted host may replace dispatch/LSP adapters while the gateway is idle. See [module lifecycle](payload/pi-dispatch/MODULE-LIFECYCLE.md).

The repository excludes credentials, personal runtime configuration, request ledgers, audit logs, caches, dependency directories and machine backups. The image workflow's `image-prompt-review` plugin must be installed separately; this repository contains only the policy reference.

## Pi Kether Portable

This Windows 11 + WSL2 package installs host-neutral Kether/Tifereth rules and Pi execution on another machine, and generates connection profiles for the selected primary-agent tools.

It provides:

- A generic Node stdio MCP entry and an authenticated HTTP entry for Secure MCP Tunnel; the Codex plugin is optional.
- Primary rules, role skills and references retrieved through `get_workflow`; selecting Codex additionally installs global rules and skills.
- `openai-codex` for ordinary lower agents; `anthropic` / `claude-sonnet-5` exclusively for Geburah/reviewer, with no tools or file access.
- A WSL2/Bubblewrap sandbox with limits on CPU, memory, process count, output, execution time and write scope.
- Request ledgers, idempotency, provider circuits, audit redaction, result-format validation, task queues and monitor cards.
- LSP services for Python, Java, JavaScript, TypeScript, C#, C/C++, Go and Rust.
- A first-party [Pi LSP adapter](docs/pi-lsp-adapter.en.md): governed workers call isolated multilspy probes through seven `yhwh_lsp_*` tools, reusing servers for unchanged files within one task. Python retains Pyright and Jedi on demand to accelerate alternating queries; servers are reclaimed on idle expiry or task completion. C/C++ and C# use actual exit checks to reduce cleanup waits. C# uses a fixed single-file .NET project and a private read-only process view, failing immediately on early server exit. Java uses a JIT profile for short tasks, one reusable server and disposable indexes. The old extension remains for compatibility.

## Installation

### One-click installation (Windows 11 x64)

The generated `YHWH-OneClick-0.13.0.zip` contains a self-contained script, its checksum and a double-click launcher. Extract it and double-click `Install-YHWH.cmd`, then choose the workspace agents may access. Pressing Enter creates `~/YHWH-Workspace`. Alternatively, copy just the script to the destination computer and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-YHWH-0.13.0.ps1
```

The default exports generic MCP configuration without changing Codex global settings. Select hosts with `-Hosts "cherry-studio,opencode,deepseek-harness,claude-code"`; including `codex` enables the original Codex integration. Import the generated connection profile and load the primary instructions in each host. The exporter never overwrites existing host configuration.

The installer prepares pinned PowerShell 7 and Node runtimes under `%LOCALAPPDATA%\YHWH`. Neither runtime nor Git needs to be preinstalled, and GitHub login is not required. Workflow source is embedded; runtimes and dependencies still require network access. Windows runtime archives and the Ubuntu image are checked against SHA256 values recorded at build time. Changed downloads stop installation instead of silently accepting new hashes.

It imports a dedicated `YHWH` WSL2 Ubuntu 24.04 distribution, installs the Windows plugin, governance rules and WSL sandbox/LSP, then runs installation checks. Enabling WSL for the first time may require Windows administrator approval and a restart followed by rerunning the script. Exit code `3010` means this prerequisite step is pending restart, not successful installation. Hardware virtualization must be enabled and organizational policy must permit WSL. WSL setup follows [Microsoft's official commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands).

After installation, open `%LOCALAPPDATA%\YHWH\Open-Pi.cmd` and use `/login` for the lower worker's OpenAI account. Configure the reviewer with your own Anthropic Console API key using `Configure-Claude-API.cmd`; API usage is billed separately from Claude subscriptions. Connect the selected host using the generated profile and load `PRIMARY-AGENT.md`. When selecting Codex, restart it and enable the plugin if needed. Primary-model accounts belong to the host; lower-model authentication, real heartbeats and ChatGPT Tunnel connectivity require separate verification. The installer does not install host apps, create a Tunnel or migrate credentials; existing managed files retain the underlying installer's backup behavior.

An existing Pi installation is protected by default. Once tasks have ended and its runtime is stopped, explicitly pass `-UpgradeExisting` to allow replacement with backups. A running Pi or a `YHWH` WSL distribution without matching installer ownership stops installation. The script never automatically stops processes, removes a WSL distribution or takes over another Ubuntu distribution. Installation does not provide transactional rollback: failures retain completed steps and backups for diagnosis, and can be retried after addressing the cause. Partial WSL imports or inconsistent ownership records require manual inspection.

```powershell
# Read-only preview: no downloads or host changes
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-YHWH-0.13.0.ps1 -PlanOnly
# Unattended installation with a fixed workspace (WSL must be ready; login is separate)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-YHWH-0.13.0.ps1 -NonInteractive -WorkspaceRoots D:\Projects\MyProject
# Verify and extract only; destination must be a new absolute directory
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-YHWH-0.13.0.ps1 -ExtractOnly -Destination D:\YHWH-Inspect
```

Maintainers run `pwsh -NoProfile -File .\Build-Release.ps1` to generate the portable ZIP, self-contained PS1, SHA256 file and double-click bundle under `release/`. The repository's `Install-YHWH.ps1` also runs directly from a complete source checkout; only the generated versioned script can be copied on its own. `-SkipTests` skips gateway tests only and does not include local `node_modules` in releases. Safe extraction tests: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install\Test-OneClick.ps1 -Installer .\release\Install-YHWH-0.13.0.ps1`.

This version has script and package validation, but a full online installation in a fresh Windows VM has not been performed. Windows and WSL Pi use the same dependency lockfile; Ubuntu repositories, WSL system components and the .NET installer remain mutable external dependencies. This is not a completely offline or byte-for-byte reproducible system image.

### Advanced installation

`Workflow.ps1` is the shared entry point, with configuration maintained in `install.config.json`. The default action is a read-only preflight:

```powershell
pwsh -NoProfile -File .\Workflow.ps1 -Action Init
# Edit install.config.json with your workspace directories and any Tunnel configuration.
pwsh -NoProfile -File .\Workflow.ps1 -Action Plan
pwsh -NoProfile -File .\Workflow.ps1 -Action Install
pwsh -NoProfile -File .\Workflow.ps1 -Action Verify
pwsh -NoProfile -File .\Workflow.ps1 -Action Build
```

`Init` does not overwrite existing configuration. `Plan` validates without installing. `Install` performs installation and backs up existing files. `Verify` checks the installed environment. `Build` validates and creates a versioned ZIP. Installation updates dependencies and may restart the dedicated WSL distribution; wait for active tasks to finish first. This is not a hot-update script. An allowlist controls release contents, excluding local configuration, temporary test directories and runtime credentials.

The shared entry point does not modify Codex's bundled plugin cache. Earlier fixes to this machine's app-tool `cmd.exe` launcher were specific to a Codex version and are not generic installation steps. ChatGPT Work connectivity still depends on the account, workspace permissions and Tunnel configuration. Installing local rules does not establish that they are active in every product session.

1. Prepare PowerShell 7, Windows Node.js 22+, WSL2 and an Ubuntu 24.04 distribution **dedicated to the Pi sandbox**. The installer disables Windows-drive automount and Windows interoperability in that distribution.
2. Copy `install.config.example.json` to `install.config.json`. Set `workspaceRoots` to the destination directories permitted for reads or sandbox-generated patches.
3. Run in a normal user terminal:

   ```powershell
   .\Install.cmd -ConfigFile .\install.config.json
   ```

4. If the destination account is not signed in to Pi/OpenAI, complete Pi login after installation. Credentials remain in the destination host's `~/.pi/agent/auth.json`; the package neither reads nor carries them.
5. Import the connection profile and load primary instructions in the selected host; restart or reconnect Codex/ChatGPT Work when applicable.

Inspect without modifying the host:

```powershell
.\Install.cmd -ConfigFile .\install.config.json -PlanOnly
```

Install only the Windows plugin and workflow, without configuring WSL:

```powershell
.\Install.cmd -ConfigFile .\install.config.json -SkipWsl
```

## Secure MCP Tunnel

The installer does not create an OpenAI Tunnel or embed a Runtime API Key. For an existing Tunnel, configure:

```json
{
  "installTunnel": true,
  "tunnelId": "YOUR_TUNNEL_ID",
  "tunnelRuntimeKeyFile": "C:\\secure\\runtime-key.txt",
  "tunnelClientPath": "C:\\tools\\tunnel-client.exe"
}
```

The installer generates launch scripts that reference key files, creates a logon scheduled task and starts the runtime without a console window. The Tunnel uses the local `127.0.0.1:17331/mcp` HTTP endpoint, avoiding a stdio launch through `cmd.exe`. This endpoint requires a random Bearer credential, and credential-file access is restricted to the current Windows user. The destination host still needs valid runtime credentials for the Tunnel. When upgrading an existing stdio runtime, stop the `pi-kether` runtime once before running the new launcher. Health checks do not automatically interrupt existing tasks.

## Verification and removal

Run `npm test` and `npm run test:memory` separately under `payload/pi-dispatch` for source regression checks. The latter checks complete 256 KiB results, cancellation, disconnection and memory growth; it is not included in the ordinary test count. `Build-Release.ps1` requires both by default. Use `-SkipTests` only for local packaging with existing verification of the same source; it does not establish a test pass. A built package and a running service are separate snapshots; a partial deployment is not a full package upgrade.

The logon task uses a console-free `wscript.exe` launcher to hide the window when creating the PowerShell process, avoiding flashes that may occur with `-WindowStyle Hidden` alone. Windows Script Host must be available. Gateway, WSL child processes and LSP launches also use hidden-window process options.

```powershell
pwsh .\install\Test-PiKether.ps1 -Installed
pwsh .\install\Uninstall-PiKether.ps1
```

Removal archives plugin and workflow files while retaining the WSL distribution and `/opt/pi-kether`, so other data in the distribution is preserved.

## Reproducibility and security boundaries

Default ordinary execution uses `openai-codex`; optional controlled API routes require explicit host configuration and selection. Geburah/reviewer may use Claude Sonnet 5 with `access:none` and review materials supplied by the primary agent. Claude requires a user-owned API key; credentials are excluded from the package. Model execution tasks retain an empty `/proc`; credential-free C# and Go probes use a read-only `/proc` in a private PID namespace. Task snapshots contain only the union of `readScope` and `writeScope`, using relative file paths or directory `/**` entries. `.env`, credentials, private keys and project Pi configuration are denied by default. Snapshots are limited to 128 MiB and 10,000 files, with a 30-second preparation scan limit. Each task's temporary filesystem is limited to 512 MiB and 30,000 inodes. Both the resulting file tree and patches are checked against write scope; binary patches are rejected.

LSP cannot load project `.pi-lsp.json` files or auto-discover a Lombok Java agent. Tools cannot read credential files. A single route's credential enters the trusted Pi process through a one-time file descriptor that is then closed. The installer tightens Windows credential and state-directory permissions. OpenAI OAuth refresh and persistence occur on the host; its sandbox receives a temporary access token. The reviewer receives its API key only in trusted Pi memory through FD3. Network access remains available for model and language services; no outbound domain allowlist is enforced. These scope checks do not protect against compromise of trusted Pi/LSP dependencies or the operating system itself.

Dependency versions are recorded in `portable.manifest.json`. Node and JDT LS downloads are checked against upstream hashes; Pi's npm dependency tree is pinned by the included lockfile. Installation still requires network access to official Ubuntu, Node.js, npm, Eclipse and Microsoft distribution sources. An offline package cannot replace model login, OpenAI Tunnel setup, ChatGPT workspace administrator authorization or destination-host policy.

Managed-file backups are saved under `~/.local/state/pi-kether/installer-backups/`. When Codex is selected, the installer manages the `PI-KETHER`-marked block in `AGENTS.md` and disables Codex's built-in multi-agent route. Other hosts receive exported connection profiles and primary instructions to merge using the integration guide.

## License

Original YHWH code, documentation and configuration are licensed under [Apache-2.0](LICENSE); see [NOTICE](NOTICE). Third-party components retain their own licenses. [Third-party inventory](THIRD_PARTY.en.md) and [Claude Code feasibility](docs/claude-code-feasibility.en.md).

Since 0.6.0 the reviewer uses the native Anthropic API with a user-owned API key. Subscription credential reading/renewal and the Claude Code bridge are removed. Service terms still apply; live API access has not been verified.

## Claude reviewer API setup (0.6)

After installation run `Configure-Claude-API.cmd`, or from source run `powershell.exe -NoProfile -File .\install\Set-ClaudeApiKey.ps1 -TargetHome $HOME`. Input is hidden; the file allows only the current Windows user. Credentials are stored in `~/.local/state/pi-kether/anthropic-api-key.json`. Claude subscription login is never read; environment keys and custom endpoints are not fallback sources. `check_claude_auth` checks local configuration only. Actual key validity, balance and model availability require a separately authorized heartbeat. Claude Code primary clients still use their own official user login.

Existing users should wait for tasks to finish before upgrading and configure an API key. The old `pi-claude-code-provider` route and `renew_claude_auth` tool are no longer accepted. This change did not update the running service. `Build-Release.ps1 -PublicRelease` currently rejects publication because the LSP upstream copyright notice awaits confirmation; ordinary builds create local previews only.

### Go and Rust single-file support

Go automatically selects pinned Go 1.27.1 / gopls 0.23.0; Rust selects Rust 1.98.1 / rust-analyzer 1.98.1. Both provide diagnostics, hover, definitions, references, symbols, completion and code-action previews, with task-local server reuse, edit invalidation and final cleanup. No model or API key is required.

Go returns a completed `textDocument/diagnostic` pull response and also requires independent diagnostic publication. The pinned gopls may leave `kind` empty on a full response; only its completed response containing `items` is accepted, never `unchanged`. Module downloads, automatic toolchain downloads, workspace configuration, cgo, external package drivers and telemetry are disabled. A read-only private PID view lets gopls read its own executable. External dependencies and multi-file modules are outside the snapshot scope.

Rust uses a fixed edition-2024 single-file library crate and standard library, without reading Cargo projects. Build scripts, procedural macros, Cargo checks and experimental analyzer diagnostics are disabled. Diagnostics and code actions additionally run a bounded `rustc --emit=metadata` check, await compiler termination and cleanup, and require language-server publication. Every diagnostic request checks again; an initial empty notification cannot prove a clean file. Only temporary metadata is generated: user programs are neither linked nor executed, and this does not establish a successful Cargo workspace build. UTF-8 compiler byte offsets are converted to LSP UTF-16 positions.

Probes have no network or credentials and read only their source snapshot; Rust retains an empty `/proc`. Initial installation downloads official Go/Rust archives with pinned SHA-256 checks and builds gopls using the official module proxy and checksum database. Toolchains are installed only into the managed runtime, without replacing host PATH, rustup or Go settings. See the [Go/Rust materials](./licenses/go-rust-runtime.json). The normal `install/Test-PiLspAdapter.py` suite covers real seven-tool calls, corrected errors, reuse, cleanup and Rust ownership errors. Timings are local small-fixture observations, not large-project performance guarantees.
