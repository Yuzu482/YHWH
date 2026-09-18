# YHWH

[![简体中文](.readme-assets/zh.svg)](README.md) [![English](.readme-assets/en.svg)](README.en.md)

Kether 治理规则与 Pi 执行工作流的私有源码仓库。主代理负责意图、授权、任务拆分、整合和验收；Pi 提供受控的模型调用、确定性 LSP、资源限制、结果验证和运行监控。

开发背景、架构演进、关键决策及历史验证边界见 [架构开发历史](docs/architecture-history.md)；对应的脱敏记录见 [历史证据索引](docs/history-evidence.json)。

本仓库的 README 统一采用中英文双版本，并在顶部提供语言切换按钮；新增或修改时同步维护两版。维护约定见 [AGENTS.md](https://github.com/Yuzu482/YHWH/blob/main/AGENTS.md)（仓库文件，不随安装包分发）。

## 仓库结构

- `payload/pi-dispatch/`：网关源码、插件、编辑器桥接、测试和模块生命周期实现。
- `payload/workflow-skills/`：Kether 角色技能及主代理路由技能。
- `templates/AGENTS.kether.md`：精简的全局规则入口。
- `templates/agent-references/`：按需加载的治理、路由、契约、认证和证据规则。
- `install/`：安装、校验、宿主认证配置与 WSL 沙箱部署工具。

当前规则固定 worker 使用 Luna/max、reviewer 使用 Sonnet/max；实际可用性仍由目标账号、模型服务及网关能力检查决定。生命周期管理支持按依赖启动、失败回收和逆序释放；dispatch/LSP 适配器仅能由可信宿主在空闲时替换。接口见 [模块生命周期](payload/pi-dispatch/MODULE-LIFECYCLE.md)。

仓库不包含凭据、个人运行配置、请求账本、审计日志、缓存、依赖目录或机器备份。图片流程引用的 `image-prompt-review` 插件需单独安装，本仓库仅保留其规则引用。

## Pi Kether Portable

这是一个面向 Windows 11 + WSL2 的可复现安装包，把当前 Kether/Tifereth 工作流、Codex/ChatGPT 插件和 Pi 执行环境安装到另一台主机。

安装后得到：

- `pi-dispatch` Codex 插件的直接 Node stdio 入口，以及供 Secure MCP Tunnel 使用的认证 HTTP 入口；
- Kether 的角色技能、路由技能，以及按需加载 references 的全局 `AGENTS.md` 规则；
- 普通低级 Agent 使用 `openai-codex`；Geburah/reviewer 专用 `pi-claude-code-provider` / `claude-sonnet-5`，仅允许无工具、无文件访问审查；
- 带 CPU、内存、进程数、输出量、运行时间和写入范围限制的 WSL2/Bubblewrap 沙箱；
- 请求账本、幂等处理、Provider 熔断、审计清洗、结果格式验证、任务队列和监控卡片；
- Python、Java、JavaScript、TypeScript、C#、C/C++ 的 LSP 服务。

## 安装

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
5. 重启 Codex/ChatGPT Work，使插件和全局工作流规则重新载入。

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

登录启动任务使用 `wscript.exe` 的无控制台启动器，在创建 PowerShell 进程时隐藏窗口，避免只传 `-WindowStyle Hidden` 仍可能出现的启动闪窗。Windows Script Host 必须可用。网关、WSL 子进程及 LSP 继续使用隐藏窗口的进程选项。

```powershell
pwsh .\install\Test-PiKether.ps1 -Installed
pwsh .\install\Uninstall-PiKether.ps1
```

卸载会归档插件与工作流文件，并保留 WSL 发行版和 `/opt/pi-kether`。这避免删除发行版内可能存在的其它数据。

## 可复现边界

安全加固：普通执行仅接受 `openai-codex`。Geburah/reviewer 可使用 Claude Sonnet 5，但必须为 `access:none`，由主 Agent 提供审查材料；Claude 需在宿主登录，凭据不包含在安装包中。Claude 的 Bun 运行时使用隔离 PID 命名空间内的私有 `/proc`；其它执行任务继续使用空 `/proc`。任务快照只包含 `readScope` 与 `writeScope` 的并集，范围使用相对文件路径或目录 `/**`；`.env`、凭据、私钥、项目 Pi 配置等默认拒绝进入快照。快照上限为 128 MiB、10,000 个文件，准备扫描限时 30 秒；每个任务临时文件系统上限为 512 MiB、30,000 个 inode。实际文件树与补丁均检查写入范围，二进制补丁会拒绝返回。

LSP 禁止加载项目 `.pi-lsp.json` 和自动发现 Lombok Java agent。工具无法读取凭据文件；单一路由凭据通过一次性文件描述符进入可信 Pi 进程内存，随后关闭描述符。安装器收紧 Windows 凭据与状态目录的权限。OAuth 登录刷新由宿主执行并持久化；沙箱只接收临时访问令牌。沙箱保留网络供模型及语言服务使用，尚未实施出站域名白名单；可信 Pi/LSP 依赖或操作系统自身遭入侵不在这些范围检查的保证之内。

依赖版本记录在 `portable.manifest.json`。Node 和 JDT LS 下载会校验上游散列；Pi 的 npm 依赖树由随包 lockfile 固定。安装时仍需要联网访问 Ubuntu、Node.js、npm、Eclipse 和 Microsoft 的官方下载源。模型登录、OpenAI Tunnel、ChatGPT 工作区管理员授权以及目标机策略无法由离线包代替。

所有原有配置在变更前保存到 `~/.local/state/pi-kether/installer-backups/`。安装器只管理带 `PI-KETHER` 标记的 `AGENTS.md` 区块，并把 Codex 内置多 Agent 路由设为关闭，确保低级 Agent 走 Pi。
