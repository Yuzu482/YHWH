# Common client integration

[简体中文](common-clients.md) | [English](common-clients.en.md)

YHWH 0.5 adds 10 client profiles, bringing the total to 18 host IDs. These export connections and primary instructions; they do not install clients or establish successful UI/model testing in every application. Shared runtime, authorization, concurrency and Windows + WSL2 limits remain in the [host guide](host-integration.en.md).

## Select and export

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-YHWH-0.6.0.ps1 -Hosts "cursor,vscode-copilot,cline,gemini-cli,lm-studio"

# Existing 0.5 installation: export every profile to a new directory
pwsh -NoProfile -File .\install\Export-HostProfiles.ps1 -Hosts all -OutputDirectory D:\YHWH-Connections

# List IDs without connecting or calling a model
node .\payload\pi-dispatch\scripts\host-profiles.mjs --list
```

The installer's `-Hosts` takes comma-separated IDs; `all` belongs to the export tool. Installation still defaults to `generic`. Profiles contain machine-specific absolute paths; re-export after moving machines or changing Node/Pi locations.

## Configuration and instruction locations

All files are initially written inside the export directory. **Merge the `yhwh` entry into existing client settings and preserve other settings; do not overwrite a project with the whole export directory.** Rule files contain the complete primary contract. Merge existing instruction files or rules with the same name. Each `adapter.json` records file locations, scope, official sources and the documentation check date.

| ID / client | Connection configuration | Primary instructions and activation |
| --- | --- | --- |
| `cursor` / Cursor | Merge `mcpServers.yhwh` from `.cursor/mcp.json`. | Place `.cursor/rules/yhwh.mdc`, with `alwaysApply: true`; confirm MCP tools in Agent. |
| `vscode-copilot` / VS Code Copilot | Merge `servers.yhwh` from `.vscode/mcp.json`, retaining `type: stdio`. | Merge `.github/copilot-instructions.md`; use Agent mode and inspect loaded instructions. Remote/container windows may execute elsewhere; local Windows paths cannot run directly on a remote machine. |
| `windsurf` / Windsurf Cascade | Merge `mcp_config.json` into the configuration opened by settings, usually `~/.codeium/windsurf/mcp_config.json`. | Place `.windsurf/rules/yhwh.md` with `trigger: always_on`. Cascade only: current official docs redirect to Devin Desktop and label this configuration legacy; it does not configure Devin Local. |
| `cline` / Cline | Open MCP Servers → Configure in the extension and merge exported `cline_mcp_settings.json`. CLI uses `~/.cline/mcp.json`. | Place `.clinerules/yhwh.md` and confirm it is enabled. If `.clinerules` is already a file, append there instead of creating a same-name directory. Empty `autoApprove` preserves call approval. |
| `roo-code` / Roo Code | Merge project `.roo/mcp.json`. | Place `.roo/rules/yhwh.md`. If `.roorules` was used, migrate its rules into the directory too, so directory precedence does not suppress them. `alwaysAllow` is empty. |
| `gemini-cli` / Gemini CLI | Merge `mcpServers.yhwh` into project `.gemini/settings.json`. | Merge root `GEMINI.md`; check `/mcp` and `/memory show` in a new session. Keep `trust: false`; folder trust and tool approval remain client-managed. |
| `kiro` / local Kiro IDE/CLI | Merge `.kiro/settings/mcp.json`. | Place `.kiro/steering/yhwh.md` with `inclusion: always`; check the active agent does not override the named server. `autoApprove` is empty. Local stdio does not configure Web/Mobile cloud execution. |
| `zed` / native Zed Agent | Use Open Settings File and merge `context_servers.yhwh` from `settings.json`. | Merge root `AGENTS.md`. Zed uses the first matching project instruction file; when `.rules` or another higher-priority file exists, merge into that active file. External ACP agents load instructions separately. |
| `continue` / Continue IDE | Place `.continue/mcpServers/yhwh.json`, or merge an existing server with that name. | Place `.continue/rules/yhwh.md` with `alwaysApply: true`; use tool-capable Agent mode. This directory discovery has not been validated for Continue CLI. |
| `lm-studio` / LM Studio | Edit `mcp.json` in the application's MCP settings and merge `mcpServers.yhwh`. | Paste `SYSTEM-PROMPT.md` into the active chat's system prompt; choose a tool-capable model and enable the server. Without file tools, the primary cannot automatically apply Pi patches. |

Every host directory also includes shared `connection.json` and `PRIMARY-AGENT.md`. Profiles add no tokens, blanket tool approvals or changes to existing model settings. The primary uses the host-selected model; Pi worker/reviewer bindings remain unchanged.

## Verification boundaries

Automation extracts connections from all 10 native configuration shapes, starts the actual gateway for each, and performs MCP initialization, tool discovery and policy retrieval. It also checks rule metadata, nested exports and refusal to overwrite existing directories. **This validates exported connections at the protocol level, not the applications' native parsers or GUIs.** `adapter.json` continues to label client UI and model heartbeats unverified.

After importing, check `get_workflow(primary)`, `get_workflow(pi-routing)` and `list_capabilities` in a new client session. Then follow [connection verification](host-integration.en.md#connection-verification) for authorized model tests. Existing OpenCode evidence from 0.4 does not validate these new clients.

Web chats, cloud agents and remote-HTTP-only clients cannot use these local stdio files directly. They need a separately configured authenticated remote gateway and instruction entry point; this release does not export remote credentials.

## Official interface sources

Checked on 2026-09-18; future versions may change.

- Cursor: [MCP](https://prod.cursor.com/help/customization/mcp), [rules](https://prod.cursor.com/docs/rules).
- VS Code: [MCP](https://code.visualstudio.com/docs/agent-customization/mcp-servers), [instructions](https://code.visualstudio.com/docs/agent-customization/custom-instructions).
- Windsurf Cascade: [MCP](https://docs.windsurf.com/windsurf/cascade/mcp), [rules](https://docs.windsurf.com/windsurf/cascade/memories).
- Cline: [MCP](https://docs.cline.bot/mcp/mcp-overview), [rule source](https://github.com/cline/cline/blob/main/docs/customization/cline-rules.mdx).
- Roo Code: [MCP](https://docs.roocode.com/features/mcp/using-mcp-in-roo), [instructions](https://docs.roocode.com/features/custom-instructions).
- Gemini CLI: [MCP](https://geminicli.com/docs/tools/mcp-server/), [GEMINI.md](https://geminicli.com/docs/cli/gemini-md/).
- Kiro: [MCP](https://kiro.dev/docs/mcp/configuration/), [steering](https://kiro.dev/docs/steering/).
- Zed: [MCP](https://zed.dev/docs/ai/mcp), [instructions](https://zed.dev/docs/ai/instructions).
- Continue: [MCP](https://docs.continue.dev/customize/deep-dives/mcp), [rules](https://docs.continue.dev/customize/deep-dives/rules).
- LM Studio: [MCP](https://lmstudio.ai/docs/app/mcp), [system prompt entry](https://lmstudio.ai/blog/lmstudio-v0.3.17).
