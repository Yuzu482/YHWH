# YHWH 多宿主接入

[简体中文](host-integration.md) | [English](host-integration.en.md)

YHWH 0.4 把主代理宿主与 Pi 执行层分开。满足「MCP 工具调用、能够加载并遵守主代理规则」的工具可以接入；主代理模型由宿主选择，不限于 OpenAI。Pi worker/reviewer 的现有模型绑定不变，仍需在运行 Pi 的 Windows 机器上完成对应登录。没有 MCP、不能调用工具或不能加载规则的客户端，需要先补适配桥，不能声称已经兼容。

## 安装与导出

```powershell
# 单文件安装器：宿主列表使用一个逗号分隔的字符串
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-YHWH-0.5.0.ps1 -Hosts "cherry-studio,opencode,deepseek-harness,claude-code"
```

新的一键入口默认 `generic`。只有显式选择 `codex` 才安装 Codex 全局规则、技能、插件注册和多代理设置。高级配置增加 `hosts` 数组；旧配置未提供该字段时仍按 `codex` 处理，保持兼容。不要同时配置 `opencode` 和 `opencode-v2` 到同一客户端，它们对应不同的配置版本。

安装结束会显示接入文件目录，记录也保存在 `~/.local/state/pi-kether/installation-hosts.json`。导出不会改写第三方应用的配置或数据库。每个目录包含 `connection.json`、`PRIMARY-AGENT.md`、`adapter.json` 和宿主专用配置。已有 0.5 安装可重新导出到一个尚不存在的目录：

```powershell
pwsh -NoProfile -File .\install\Export-HostProfiles.ps1 -Hosts all -OutputDirectory D:\YHWH-Connections
```

路径已根据目标机器展开；这些接入文件不是跨机器配置，也不应提交 Git。移机后重新安装/导出。导出不读取凭据，不嵌入令牌，不把当前 shell 的 PATH 或其它环境复制给应用。

## 宿主配置

0.5 新增的 Cursor、VS Code/Copilot、Windsurf Cascade、Cline、Roo Code、Gemini CLI、Kiro、Zed、Continue、LM Studio 见[常见客户端指南](common-clients.md)。以下保留原有接入路径。

| 宿主 ID | 连接与主代理规则 |
| --- | --- |
| `generic` | 按客户端的 MCP 设置填入 `mcp.json` 中 `yhwh` 的命令、参数和环境；把 `PRIMARY-AGENT.md` 放进主代理的持续指令。 |
| `cherry-studio` | 支持 JSON 导入的版本可导入 `mcp.json`；也可在 MCP 设置新建 stdio 服务，按 `server-fields.json` 填字段。启用服务，并将 `PRIMARY-AGENT.md` 加入所选助手/Agent 的系统提示词。使用支持工具调用的模型。 |
| `opencode` | 将 `opencode.json` 的 `mcp.yhwh` 和 `agent.yhwh` 合并到已有配置，保留其他配置。选择 `yhwh` 主代理或运行 `opencode --agent yhwh`。也可在当前终端把 `OPENCODE_CONFIG` 指向导出的文件。 |
| `opencode-v2` | 使用该目录的配置；连接放在 `mcp.servers.yhwh`，主代理放在 `agents.yhwh`。不要混用 v1 字段。 |
| `claude-code` | 将 `.mcp.json` 的 `mcpServers.yhwh` 合并到项目 `.mcp.json`；将导出 `CLAUDE.md` 的规则追加到现有项目 `CLAUDE.md`。新会话中按 Claude 的提示批准该服务器，用 `/mcp` 核对连接。不要覆盖已有文件。 |
| `claude-desktop` | 在 Developer → Edit Config 中，把 `mcp.json` 的 `mcpServers.yhwh` 合并到桌面配置，保留其他服务。重新打开应用；将 `PRIMARY-AGENT.md` 放入该项目/对话的持续指令，确认工具已启用。 |
| `deepseek-harness` | 复制一个已工作的 Agent preset 为 YHWH 专用 preset；在副本 `agent.cordis.yml` 中合入 `agent.rows.cordis.yml` 的两条记录，再选择此 preset。下面有 DSH 的特殊要求。 |
| `codex` | 安装器负责原有插件和全局规则；导出的 `AGENTS.md`/`mcp.json` 供手动接入或检查。不要重复注册同一个网关。 |

OpenCode 配置只对新增 `yhwh` 主代理禁用原生下级代理调用，不放宽编辑或执行权限，也不改用户其他 Agent。Claude/Cherry/DSH 继续遵循宿主的权限与审批机制；规则文本不会替代权限执行。

### DeepSeek Harness

导出的 `.yml` 使用合法 YAML 1.2 的 JSON 表达，包含原生 `@deepseek-ai/dsh-mcp-client` 与 `@deepseek-ai/dsh-persona` 配置，不引入自写加载器。两条记录的 ID 必须唯一；若副本已有 persona，合并规则到现有 persona，不重复注册。

**persona 只能放在 Agent preset 的作用域内**，不能粘贴到全局 `cordis.yml`：它会与全局 persona 冲突。保留已有 preset 的工具和权限；连接失败不会让整个 DSH 启动失败，但主代理必须报告工具缺失。目标 DSH 版本必须包含这两个原生包；若旧版没有 persona，可将同样规则追加到 DSH 已启用的 `AGENTS.md` 指令入口，并只加入 MCP 行。安装前查看实际版本和现有条目，不能盲目增加重复 loader。

DSH 当前 MCP 桥只消费工具，不消费 MCP Prompts/Resources，因此 YHWH 通过 `get_workflow` 提供治理规则。它的非文本渲染可能无法显示监控卡片；状态与结果工具仍是验收依据。此仓库未修改或重启现有 DSH profile。

## 接入验证

先做不调用模型的协议检查：

```powershell
# 使用安装生成的 Node 完整路径，以及插件和导出目录的真实路径
node "$HOME\plugins\pi-dispatch\scripts\check-host-connection.mjs" D:\YHWH-Connections\opencode\connection.json
```

检查程序真实启动 stdio 进程，完成 MCP 握手、工具发现和主代理规则读取；其输出将沙箱、宿主规则加载、界面与模型心跳分别标为 `unverified`，不会把协议通畅当成完整执行成功。

随后在目标宿主的新会话中，让主代理调用 `get_workflow(topic="primary")`、`get_workflow(topic="pi-routing")` 和 `list_capabilities`，确认根目录、角色绑定和沙箱状态。宿主会给工具加前缀，必须使用其实际发现的名称。确认模型与费用授权后，才做 worker/reviewer 心跳；测试写任务还需要人工核对返回补丁、主代理应用和最终结果。

不具备文件编辑工具的聊天宿主仍能协调、检查和返回建议，但不能自动把沙箱补丁应用到真实项目。主代理必须明确移交给有能力且获授权的工具/人，不能报告虚假的“已修改”。

## 多宿主同时使用与平台边界

本地 stdio 默认一连接一运行时。同一安装默认一次只使用一个主宿主；需要多宿主并发时，先配置同一个受认证的 HTTP 网关，再通过 `PI_GATEWAY_CONFIG` 对应的本地 stdio 代理共享调度器。导出器会保留配置文件路径，不读取或复制里面引用的令牌。仅共享 ledger/锁不等于共享资源总额度；也没有独立租户隔离。

宿主可以替换，不代表后端已跨平台：当前安装和隔离实现仍要求 Windows 11 x64 + WSL2。云端或另一台机器上的宿主还需要受认证的远程传输或 Tunnel；本地 stdio 配置不能直接贴到云端使用。只支持旧 SSE 的客户端需要额外协议桥。

## 依据和验证范围

- [OpenCode v1 MCP](https://opencode.ai/docs/mcp-servers/) 与 [primary Agent](https://opencode.ai/docs/agents/)；[OpenCode v2 MCP](https://opencode.ai/v2/docs/mcp-servers) 与 [Agent](https://opencode.ai/v2/docs/agents)。本机 OpenCode 1.18.25 的真实 `mcp list` 已确认 `yhwh connected`，测试使用隔离配置目录且无模型调用。
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)；[MCP 官方 Claude Desktop 接入说明](https://modelcontextprotocol.io/docs/develop/connect-local-servers)。
- [Cherry Studio 官方 MCP 字段定义](https://github.com/CherryHQ/cherry-studio/blob/main/src/shared/data/types/mcpServer.ts) 与 [创建接口](https://github.com/CherryHQ/cherry-studio/blob/main/src/shared/data/api/schemas/mcpServers.ts)。
- DSH 根据当前本地源码 `packages/mcp/mcp-client`、`packages/preset/persona`、`packages/context/agent-instructions` 的实际接口适配；未启动 DSH GUI 验证。

自动化覆盖真实 MCP 传输、规则读取、宿主配置生成、拒绝非法输出路径/未知环境字段和不覆盖现有目录。非 Codex 安装在隔离目标目录中实测，跳过 WSL 和 Tunnel，未创建 `.codex`/`.agents`。Cherry、Claude、DSH 界面接入、OpenCode v2 实机加载、完整模型治理链和新机器 WSL 安装仍未验证。规则加载不构成主代理遵守规则的证明。
