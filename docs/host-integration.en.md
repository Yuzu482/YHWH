# YHWH host integration

[简体中文](host-integration.md) | [English](host-integration.en.md)

YHWH 0.4 separates the primary host from Pi execution. A host needs MCP tool calling and a way to load and follow primary-agent instructions. Its primary model is selected in that host, with no OpenAI requirement. Existing Pi worker/reviewer bindings remain unchanged and require their respective logins on the Windows runtime machine. Clients without MCP, tool calling or instruction loading require an additional bridge; they are not already compatible.

## Installation and export

```powershell
# Pass the host selection as one comma-separated string
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-YHWH-0.5.0.ps1 -Hosts "cherry-studio,opencode,deepseek-harness,claude-code"
```

The new one-click entry defaults to `generic`. Only explicit `codex` selection installs Codex global rules, skills, plugin registration and multi-agent settings. Advanced configuration gains a `hosts` array; older configurations that omit it retain the `codex` default for compatibility. Do not configure both `opencode` and `opencode-v2` in one client: they target different configuration versions.

Installation prints the export directory and records it in `~/.local/state/pi-kether/installation-hosts.json`. Export does not edit third-party application settings or databases. Each directory contains `connection.json`, `PRIMARY-AGENT.md`, `adapter.json` and host-specific configuration. From an existing 0.5 installation, export again into a directory that does not yet exist:

```powershell
pwsh -NoProfile -File .\install\Export-HostProfiles.ps1 -Hosts all -OutputDirectory D:\YHWH-Connections
```

Paths are expanded for the destination machine. These profiles are machine-specific and should not be committed to Git; reinstall/export after moving machines. Export never reads credentials, embeds tokens, or copies the installing shell's PATH or arbitrary environment into applications.

## Host setup

For the ten clients added in 0.5—Cursor, VS Code/Copilot, Windsurf Cascade, Cline, Roo Code, Gemini CLI, Kiro, Zed, Continue and LM Studio—see the [common client guide](common-clients.en.md). Existing integrations remain below.

| Host ID | Connection and primary instructions |
| --- | --- |
| `generic` | Enter the `yhwh` command, arguments and environment from `mcp.json` into the client's MCP settings. Load `PRIMARY-AGENT.md` as persistent primary instructions. |
| `cherry-studio` | Import `mcp.json` in versions supporting JSON import, or create a stdio server using `server-fields.json`. Enable it and add `PRIMARY-AGENT.md` to the selected assistant/Agent system prompt. Select a tool-capable model. |
| `opencode` | Merge `mcp.yhwh` and `agent.yhwh` from `opencode.json` into the existing config without replacing other settings. Select the `yhwh` primary agent or run `opencode --agent yhwh`. Alternatively point the current terminal's `OPENCODE_CONFIG` at the exported file. |
| `opencode-v2` | Use this directory's config: connections belong under `mcp.servers.yhwh`, agents under `agents.yhwh`. Do not mix v1 fields. |
| `claude-code` | Merge `mcpServers.yhwh` from `.mcp.json` into the project's `.mcp.json`. Append the exported `CLAUDE.md` instructions to the existing project `CLAUDE.md`. In a new session, approve the server when Claude requests it and check `/mcp`. Do not overwrite existing files. |
| `claude-desktop` | Under Developer → Edit Config, merge `mcpServers.yhwh` from `mcp.json`, preserving other servers. Reopen the app, load `PRIMARY-AGENT.md` into persistent project/conversation instructions and enable the tools. |
| `deepseek-harness` | Copy a working Agent preset into a dedicated YHWH preset, merge the two rows from `agent.rows.cordis.yml` into its `agent.cordis.yml`, and select that preset. See the DSH-specific constraints below. |
| `codex` | The installer manages the original plugin and global rules. Exported `AGENTS.md`/`mcp.json` support manual setup or inspection. Avoid registering the same gateway twice. |

OpenCode configuration denies native subagent calls only for the new `yhwh` primary agent. It does not broaden edit/execution permissions or modify other agents. Claude, Cherry and DSH retain their host permissions and approvals; prose does not replace permission enforcement.

### DeepSeek Harness

The `.yml` export uses JSON, which is valid YAML 1.2, and configures native `@deepseek-ai/dsh-mcp-client` and `@deepseek-ai/dsh-persona` packages rather than a custom loader. Row IDs must be unique. If the copied preset already has a persona, merge these instructions into that persona instead of registering another.

**Persona must be scoped to an Agent preset**, never pasted into global `cordis.yml`, where it conflicts with the global persona. Retain the preset's existing tools and permissions. Connection failure does not abort all DSH startup, but the primary must report unavailable tools. The DSH version must provide both native packages. For an older version without persona, append the same rules to its enabled `AGENTS.md` instruction entry and add only the MCP row. Inspect installed versions and entries before adding anything; do not create duplicate loaders.

The current DSH MCP bridge consumes tools, not MCP Prompts/Resources, so YHWH serves policy through `get_workflow`. Its non-text projection may not render monitor cards; status/result tools remain the acceptance evidence. This repository does not modify or restart the existing DSH profile.

## Connection verification

First run a protocol check without model calls:

```powershell
# Use the installed Node executable and the actual plugin/export paths
node "$HOME\plugins\pi-dispatch\scripts\check-host-connection.mjs" D:\YHWH-Connections\opencode\connection.json
```

The checker starts a real stdio process, completes MCP initialization, discovers tools and retrieves the primary policy. It separately reports sandbox, host instruction loading, UI and model heartbeat as `unverified`; protocol success is not full execution success.

Next, in a new target-host session, have the primary call `get_workflow(topic="primary")`, `get_workflow(topic="pi-routing")` and `list_capabilities`, and verify roots, role bindings and sandbox status. Hosts prefix tools: use discovered names. Only run worker/reviewer heartbeats after confirming model/cost authorization. A write-task test additionally requires checking the returned patch, primary application and final project result.

A chat host without file-editing tools can coordinate, inspect and return proposals, but cannot automatically apply sandbox patches to the real project. The primary must hand off to a capable, authorized tool/person and must not report fictitious edits.

## Concurrent hosts and platform limits

Local stdio defaults to one runtime per connection. Use one active primary at a time per installation. Concurrent hosts require one authenticated HTTP gateway, with local stdio proxies using `PI_GATEWAY_CONFIG` to share its scheduler. Export preserves the config-file path without reading/copying referenced tokens. Shared ledgers/locks alone do not create a shared resource budget; this is not tenant isolation.

Replaceable hosts do not imply a cross-platform backend: installation and isolation still require Windows 11 x64 + WSL2. A cloud host or another machine additionally needs authenticated remote transport or a Tunnel; local stdio profiles cannot be pasted into a cloud client. SSE-only clients need a separate protocol bridge.

## Sources and verification scope

- [OpenCode v1 MCP](https://opencode.ai/docs/mcp-servers/) and [primary agents](https://opencode.ai/docs/agents/); [OpenCode v2 MCP](https://opencode.ai/v2/docs/mcp-servers) and [agents](https://opencode.ai/v2/docs/agents). The installed OpenCode 1.18.25 client reported `yhwh connected` via real `mcp list`, with isolated configuration and no model calls.
- [Claude Code MCP](https://code.claude.com/docs/en/mcp); [official MCP Claude Desktop connection guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers).
- [Cherry Studio's official MCP fields](https://github.com/CherryHQ/cherry-studio/blob/main/src/shared/data/types/mcpServer.ts) and [creation API](https://github.com/CherryHQ/cherry-studio/blob/main/src/shared/data/api/schemas/mcpServers.ts).
- DSH adapts actual local source interfaces in `packages/mcp/mcp-client`, `packages/preset/persona` and `packages/context/agent-instructions`; its GUI was not started for validation.

Automated checks cover real MCP transport, policy retrieval, generated host configuration, rejection of invalid output paths/unknown environment fields and no-overwrite exports. Non-Codex installation was exercised in an isolated target directory with WSL/Tunnel skipped and created neither `.codex` nor `.agents`. Cherry/Claude/DSH UI integration, real OpenCode v2 loading, the full model-backed governance chain and fresh-machine WSL installation remain unverified. Loading instructions does not prove primary-agent compliance.
