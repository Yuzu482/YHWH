# Pi 便携网关安装与维护

[English](pi-portable-installation.en.md)

## 安装与预览

准备 Windows 11 x64、Git、WSL2、硬件虚拟化和网络访问。安装器准备固定版本的 PowerShell、Node 和专用 YHWH Ubuntu 环境。选择现有用户有权访问的工作区。首次启用 WSL 可能需要管理员批准和重启。安装器返回 `3010` 时，重启后重新运行。

从[正式发布页](https://github.com/Yuzu482/YHWH/releases/latest)下载 `YHWH-OneClick-*.zip` 或同版本的单文件安装脚本。用发布页的 SHA-256 核对下载。解压 ZIP 后运行 `Install-YHWH.cmd`。以下以 0.15.3 为例，文件名应与所下载版本一致。

```powershell
Get-FileHash .\YHWH-OneClick-0.15.3.zip -Algorithm SHA256
powershell.exe -NoProfile -File .\Install-YHWH-0.15.3.ps1 -PlanOnly
powershell.exe -NoProfile -File .\Install-YHWH-0.15.3.ps1
```

| 需求 | 选项 |
| --- | --- |
| 指定工作目录并免交互安装 | `-NonInteractive -WorkspaceRoots D:\Projects\MyProject`。先准备好 WSL，按路线单独登录。 |
| 检查内嵌文件并解包 | `-ExtractOnly -Destination D:\YHWH-Inspect`。地址须为不存在的绝对路径。此步骤校验内嵌内容。 |
| 指定干净的本地 Git 源码 | `-SourceRepository D:\path\to\checkout`。安装器通过该工作区的 `origin` 核验已推送提交和主线来源。 |
| 选择接入宿主 | `-Hosts "codex,claude-code,opencode"`。默认导出通用 MCP，包含 `codex` 时启用安装器的 Codex 集成。 |

实际安装会验证源码、包内文件和固定下载摘要。与发布版本不一致的已有插件、依赖或治理文件可能使安装停止。先完成任务、确认相关运行时退出，再按已核实的范围使用 `-UpgradeExisting`。半完成的安装会保留诊断信息和备份，可按 [升级与变更指南](workflow-operations.md#简体中文)处理。

## 接入宿主与模型

在目标宿主导入生成的 MCP 配置并加载 `PRIMARY-AGENT.md`。0.15.3 的 Codex 集成会管理 `PI-KETHER` 区块，并在新建配置时写入 `[features].multi_agent = false`。如果已有配置将被改动，安装会停止。使用原生套件时，以当前宿主实际可用的子代理能力为准。[多宿主接入](host-integration.md) · [Codex 原生工作流](native-codex-workflow.md)

- Pi worker 可从 `%LOCALAPPDATA%\YHWH\Open-Pi.cmd` 启动 Pi 并用 `/login` 登录所选账号。
- 默认 Claude Code CLI 审查路线使用用户在官方 CLI 中的登录。CLI 路线的模型连通性由获授权的 `probe_model` 验证。
- 选用 Anthropic API 审查路线时，用 `Configure-Claude-API.cmd` 配置自备密钥。`check_claude_auth` 检查该 API 配置，实际模型访问由获授权的探针验证。路由选择及工具范围以网关当前能力为准。[服务配置](provider-configuration.md) · [Pi 角色](pi-role-presets.md)

## 从源码配置

从源码运行需要 PowerShell 7 和 Windows Node.js 22 或更新版本。使用 WSL 沙箱时，准备专用 Ubuntu 24.04 发行版并授权安装器对它进行硬化。在仓库根目录运行 `Init`，把 `install.config.json` 的 `workspaceRoots` 指向已有的授权目录，然后运行 `Plan`。安装、验证和构建各用相应操作。

```powershell
pwsh -NoProfile -File .\Workflow.ps1 -Action Init
pwsh -NoProfile -File .\Workflow.ps1 -Action Plan
pwsh -NoProfile -File .\Workflow.ps1 -Action Install
pwsh -NoProfile -File .\Workflow.ps1 -Action Verify
pwsh -NoProfile -File .\Workflow.ps1 -Action Build
```

也可直接使用 `.\Install.cmd -ConfigFile .\install.config.json`。该入口支持 `-PlanOnly` 只读预览及 `-SkipWsl` 跳过 WSL 配置。启用 Tunnel 时按下面的流程填写已有连接的参数。

## Secure MCP Tunnel

准备有效的 Tunnel 和受当前用户保护的运行时密钥文件。配置引用路径，密钥留在宿主。

```json
{
  "installTunnel": true,
  "tunnelId": "YOUR_TUNNEL_ID",
  "tunnelRuntimeKeyFile": "C:\\Path\\To\\runtime-key.txt",
  "tunnelClientPath": "C:\\Path\\To\\tunnel-client.exe"
}
```

Tunnel 接入本机带认证的 `127.0.0.1:17331/mcp`。宿主的远程会话还需要对应的工作区授权。替换旧传输前先确认现有任务和相关进程已结束。[远程连接说明](host-integration.md)

## 验证、构建与卸载

```powershell
pwsh .\install\Test-PiKether.ps1 -Installed
pwsh .\install\Uninstall-PiKether.ps1
```

已安装检查验证文件、组件及所选配置。模型路由、远程连接和用户环境分别验收。卸载会归档受管文件，保留 WSL 发行版及 `/opt/pi-kether`。

维护者在干净、已推送且属于 `origin/main` 的源码上运行 `pwsh -NoProfile -File .\Build-Release.ps1 -PublicRelease`。正式构建需要通过运行时和内存回归检查。可用 `install/Test-OneClick.ps1` 验证已构建脚本。固定依赖见[版本清单](../portable.manifest.json)。[验证记录](../VERIFICATION.md) · [安全边界](../SECURITY-HARDENING.md) · [LSP 组件](lsp-component.md)
