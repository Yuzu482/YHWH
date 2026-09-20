# YHWH

[![简体中文](.readme-assets/zh.svg)](README.md) [![English](.readme-assets/en.svg)](README.en.md)

**主代理只负责思考与调度：** Astra（或宿主选择的主模型）负责方案、调度、补丁整合与验收；代码、测试和实现修复由 Pi 子代理编写，默认 Luna/max。子代理失败不自动回退为主代理编码。该策略是宿主指令约束，不能禁用所有客户端的编辑工具；详见[职责与失败处理](docs/coordinator-only.md)。

**子代理监管心跳：** 本地计时器提供不调用模型的心跳，并单独记录最近执行进度；静默不触发自动重试。它不证明远端模型健康，也不自动唤醒主代理；详见[心跳说明与部署边界](docs/subagent-heartbeat.md)。

连续调用改进：`HeadlessBatchEvents` 实时显示各项阶段、等待状态和结果；会话缓存减少重复文件读取与哈希，保留每次版本检查。整批执行前校验，同会话串行调用，失败即停止；报告缓存命中及分段耗时。详见[操作与验收边界](docs/workflow-operations.md#简体中文)。

**开发中优化：** CLI 实机回显验收、连续批次与耗时证据、可选 Windows Job Object 清理、受管插件升级/回滚、Git 变更影响候选及 Windows CI。Antigravity 路径留空、默认禁用。源码能力与已部署/已发布状态分别记录，见[操作与验收指南](docs/workflow-operations.md#简体中文)。

新增可选特性：Codex、Claude Code、Antigravity 官方 CLI 无头主代理入口，包含版本锁定、统一结果、运行预算和发布/本地文件比对。现有 Pi 路由保持不变，默认不启用客户端。见 [使用说明](docs/headless-cli.md#简体中文)。

Kether 治理规则与 Pi 执行工作流的私有源码仓库。主代理负责意图、授权、任务拆分、整合和验收；Pi 提供受控的模型调用、确定性 LSP、资源限制、结果验证和运行监控。

**v0.11.0：** 新增持久化代码关系记忆与三个官方 CLI 无头主代理入口，保留项目长期知识和多语言确定性探针。提供版本与安装副本一致性检查；本地服务需要显式升级。能力、许可和未验证范围见 [双语发布说明](docs/release-notes-0.11.0.md)。

开发背景、架构演进、关键决策及历史验证边界见 [架构开发历史](docs/architecture-history.md)；对应的脱敏记录见 [历史证据索引](docs/history-evidence.json)。

本仓库的 README 统一采用中英文双版本，并在顶部提供语言切换按钮；新增或修改时同步维护两版。维护约定见 [AGENTS.md](https://github.com/Yuzu482/YHWH/blob/main/AGENTS.md)（仓库文件，不随安装包分发）。

**0.7 受控 API 配置：** 支持 OpenCode Go、CommandCode、OpenRouter 和自定义 HTTPS 平台。宿主显式配置后选择可选 API 路由，保留 Luna/Sonnet 5 与 max 绑定、审查者无工具、无自动降级。新增 `Configure-Providers.cmd`；见[平台配置指南](docs/provider-configuration.md)。真实账号与付费心跳尚未验证。

**0.8 API key 加密：** Anthropic 和聚合平台密钥使用 Windows DPAPI 用户级加密；运行时经私有管道传递，不生成 API 明文凭据文件。升级后运行 `Migrate-API-Keys.cmd` 迁移旧格式。见[配置与迁移指南](docs/provider-configuration.md)。

**0.10 项目长期知识：** `.yhwh/memory/` 保存有来源的 Markdown 知识，支持草稿、确认和废弃状态。只读 `project_memory` 工具提供中英文检索、源文件变化检测，以及已暂存、未暂存和未跟踪条目的 Git 差异检查。更新由主代理已有文件权限完成，不自动提交；需要运行机器安装 Git，已有服务需升级才可发现新工具。见[使用与管理指南](docs/project-memory.md#简体中文)。

## 仓库结构

**0.11 代码关系持续记忆。** 新增 `.yhwh/code-graph/index.json`，首批支持 JS/TS（含 JSX/TSX）与 Python 的文件、类、函数及语法关系。只读 `code_graph` 可检索关系和反查相对导入的影响范围；宿主 CLI 按文件散列增量刷新，支持显式限时监听。未解析调用、语法错误和过期状态会明确报告，不代表完整语义调用图。见[使用、Git 管理与限制](docs/code-graph.md#简体中文)。维护者本机 Pi 已更新并通过实际 MCP 与增量刷新验证；已随 v0.11.0 发布。

**0.5 多宿主接入：**共 18 个宿主 ID，新增 Cursor、VS Code/Copilot、Windsurf Cascade、Cline、Roo Code、Gemini CLI、Kiro、Zed、Continue 和 LM Studio，保留已有 Codex、Cherry Studio、OpenCode、DeepSeek Harness、Claude 与通用配置。主模型在宿主中选择。见[常见客户端指南](docs/common-clients.md)与[多宿主指南](docs/host-integration.md)；配置和协议测试不等于客户端界面与完整治理链已验证。

- `payload/pi-dispatch/`：网关源码、插件、编辑器桥接、测试和模块生命周期实现。
- `payload/workflow-skills/`：Kether 角色技能及主代理路由技能。
- `templates/AGENTS.kether.md`：精简的全局规则入口。
- `templates/agent-references/`：按需加载的治理、路由、契约、认证和证据规则。
- `install/`：安装、校验、宿主认证配置与 WSL 沙箱部署工具。

当前规则固定 worker 使用 Luna/max、reviewer 使用 Sonnet/max；实际可用性仍由目标账号、模型服务及网关能力检查决定。生命周期管理支持按依赖启动、失败回收和逆序释放；dispatch/LSP 适配器仅能由可信宿主在空闲时替换。接口见 [模块生命周期](payload/pi-dispatch/MODULE-LIFECYCLE.md)。

仓库不包含凭据、个人运行配置、请求账本、审计日志、缓存、依赖目录或机器备份。图片流程引用的 `image-prompt-review` 插件需单独安装，本仓库仅保留其规则引用。

## Pi Kether Portable

这是一个面向 Windows 11 + WSL2 的安装包，把宿主无关的 Kether/Tifereth 规则和 Pi 执行环境安装到另一台主机，并为所选主代理工具生成接入配置。

安装后得到：

- 通用 Node stdio MCP 入口，以及供 Secure MCP Tunnel 使用的认证 HTTP 入口；Codex 插件可选；
- 通过 `get_workflow` 按需读取的主代理规则、角色技能和 references；选择 Codex 时另外安装全局规则与技能；
- 普通低级 Agent 使用 `openai-codex`；Geburah/reviewer 专用 `anthropic` / `claude-sonnet-5`，仅允许无工具、无文件访问审查；
- 带 CPU、内存、进程数、输出量、运行时间和写入范围限制的 WSL2/Bubblewrap 沙箱；
- 请求账本、幂等处理、Provider 熔断、审计清洗、结果格式验证、任务队列和监控卡片；
- Python、Java、JavaScript、TypeScript、C#、C/C++、Go、Rust 的 LSP 服务。
- 自有 [Pi LSP 适配插件](docs/pi-lsp-adapter.md)：受管工作代理通过七个 `yhwh_lsp_*` 工具调用隔离的 multilspy 探针；同一任务内复用未变化文件的服务器，Python 按需保留 Pyright 和 Jedi 两个后端，加速交替查询，空闲或任务结束后回收；C/C++ 和 C# 使用实际退出检查减少清理等待；C# 采用固定单文件 .NET 项目及只读私有进程视图，服务器异常退出时立即报错；Java 采用短任务 JIT 策略、单服务器复用和独立临时索引；旧扩展暂作兼容保留。

## 安装

### 一键安装（Windows 11 x64）

构建后的 `YHWH-OneClick-0.11.0.zip` 包含自包含脚本、校验文件和双击入口。解压后双击 `Install-YHWH.cmd`，按提示选择允许代理访问的工作目录；直接回车会创建 `~/YHWH-Workspace`。也可以只复制单个脚本到目标电脑运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-YHWH-0.11.0.ps1
```

默认导出通用 MCP 接入配置，不修改 Codex 全局设置。用 `-Hosts "cherry-studio,opencode,deepseek-harness,claude-code"` 选择宿主；包含 `codex` 时才执行原有 Codex 集成。接入文件还需按宿主提示导入，并加载主代理规则；已有配置不会被导出器覆盖。

安装器在 `%LOCALAPPDATA%\YHWH` 准备固定版本的 PowerShell 7 和 Node，无需预装它们或 Git，也不要求登录 GitHub。工作流源码已嵌入脚本；运行环境和依赖仍需联网下载。Windows 端运行包和 Ubuntu 镜像使用构建时记录的 SHA256 校验，下载内容变化会停止安装，不会自动接受新校验值。

它会导入专用 `YHWH` WSL2 Ubuntu 24.04 环境，安装 Windows 插件、治理规则和 WSL 沙箱/LSP，再运行安装检查。首次启用 WSL 可能出现 Windows 管理员授权，并需要重启后重新运行脚本；脚本以 `3010` 表示这一步尚待重启，不会声称安装完成。需要启用硬件虚拟化，且组织策略允许 WSL。WSL 安装方式依据 [Microsoft 官方说明](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)。

完成后打开 `%LOCALAPPDATA%\YHWH\Open-Pi.cmd`，通过 `/login` 登录下级 worker 所用的 OpenAI 账号；审核代理使用同目录 `Configure-Claude-API.cmd` 配置用户自备 Anthropic API key，按 API 用量单独计费。再按输出目录中的配置接入所选宿主，加载 `PRIMARY-AGENT.md`。选择 Codex 时重启 Codex 并按需启用插件。主模型账号由宿主管理；下级模型登录有效性、真实心跳和 ChatGPT Tunnel 连通性需另外验证。安装器不安装宿主应用、不创建 Tunnel、不迁移凭据；现有受管文件按原安装器规则备份。

已有 Pi 安装默认会被保护。确认任务结束并停止运行时后，显式添加 `-UpgradeExisting` 才允许覆盖并备份；正在运行的 Pi、没有本安装器所有权记录的 `YHWH` WSL 环境都会导致安装停止。不会自动停止进程、删除 WSL 环境或接管其他 Ubuntu 环境。安装不是事务式回滚；失败时保留已完成步骤和备份供诊断，修复原因后可重试。半完成的 WSL 导入或所有权记录异常需要人工检查。

```powershell
# 只读预览，不下载、不改宿主
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-YHWH-0.11.0.ps1 -PlanOnly
# 固定目录，免交互安装（WSL 必须已经就绪；账号登录另行完成）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-YHWH-0.11.0.ps1 -NonInteractive -WorkspaceRoots D:\Projects\MyProject
# 仅校验并解包，目标必须是尚不存在的绝对路径
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-YHWH-0.11.0.ps1 -ExtractOnly -Destination D:\YHWH-Inspect
```

维护者运行 `pwsh -NoProfile -File .\Build-Release.ps1`，会在 `release/` 同时生成便携 ZIP、自包含 PS1、SHA256 和双击安装包。仓库中的 `Install-YHWH.ps1` 也能直接从完整源码目录运行；带版本号的生成脚本才是可单独复制的版本。`-SkipTests` 仅跳过网关测试，不会让本机 `node_modules` 进入发布包。安全解包测试：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install\Test-OneClick.ps1 -Installer .\release\Install-YHWH-0.11.0.ps1`。

本版本已做脚本和包级验证，尚未在全新 Windows 虚拟机完成联网全量安装。Windows 与 WSL 的 Pi 使用同一依赖锁文件，但 Ubuntu 软件源、WSL 系统组件和 .NET 安装脚本仍是外部可变依赖；这不是完全离线或逐字节可复现的系统镜像。

### 高级配置安装

统一入口为 `Workflow.ps1`，配置只维护在 `install.config.json`。默认执行只读预检：

```powershell
pwsh -NoProfile -File .\Workflow.ps1 -Action Init
# 编辑 install.config.json，填写实际工作目录和需要的 Tunnel 配置。
pwsh -NoProfile -File .\Workflow.ps1 -Action Plan
pwsh -NoProfile -File .\Workflow.ps1 -Action Install
pwsh -NoProfile -File .\Workflow.ps1 -Action Verify
pwsh -NoProfile -File .\Workflow.ps1 -Action Build
```

`Init` 不覆盖已有配置；`Plan` 校验配置且不安装；`Install` 执行完整安装并备份已有文件；`Verify` 检查已安装环境；`Build` 运行验证并生成带版本号的 ZIP。安装会更新依赖并可能重启专用 WSL，已有活动任务时请先等待任务结束。这不是热更新脚本。发布文件使用白名单打包，本地配置、临时测试目录和运行凭据不进入 ZIP。

统一入口不会修改 Codex 内置插件缓存。此前针对本机应用工具 `cmd.exe` 启动器的修复属于特定 Codex 版本的本机补丁，不作为通用安装步骤。ChatGPT Work 连接仍取决于账号、工作区权限和 Tunnel 配置，安装本地规则不代表已在所有产品会话中生效。

1. 准备 PowerShell 7、Windows Node.js 22+、WSL2 与一个**专用于 Pi 沙箱**的 Ubuntu 24.04 发行版。安装器会关闭该发行版的 Windows 盘自动挂载和 Windows 互操作。
2. 将 `install.config.example.json` 复制为 `install.config.json`，把 `workspaceRoots` 改成目标机允许读取或产生沙箱补丁的目录。
3. 在普通用户终端运行：

   ```powershell
   .\Install.cmd -ConfigFile .\install.config.json
   ```

4. 如果目标账户尚未登录 Pi/OpenAI，安装后运行 Pi 的登录流程。凭据只保存在目标机的 `~/.pi/agent/auth.json`，安装包不读取或携带凭据。
5. 在所选宿主中导入连接配置并加载主代理规则；使用 Codex/ChatGPT Work 时按需重启或重新连接。

先检查而不修改主机：

```powershell
.\Install.cmd -ConfigFile .\install.config.json -PlanOnly
```

只安装 Windows 侧插件与工作流，不配置 WSL：

```powershell
.\Install.cmd -ConfigFile .\install.config.json -SkipWsl
```

## Secure MCP Tunnel

安装器不会创建 OpenAI Tunnel，也不会把 Runtime API Key 写入包内。已有 Tunnel 时，在配置文件中设置：

```json
{
  "installTunnel": true,
  "tunnelId": "目标 Tunnel ID",
  "tunnelRuntimeKeyFile": "C:\\安全目录\\runtime-key.txt",
  "tunnelClientPath": "C:\\路径\\tunnel-client.exe"
}
```

安装器会生成只引用密钥文件的启动脚本，创建登录时计划任务，并以无窗口进程启动 Runtime。Tunnel 使用本机 `127.0.0.1:17331/mcp` HTTP 入口，避免 stdio 模式经由 `cmd.exe` 拉起网关。该入口要求随机 Bearer 凭据；凭据文件只授予当前 Windows 用户访问。目标主机仍需具备该 Tunnel 的有效 Runtime 凭据。升级已有 stdio Runtime 时，先停止一次 `pi-kether` Runtime，再运行新的启动脚本；脚本不会在健康检查时自动中断旧任务。

## 验证与卸载

源码回归在 `payload/pi-dispatch` 下分别运行 `npm test` 和 `npm run test:memory`。后者验证完整 256 KiB 结果、取消、断连和内存增长，不包含在普通测试计数中；`Build-Release.ps1` 默认要求两者通过。`-SkipTests` 仅用于已有同一源码验证记录的本地打包，不代表测试通过。构建包与正在运行的服务是独立快照，局部部署不等于完成整包升级。

登录启动任务使用 `wscript.exe` 的无控制台启动器，在创建 PowerShell 进程时隐藏窗口，避免只传 `-WindowStyle Hidden` 仍可能出现的启动闪窗。Windows Script Host 必须可用。网关、WSL 子进程及 LSP 继续使用隐藏窗口的进程选项。

```powershell
pwsh .\install\Test-PiKether.ps1 -Installed
pwsh .\install\Uninstall-PiKether.ps1
```

卸载会归档插件与工作流文件，并保留 WSL 发行版和 `/opt/pi-kether`。这避免删除发行版内可能存在的其它数据。

## 可复现边界

安全加固：普通执行默认使用 `openai-codex`；可选受控 API 路由必须由宿主显式配置并选择。Geburah/reviewer 可使用 Claude Sonnet 5，但必须为 `access:none`，由主 Agent 提供审查材料；Claude reviewer 需配置用户自备 API key，凭据不包含在安装包中；模型执行任务使用空 `/proc`，无凭据的 C# 和 Go 探针使用独立 PID 命名空间中的只读 `/proc`。任务快照只包含 `readScope` 与 `writeScope` 的并集，范围使用相对文件路径或目录 `/**`；`.env`、凭据、私钥、项目 Pi 配置等默认拒绝进入快照。快照上限为 128 MiB、10,000 个文件，准备扫描限时 30 秒；每个任务临时文件系统上限为 512 MiB、30,000 个 inode。实际文件树与补丁均检查写入范围，二进制补丁会拒绝返回。

LSP 禁止加载项目 `.pi-lsp.json` 和自动发现 Lombok Java agent。工具无法读取凭据文件；单一路由凭据通过一次性文件描述符进入可信 Pi 进程内存，随后关闭描述符。安装器收紧 Windows 凭据与状态目录的权限。OpenAI OAuth 登录刷新由宿主执行并持久化，沙箱只接收临时访问令牌；reviewer 的 API key 仅经 FD3 进入可信 Pi 内存。沙箱保留网络供模型及语言服务使用，尚未实施出站域名白名单；可信 Pi/LSP 依赖或操作系统自身遭入侵不在这些范围检查的保证之内。

依赖版本记录在 `portable.manifest.json`。Node 和 JDT LS 下载会校验上游散列；Pi 的 npm 依赖树由随包 lockfile 固定。安装时仍需要联网访问 Ubuntu、Node.js、npm、Eclipse 和 Microsoft 的官方下载源。模型登录、OpenAI Tunnel、ChatGPT 工作区管理员授权以及目标机策略无法由离线包代替。

受管文件的备份保存到 `~/.local/state/pi-kether/installer-backups/`。选择 Codex 时，安装器管理带 `PI-KETHER` 标记的 `AGENTS.md` 区块，并关闭 Codex 内置多 Agent 路由。其他宿主导出配置和主代理规则，由用户按接入指南合并。

## 许可证

YHWH 自有代码、文档与配置采用 [Apache-2.0](LICENSE)，版权说明见 [NOTICE](NOTICE)。第三方组件保留原许可证。[第三方清单](THIRD_PARTY.md)与 [Claude Code 可行性](docs/claude-code-feasibility.md)。

自 0.6.0 起，reviewer 使用用户自备 API key，通过 Pi 原生 Anthropic API 调用；已移除订阅令牌读取、续期和 Claude Code 桥接。服务条款仍适用，实际 API 访问尚未验证。

## Claude reviewer API 配置（0.6）

安装后运行 `Configure-Claude-API.cmd`，或在源码目录运行 `powershell.exe -NoProfile -File .\install\Set-ClaudeApiKey.ps1 -TargetHome $HOME`。输入为隐藏输入，文件仅允许当前 Windows 用户访问；凭据保存在 `~/.local/state/pi-kether/anthropic-api-key.json`。不读取 Claude 订阅登录，不接受环境变量或自定义 API 地址作为回退。`check_claude_auth` 仅检查本地配置，实际密钥有效性、余额与模型可用性需另行授权心跳验证。Claude Code 主客户端仍由用户在官方客户端自行登录。

旧版用户应等待任务结束后升级并重新配置 API key；旧 `pi-claude-code-provider` 路由和 `renew_claude_auth` 工具不再接受。本轮未更新当前运行服务。公开发布检查使用 `Build-Release.ps1 -PublicRelease`，目前会因 LSP 上游版权通知待确认而拒绝；普通构建仅生成本地预览。

### Go 与 Rust 单文件适配

Go 自动使用固定的 Go 1.27.1 / gopls 0.23.0；Rust 自动使用 Rust 1.98.1 / rust-analyzer 1.98.1。两者提供诊断、悬停、定义、引用、符号、补全和代码操作预览，沿用任务内服务器复用、文件修改失效和最终清理。无需模型或 API key。

Go 使用已完成的 `textDocument/diagnostic` 拉取结果，并要求独立的诊断发布证据；固定版本 gopls 的完整结果可能含空 `kind`，只兼容其带 `items` 的已完成响应，不接受 `unchanged`。Go 关闭模块下载、工具链自动下载、工作区配置、cgo、外部包驱动和遥测，使用只读私有 PID 视图供 gopls 读取自身可执行文件。项目外部依赖和多文件模块不在该快照范围内。

Rust 使用固定的 2024 edition 单文件 library crate 与标准库，不读取 Cargo 项目；关闭构建脚本、过程宏、Cargo 检查和实验性分析器诊断。诊断及代码操作请求额外执行有界的 `rustc --emit=metadata` 检查，等待编译器结束并确认回收，再结合语言服务器的发布证据返回。每次诊断重新检查；首次空通知不能直接证明无错误。仅生成临时元数据，不链接或运行用户程序，不代表完整 Cargo 工作区构建通过。诊断坐标按 UTF-8 字节偏移转换为 LSP UTF-16。

探针运行时无网络、无凭据，源文件只读；Rust 继续使用空 `/proc`。初次安装会下载带固定 SHA-256 的官方 Go/Rust 归档，并从官方模块代理校验构建 gopls。新工具链仅安装到受管运行时，不替换宿主 PATH、rustup 或 Go 配置。依赖与通知清单见 [Go/Rust 材料](./licenses/go-rust-runtime.json)。普通 `install/Test-PiLspAdapter.py` 测试包含两种语言的真实七工具调用、错误修正、复用、清理及 Rust 所有权错误；耗时为本机小样本，不是大型项目性能保证。
