# YHWH

[![简体中文](.readme-assets/zh.svg)](README.md) [![English](.readme-assets/en.svg)](README.en.md)

A private source repository for Kether governance rules and the Pi execution workflow. The primary agent owns intent, authorization, task decomposition, integration and acceptance. Pi provides governed model calls, deterministic LSP, resource limits, result validation and runtime monitoring.

See the [architecture development history (Chinese)](docs/architecture-history.md) for the background, evolution, key decisions and historical verification limits. The [history evidence index (Chinese)](docs/history-evidence.json) contains the corresponding sanitized records.

Every maintained README in this repository has complete Chinese and English versions with language buttons at the top. Keep both versions synchronized when adding or editing documentation. See [AGENTS.md](https://github.com/Yuzu482/YHWH/blob/main/AGENTS.md) for the maintenance rules (a repository file, excluded from the installation package).

## Repository layout

- `payload/pi-dispatch/`: gateway source, plugin, editor bridges, tests and module lifecycle implementation.
- `payload/workflow-skills/`: Kether role skills and primary-agent routing skills.
- `templates/AGENTS.kether.md`: compact global policy entry point.
- `templates/agent-references/`: on-demand governance, routing, contract, authentication and evidence rules.
- `install/`: installation, validation, host authentication configuration and WSL sandbox provisioning tools.

The current policy pins workers to Luna/max and reviewers to Sonnet/max. Actual availability still depends on the destination account, model service and gateway capability checks. Lifecycle management supports dependency-ordered startup, failure rollback and reverse-order disposal. Only a trusted host may replace dispatch/LSP adapters while the gateway is idle. See [module lifecycle](payload/pi-dispatch/MODULE-LIFECYCLE.md).

The repository excludes credentials, personal runtime configuration, request ledgers, audit logs, caches, dependency directories and machine backups. The image workflow's `image-prompt-review` plugin must be installed separately; this repository contains only the policy reference.

## Pi Kether Portable

This reproducible Windows 11 + WSL2 installation package installs the current Kether/Tifereth workflow, Codex/ChatGPT plugin and Pi execution environment on another host.

It provides:

- A direct Node stdio entry point for the `pi-dispatch` Codex plugin and an authenticated HTTP entry point for Secure MCP Tunnel.
- Kether role and routing skills, plus global `AGENTS.md` rules with on-demand references.
- `openai-codex` for ordinary lower agents; `pi-claude-code-provider` / `claude-sonnet-5` exclusively for Geburah/reviewer, with no tools or file access.
- A WSL2/Bubblewrap sandbox with limits on CPU, memory, process count, output, execution time and write scope.
- Request ledgers, idempotency, provider circuits, audit redaction, result-format validation, task queues and monitor cards.
- LSP services for Python, Java, JavaScript, TypeScript, C# and C/C++.

## Installation

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
5. Restart Codex/ChatGPT Work to reload the plugin and global workflow rules.

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

The logon task uses a console-free `wscript.exe` launcher to hide the window when creating the PowerShell process, avoiding flashes that may occur with `-WindowStyle Hidden` alone. Windows Script Host must be available. Gateway, WSL child processes and LSP launches also use hidden-window process options.

```powershell
pwsh .\install\Test-PiKether.ps1 -Installed
pwsh .\install\Uninstall-PiKether.ps1
```

Removal archives plugin and workflow files while retaining the WSL distribution and `/opt/pi-kether`, so other data in the distribution is preserved.

## Reproducibility and security boundaries

Ordinary execution accepts only `openai-codex`. Geburah/reviewer may use Claude Sonnet 5 with `access:none` and review materials supplied by the primary agent. Claude requires host login; credentials are excluded from the package. Claude's Bun runtime uses a private `/proc` inside an isolated PID namespace; other execution tasks retain an empty `/proc`. Task snapshots contain only the union of `readScope` and `writeScope`, using relative file paths or directory `/**` entries. `.env`, credentials, private keys and project Pi configuration are denied by default. Snapshots are limited to 128 MiB and 10,000 files, with a 30-second preparation scan limit. Each task's temporary filesystem is limited to 512 MiB and 30,000 inodes. Both the resulting file tree and patches are checked against write scope; binary patches are rejected.

LSP cannot load project `.pi-lsp.json` files or auto-discover a Lombok Java agent. Tools cannot read credential files. A single route's credential enters the trusted Pi process through a one-time file descriptor that is then closed. The installer tightens Windows credential and state-directory permissions. OAuth refresh and persistence occur on the host; the sandbox receives temporary access tokens only. Network access remains available for model and language services; no outbound domain allowlist is enforced. These scope checks do not protect against compromise of trusted Pi/LSP dependencies or the operating system itself.

Dependency versions are recorded in `portable.manifest.json`. Node and JDT LS downloads are checked against upstream hashes; Pi's npm dependency tree is pinned by the included lockfile. Installation still requires network access to official Ubuntu, Node.js, npm, Eclipse and Microsoft distribution sources. An offline package cannot replace model login, OpenAI Tunnel setup, ChatGPT workspace administrator authorization or destination-host policy.

Existing configuration is saved under `~/.local/state/pi-kether/installer-backups/` before changes. The installer manages only the `PI-KETHER`-marked block in `AGENTS.md` and disables Codex's built-in multi-agent route so lower-agent execution goes through Pi.
