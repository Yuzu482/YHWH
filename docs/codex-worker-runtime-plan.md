# Codex CLI worker 接入方案（尚未实施）

## 当前核对结果

现有 `WorkerRuntime` 注册 Pi 与 Claude Code CLI。Pi 执行 WSL worker，Claude CLI 是 Windows 无工具审查器；沙箱运行时白名单仍只有 Pi。`runtime` 保留 `wsl2-bwrap / host-cli`，`workerRuntime` 用于智能体实现标识，不能覆盖旧字段。

2026-10-08 本机桌面随附 Codex 为 `0.162.0-alpha.2`。实际 `--help / exec --help` 支持 JSON 事件、输出 schema、临时会话、忽略用户配置、指定模型和沙箱模式。WSL Ubuntu-24.04 的 `which codex` 退出 1；没有找到 Linux Codex 可执行文件。本次只运行版本和帮助查询，没有模型派发、登录、复制凭据、安装或更换默认路由。

官方文档说明 `exec --json` 输出 JSONL，包含 thread/turn/item 事件；支持结构化结果与临时会话。[非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[CLI 参数](https://learn.chatgpt.com/docs/developer-commands?surface=cli)。帮助输出和文档不能证明 Linux 认证、工具约束或真实写入任务已经可用。

## 先完成可行性验证

后续接入整体按 T2，先独立预审。版本、分发来源、安装完整性、Linux 可执行文件和模型标识须固定；不能直接使用随桌面更新的 alpha 二进制作为生产 worker。模型与宿主路由需明确批准，不自动 fallback，不把现有 Pi `openai-codex` 请求悄悄改成 Codex CLI。

认证由宿主制定专门适配方案。确认订阅登录或 API 认证在既有隔离中可用，再实施；不得假定 Pi OAuth 格式可被 Codex 复用，不读取或复制桌面认证到 worker，也不把密钥放进参数、提示词、补丁或审计。本方案没有选择新的认证通道。

CLI 的 workspace-write 不能代替 YHWH 的逐文件允许范围。Pi 扩展提供的读写约束、结构化结果提交、编辑器代理和凭据脱敏不能原样移植；需要可信外部约束或已验证的等价钩子。尤其必须证明 scope 外读取被阻断，不能只在任务完成后拒绝越界补丁。`access:none` 不应通过“告诉模型不要调用工具”实现；无法证明无工具时不启用该能力。MCP、插件、hooks、用户配置、项目配置、网络和隐式会话恢复逐项证明关闭或受控；缺少参数不代表默认关闭。

## 建议的事件与结果适配

| Codex 事件 | 现有统一事件 / 判断 | 需要验证的边界 |
| --- | --- | --- |
| `turn.started` | `start` | `thread.started` 单独记元数据，不能重复算 start |
| `item.started` 的 command/tool | `tool_start`，以 item ID 关联 | 区分命令、MCP、文件变更；未知 item 不冒充成功 |
| `item.completed` 的 command/tool | `tool_end` | 真实执行状态、退出码、错误输出，缺退出码保留未知 |
| agent_message item | `message_end` | 完整正文与部分增量不可重复计数；不伪造 text/thinking delta |
| reasoning item | 有能力证明时映射 `thinking_delta` | 缺少可观测推理事件时指标不可用，不填 0 |
| `turn.completed` | 汇总 usage 后 `end` | 不是 `task_accepted`；未知模型身份和路由不得推断 |
| `turn.failed / error` | 明确失败，保留实际错误类型 | 不能补造成功 end 或提交结果 |
| output-schema 最终 JSON | 可信宿主验证后 `result_submission` | schema 通过不等于满足角色语义，要求唯一完整结果、无缺材料 |

上述映射是设计，尚无真实 Codex worker 事件样本。新增 normalizer 需覆盖分块、UTF-8、未知事件、错误恢复、重复/缺失结果、截断、超时与取消；旧 Pi 黄金样本全部保留。不能把 `turn.completed` 直接映射为最终必要接受完成。

## 有界试点和验收

试点先在隔离测试项目中进行，默认生产继续 Pi。沿用既有 CPU、内存、PID、输出、任务超时、断网/网络白名单、FD 与安全沙箱边界；取消时回收整个自有进程树和临时目录。补丁由同一可信 sandbox 差异收集器生成、规范化、哈希校验和范围检查，仍走 awaiting-host-verification → apply_artifact → record_host_verification → task_accepted。

通过合同与负例测试后，运行同一组 1 个 T0、1 个带测试的多文件 T1，再加 5–10 个混合任务；Pi 与候选运行时使用相同任务版本、环境和预算，轮换顺序并单列冷启动。统计实际模型调用/失败/修复次数、成功率、派发至最终接受耗时、执行/排队/回收耗时，token 仅在可信记录可得时比较。失败与超时不剔除；少量样本只作试点证据，不宣称因果提升。

在认证和逐文件访问控制没有证明前，不进入真实 worker 模型试验。是否新增运行时标识、如何选择它、是否更换默认值，是后续独立批准事项。本次没有改注册表、模型路由、沙箱白名单或生产配置。
