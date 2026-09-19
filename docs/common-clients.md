# 常见客户端接入

[简体中文](common-clients.md) | [English](common-clients.en.md)

YHWH 0.5 新增 10 个客户端配置，连同已有配置共 18 个宿主 ID。它们是可导出的连接配置与主代理规则，不是客户端安装器，也不代表已通过所有应用的界面或模型测试。共同的运行、授权、并发及 Windows + WSL2 边界见[多宿主指南](host-integration.md)。

## 选择与导出

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-YHWH-0.6.0.ps1 -Hosts "cursor,vscode-copilot,cline,gemini-cli,lm-studio"

# 已安装 0.5：导出全部配置到新目录
pwsh -NoProfile -File .\install\Export-HostProfiles.ps1 -Hosts all -OutputDirectory D:\YHWH-Connections

# 仅列出可用 ID，不连接服务、不调用模型
node .\payload\pi-dispatch\scripts\host-profiles.mjs --list
```

安装器的 `-Hosts` 接受逗号分隔的 ID；`all` 是导出工具的选项。默认安装仍为 `generic`。目录中的配置使用本机绝对路径，换机器或更换 Node/Pi 位置后需要重新导出。

## 配置与规则位置

所有文件均先生成在导出目录中。**将配置中的 `yhwh` 项合并到客户端现有配置，保留其他设置；不要整目录覆盖项目。** 规则文件已包含完整主代理契约；遇到同名规则或已有指令文件时合并内容。每个 `adapter.json` 提供文件位置、适用范围、官方来源和文档核对日期。

| ID / 客户端 | 连接配置 | 主代理规则与启用方式 |
| --- | --- | --- |
| `cursor` / Cursor | 合并 `.cursor/mcp.json` 的 `mcpServers.yhwh`。 | 放入 `.cursor/rules/yhwh.mdc`，使用 `alwaysApply: true`；在 Agent 中确认 MCP 工具可用。 |
| `vscode-copilot` / VS Code Copilot | 合并 `.vscode/mcp.json` 的 `servers.yhwh`，保留 `type: stdio`。 | 合并 `.github/copilot-instructions.md`；使用 Agent 模式并核对已加载指令。Remote/容器窗口中的运行位置可能不同，本机 Windows 路径不能直接在远程执行。 |
| `windsurf` / Windsurf Cascade | 合并 `mcp_config.json` 到设置界面打开的配置，通常为 `~/.codeium/windsurf/mcp_config.json`。 | 放入 `.windsurf/rules/yhwh.md`，`trigger: always_on`。只适用于 Cascade；当前官方页面已跳转到 Devin Desktop，并将此入口标为 legacy，不能用于 Devin Local。 |
| `cline` / Cline | 从扩展的 MCP Servers → Configure 打开设置，合并导出的 `cline_mcp_settings.json`。CLI 使用 `~/.cline/mcp.json`。 | 放入 `.clinerules/yhwh.md` 并确认规则启用；若 `.clinerules` 已是文件，将规则追加到该文件，不创建同名目录。`autoApprove` 为空，保留调用审批。 |
| `roo-code` / Roo Code | 合并项目 `.roo/mcp.json`。 | 放入 `.roo/rules/yhwh.md`；如果原来使用 `.roorules`，将其中规则也迁入目录，避免目录优先级导致旧规则不再载入。`alwaysAllow` 为空。 |
| `gemini-cli` / Gemini CLI | 合并项目 `.gemini/settings.json` 的 `mcpServers.yhwh`。 | 合并根目录 `GEMINI.md`；在新会话检查 `/mcp` 与 `/memory show`。保持 `trust: false`；目录信任和工具审批仍由客户端管理。 |
| `kiro` / Kiro 本地 IDE/CLI | 合并 `.kiro/settings/mcp.json`。 | 放入 `.kiro/steering/yhwh.md`，`inclusion: always`；确认当前 Agent 未用同名服务器覆盖它。`autoApprove` 为空。此本地 stdio 配置不适用于 Web/Mobile 云端执行。 |
| `zed` / Zed 原生 Agent | 在 Zed 的 Open Settings File 中合并 `settings.json` 的 `context_servers.yhwh`。 | 合并根目录 `AGENTS.md`。Zed 只使用首个匹配的项目规则文件；若已有 `.rules` 等更高优先级文件，应合入实际生效文件。外部 ACP Agent 的规则加载另行配置。 |
| `continue` / Continue IDE | 放入 `.continue/mcpServers/yhwh.json`，或合并已有同名服务。 | 放入 `.continue/rules/yhwh.md`，`alwaysApply: true`；选择支持工具的 Agent 模式。此目录自动发现方式未针对 Continue CLI 验证。 |
| `lm-studio` / LM Studio | 在应用的 MCP 设置中编辑 `mcp.json`，合并 `mcpServers.yhwh`。 | 把 `SYSTEM-PROMPT.md` 放进当前聊天的系统提示词，选择支持工具调用的模型并启用服务。没有文件工具时，主代理不能自动应用 Pi 返回的补丁。 |

每个宿主目录还包含统一的 `connection.json` 和 `PRIMARY-AGENT.md`。配置不会添加令牌、全工具自动批准或修改原有模型设置。主代理采用宿主选择的模型；Pi 的 worker/reviewer 绑定不变。

## 验证边界

自动化会从这 10 种原生配置结构中取出连接，分别真实启动网关，完成 MCP 握手、工具发现和规则读取；也检查规则元数据、嵌套目录导出与不覆盖已有目录。**这是导出连接的协议验证，不是这 10 个应用的原生解析器或 GUI 验证。** `adapter.json` 始终把客户端界面与模型心跳标为未验证。

导入后，在所选客户端的新会话中检查 `get_workflow(primary)`、`get_workflow(pi-routing)`、`list_capabilities`，再按[接入验证](host-integration.md#接入验证)进行获授权的模型测试。已有 0.4 的 OpenCode 连接证据不替代本轮新客户端测试。

网页聊天、云端 Agent、仅支持远程 HTTP 的客户端不能直接使用这些本地 stdio 文件。它们需要单独配置受认证的远程网关和规则入口；本次不导出带凭据的远程配置。

## 官方接口依据

核对日期：2026-09-18；未来版本可能变化。

- Cursor：[MCP](https://prod.cursor.com/help/customization/mcp)、[规则](https://prod.cursor.com/docs/rules)。
- VS Code：[MCP](https://code.visualstudio.com/docs/agent-customization/mcp-servers)、[指令](https://code.visualstudio.com/docs/agent-customization/custom-instructions)。
- Windsurf Cascade：[MCP](https://docs.windsurf.com/windsurf/cascade/mcp)、[规则](https://docs.windsurf.com/windsurf/cascade/memories)。
- Cline：[MCP](https://docs.cline.bot/mcp/mcp-overview)、[规则源码](https://github.com/cline/cline/blob/main/docs/customization/cline-rules.mdx)。
- Roo Code：[MCP](https://docs.roocode.com/features/mcp/using-mcp-in-roo)、[指令](https://docs.roocode.com/features/custom-instructions)。
- Gemini CLI：[MCP](https://geminicli.com/docs/tools/mcp-server/)、[GEMINI.md](https://geminicli.com/docs/cli/gemini-md/)。
- Kiro：[MCP](https://kiro.dev/docs/mcp/configuration/)、[Steering](https://kiro.dev/docs/steering/)。
- Zed：[MCP](https://zed.dev/docs/ai/mcp)、[指令](https://zed.dev/docs/ai/instructions)。
- Continue：[MCP](https://docs.continue.dev/customize/deep-dives/mcp)、[规则](https://docs.continue.dev/customize/deep-dives/rules)。
- LM Studio：[MCP](https://lmstudio.ai/docs/app/mcp)、[系统提示词入口](https://lmstudio.ai/blog/lmstudio-v0.3.17)。
