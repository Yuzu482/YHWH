# Pi Kether Gateway

[![简体中文](.readme-assets/zh.svg)](README.md) [![English](.readme-assets/en.svg)](README.en.md)

主代理可来自任何具备 MCP 工具调用和持续规则加载能力的宿主。新增 `get_workflow` 按主题提供主代理契约、角色技能和治理 references；`scripts/host-profiles.mjs` 为 Cherry Studio、OpenCode v1/v2、Claude Code/Desktop、DeepSeek Harness、Codex 和通用客户端导出配置。另有 `scripts/common-client-profiles.mjs` 导出 Cursor、VS Code/Copilot、Windsurf Cascade、Cline、Roo Code、Gemini CLI、Kiro、Zed、Continue 和 LM Studio 配置，总计 18 个宿主 ID；每份新适配的元数据附官方来源与适用范围。连接与配置验证不等于各宿主已完成完整模型治理链验证。默认 stdio 每连接一运行时；多个宿主同时使用需通过 `PI_GATEWAY_CONFIG` 共享同一 HTTP 网关。后端仍要求 Windows + WSL2。

Pi 作为受 Tifereth 控制的下级 Agent 执行层、模型探针层和 LSP 层。默认安装使用 stdio；可选共享运行时使用本机 Streamable HTTP MCP 端点 `http://127.0.0.1:17331/mcp`。模型任务先经过 Kether 运行信封，再按精确 allowlist 路由到：

- `openai-codex`（worker：`gpt-5.6-luna` / `max`）
- `anthropic`（Geburah/reviewer：`claude-sonnet-5` / `max`，仅限 `access:none`）

网关提供同步执行、异步监控、模型探针和 LSP 工具。监控路径使用 `submit_subagent`、`get_subagent_status`、`get_subagent_result`、`list_subagents`、`cancel_subagent` 和 `render_subagent_monitor`；最后一个工具返回 MCP Apps 对话内卡片，按 `parentRunId` 自动刷新任务树。调用方不能提交原始 Pi 参数、环境变量或自由工具列表；Pi 启动时禁用自动扩展发现，只按任务加载受控 provider 与 LSP extension。实际响应中的 provider、model 和 `toolsUsed` 会返回给 Tifereth 验收。

`result-format-validator` 对普通模型子 Agent 的最终文本执行确定性验证，不调用模型。下级 Agent 必须只返回 `KETHER_RESULT_JSON=<JSON object>`；JSON 键必须符合 v2 角色结果结构；请求通常省略 `returnFields`，由网关选用完整角色结构，`status` 只能是 `completed / failed / blocked / unverified`。额外说明、Markdown 围栏、缺失或多余字段、无效 JSON、超过 512 KiB、超过 12 层或 4096 个节点都会返回 `result_format_invalid`。验证通过的对象放在响应的 `structuredResult`，验证摘要放在 `formatValidation`。格式失败属于 Netzach 结果质量失败，不会打开 Provider 熔断。模型心跳继续使用精确纯文本令牌，不套用该格式。

审计扩展对每次已接纳调用追加一条 JSONL 记录，包含 `requestId`、任务信封 SHA-256 与结构计数、请求和实际 provider/model、工具调用计数、耗时、token 统计、补丁哈希/大小/文件与行数摘要，以及脱敏后的失败原因。审计记录不保存原始任务、模型回复、诊断文本或补丁正文；Bearer、API key、token、密码、私钥、JWT 和 URL 凭据会在写入前清除。未提供 `requestId` 时网关会生成一个并随响应返回。

`workspace-write` 调用必须由 Tifereth 提供稳定且唯一的 `requestId`。持久请求账本在任务进入执行队列前以 `requestId` 原子占位，并保存不含原始请求内容的 SHA-256 摘要。相同 ID 与相同请求在完成后直接重放缓存结果，不再调用模型；相同 ID 搭配不同请求会被拒绝。如果进程中断后只留下开始记录，网关返回 `idempotency_in_doubt` 并禁止自动重跑，等待 Tifereth 核对原任务结果。为了在 Tunnel 超时后恢复响应，账本会在本机受限状态目录中缓存工具结果，并在持久化前清除 Bearer、API key、密码、JWT、私钥和 URL 凭据；它与不保存任务或补丁原文的审计日志用途不同。

`provider-circuit-state` 只把探针和实际调用产生的基础设施结果追加到独立 JSONL 状态缓存，并向 Tifereth 暴露每条 provider/model 路由的 `closed / open / half-open` 状态。它不创建 Agent、不决定何时探测、不选择备用模型、不改写信封，也不自动重试或后台运行心跳。认证失败立即进入无定时过期的 `open`，修复登录后需要 Tifereth 显式提交 `recovery: true` 的恢复探针；429 按 provider 的 retry-after 冷却；网络、超时、路由不匹配或 provider 故障连续三次后冷却 5 分钟。冷却结束进入 `half-open`，组件只发放一个两分钟恢复探针租约。模型拒答、回答不合格、参数错误、写入越界及工具/LSP 失败不计为 provider 基础设施故障。

可选受控 API 路由 `yhwh-worker-api` / `yhwh-reviewer-api` 支持 OpenCode Go、CommandCode、OpenRouter 与自定义 HTTPS 平台。固定宿主配置与独立密钥存储、启动摘要校验、max 与角色权限限制均生效；默认路由不变，不自动回退。详见[平台配置](../../docs/provider-configuration.md)。真实平台调用未验证。

API key 自 0.8 起以 Windows DPAPI CurrentUser 密文保存，Windows 解密后经私有管道 / FD3 传递，不生成 API 明文临时文件。旧明文格式必须在代码升级后使用 `Migrate-API-Keys.cmd` 或 `install/Migrate-ApiCredentials.ps1` 迁移；不接受明文回退。

## 运行边界

- 只监听 loopback；`/mcp` 强制 Bearer token，默认请求上限 100 KiB。
- 最大进程数仍为 4，但准入按 6 GiB/2 CPU 的共享资源池计算：最多四个 `small`、两个 `standard` 或一个 `large`；同时要求主机在启动新任务后仍保留至少 `max(2 GiB, 宿主总内存的 10%)` 的内存预留。默认队列 16，排队期限与执行期限独立，取消会终止 Pi 进程树。
- Provider 并发池为 `openai-codex=2`、`anthropic=1`（调度器保留的其他 Provider 容量项不代表路由已获准）。队列按 `priority`（0..9）、等待老化和 FIFO 排序，并跳过依赖未满足、资源不足或写锁冲突的条目，继续运行其他可执行任务。
- 每个任务必须选择 Pi 内硬编码的 `small`、`standard` 或 `large` 资源档位，默认 `standard`。调用方只能用 `timeoutSeconds` 缩短档位时限，不能提交任意内存、CPU、进程数或输出上限。
- `cwd` 必须位于配置的真实路径根目录内；LSP 文件还必须位于所选 `cwd` 内。
- 网关凭据不会传入 Pi 子进程；递归 Pi 分发会被拒绝。
- `dispatch.mjs run/task` 也要求同一 WSL2 资源沙箱，不能退回不受内存、CPU 和进程数约束的宿主机执行。
- `PI_DISPATCH_SANDBOX=wsl2-bwrap` 启用 Ubuntu 24.04 WSL2 + Bubblewrap。WSL 禁用 Windows 盘自动挂载和 Windows 互操作；每个任务只把工作区复制到 Linux 内部临时目录，再卸载宿主盘后启动 Pi。
- `none` 不复制工作区；`read` 使用只读快照；`workspace-write` 只修改沙箱副本，并把不超过 4 MiB 的统一补丁返回 Tifereth 审阅，不直接写回宿主工作区。
- `workspace-write` 强制加载写入范围扩展。普通条目只授权一个精确文件，目录树必须显式写成 `path/**`；绝对路径、路径穿越、前缀混淆、版本库元数据、符号链接或硬链接逃逸、shell 写入、越界工具调用与越界/异常补丁都会失败关闭。
- 不同 `requestId` 的写任务还会取得跨 HTTP/stdio 进程共享的范围锁。相同文件、父目录树与子路径重叠时只允许一个任务执行；不相交范围仍可并行。锁在任务结束时释放，进程退出或最长运行时间过后可回收。
- 写入工具仅允许 `write`、`edit` 和受范围约束的 `code_rewrite`。补丁在返回 Tifereth 前会再次按原始 `writeScope` 验证；二进制或无法可靠解析的补丁会被拒绝。
- 长期刷新凭据留在宿主。沙箱只接收单一路由的临时访问令牌；临时凭据和任务资源按执行路径清理，结果需检查 `cleanup.ok`，不能把清理失败视为成功。
- 沙箱保留网络访问以调用模型 API，但看不到 Windows 宿主盘，也不能启动 Windows 程序。能力探针会实际创建 cgroup 并验证进程加入；内核资源隔离不可用时，所有 Pi 子 Agent、LSP 和探针任务都会在模型启动前失败关闭。

资源档位由 [`extensions/resource-limits.js`](./extensions/resource-limits.js) 定义，并在 WSL 启动器中以相同常量再次校验：

| 档位 | 内存 | CPU | 进程数 | 合计输出 | 最长运行 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `small` | 1 GiB | 0.5 核 | 64 | 1 MiB | 120 秒 |
| `standard` | 3 GiB | 1 核 | 128 | 4 MiB | 300 秒 |
| `large` | 6 GiB | 2 核 | 256 | 8 MiB | 900 秒 |

内存、CPU 和进程数由 WSL cgroup v2 落实，swap 对任务关闭；输出由 Windows 侧网关按 stdout/stderr 合计字节数截断并终止进程树；最长运行时间由网关截止时间、Windows 子进程计时器和 Linux `timeout` 三层约束。

## Tifereth 调用约定

Tifereth 是唯一的任务分解和派发决策层。每次 `dispatch_subagent` 提交一个完整 Kether `task`，并可附带 `requestId`、`parentRunId`、`priority` 与 `dependsOnRequestIds`。依赖项引用前置任务的 `requestId`；前置任务必须成功完成，后继任务才会进入执行。Pi 不创建依赖图、不递归创建 Agent，也不自行改写 provider/model；它只强制执行 Tifereth 提交的图、优先级和资源约束。

独立只读任务示例（不宣称完成整条阶段链；链接任务的真实前驱交接格式见 [ROLE-CONTRACTS-V2.md](ROLE-CONTRACTS-V2.md)）：

```json
{
  "requestId": "req-42",
  "parentRunId": "tifereth-run-7",
  "priority": 5,
  "cwd": "D:\\Projects\\Example",
  "provider": "openai-codex",
  "model": "gpt-5.6-luna",
  "thinking": "max",
  "access": "read",
  "resourceProfile": "standard",
  "timeoutSeconds": 180,
  "task": {
    "role": "Malkuth",
    "objective": "检查模型网关实现。",
    "readScope": ["payload/pi-dispatch"],
    "forbidden": ["不得修改文件", "不得再次分发 Agent"],
    "acceptance": ["返回文件证据、实际 provider/model 与不确定项"]
  }
}
```

## 启动与检查

`PI_GATEWAY_CONFIG` 指向配置 JSON；配置内 `tokenFile` 指向只含 Bearer token 的文件，`auditFile` 指向只追加的审计日志，`providerCircuitFile` 指向 Provider 熔断状态缓存，`requestLedgerDir` 指向写任务的持久幂等账本。随后运行 `npm run gateway`。健康检查为 `GET /healthz`，就绪检查为 `GET /readyz`，具体能力通过 `list_capabilities` 查询。stdio tunnel 入口通过 `PI_GATEWAY_AUDIT_FILE`、`PI_GATEWAY_PROVIDER_CIRCUIT_FILE` 和 `PI_GATEWAY_REQUEST_LEDGER_DIR` 指向同一组持久状态。示例配置见 `gateway.example.json`。

本地调试客户端支持 `gateway-client.mjs dispatch <request.json>`，可直接经过 MCP 网关验证完整信封、资源档位与结果格式。

插件同时注册一个同策略的 stdio MCP 入口，使新的本地 Codex 任务可直接发现当前网关工具；它也只授权当前工作区。ChatGPT Work 不能直接访问 localhost，需要使用 OpenAI Secure MCP Tunnel 把 HTTP 端点安全发布给工作区。

## 验证

`npm test` 覆盖信封、精确路由、结果格式、凭据剥离、进程生命周期、鉴权前置、普通与 chunked 请求上限、工具表面、路径边界、沙箱能力门禁、失败关闭、并发硬上限、排队取消和超时。真实 provider 心跳、沙箱写入补丁与 LSP 验证会消耗对应账户额度，应在配置完成后单独运行。


独立排队期限、等待原因与强制审查材料包见 [REVIEW-AND-TIMEOUTS.md](REVIEW-AND-TIMEOUTS.md)。旧 reviewer 请求必须迁移到 task.reviewPacket；结构有效不代表证据真实。

## 确定性 LSP 直连

`lsp_request` 已改为无模型执行，不需要登录模型服务或携带 provider/model。保留只读单文件快照、WSL 隔离、资源限制、审计与清理。位置使用 1 起始的 line/character；query 是符号名，search 使用结构化模式并提供 language。返回原始工具结果与 backend，详见 [Pi LSP](skills/pi-lsp/SKILL.md)。


当前模型任务协议为 v2：角色专属 deliverable、严格字段类型、失败状态拦截和账本支持的阶段交接。详见 [ROLE-CONTRACTS-V2.md](ROLE-CONTRACTS-V2.md)。旧的精简 returnFields 将被拒绝；独立任务不代表完成整条治理链。

## 许可证

YHWH 自有代码、文档与配置采用 [Apache-2.0](LICENSE)，版权说明见 [NOTICE](NOTICE)。第三方组件保留原许可证。[第三方通知](THIRD_PARTY_NOTICES.txt)。

自 0.6.0 起，reviewer 使用用户自备 API key，通过 Pi 原生 Anthropic API 调用；已移除订阅令牌读取、续期和 Claude Code 桥接。服务条款仍适用，实际 API 访问尚未验证。
