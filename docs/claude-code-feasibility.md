# Claude Code 接入与 Anthropic API reviewer

[English](claude-code-feasibility.en.md) · 更新：2026-09-19 · 版本：0.6.0

## 当前实现

Claude Code 可以继续作为主客户端，通过 MCP 与 `CLAUDE.md` 接入；用户在官方客户端自行登录。下层 reviewer 已改为 Pi 原生 `anthropic / claude-sonnet-5 / max`，使用用户自己的 Anthropic API key，按 API 用量单独计费。

发布源码不再读取、续期或转发 Claude.ai 订阅凭据，不再调用 Claude Code 二进制，也不再下载 Claude Code / pi-claude-code-provider。旧路由和 `renew_claude_auth` 工具被拒绝；新工具是 `check_claude_auth`。这些是仓库与预览包的变化，尚未部署到本机运行服务。

## 凭据和权限

运行 `Configure-Claude-API.cmd` 或 `install/Set-ClaudeApiKey.ps1 -TargetHome <用户目录>`，隐藏输入 API key。配置保存在 `~/.local/state/pi-kether/anthropic-api-key.json`，仅当前 Windows 用户可访问。配置文件不放入项目、Git、安装包或任务材料中。

`claude-api-auth.mjs` 只校验专用文件的格式，不请求网络；`anthropic-api-credential.mjs` 拒绝订阅 token、命令型密钥与错误路由。WSL 根启动器从只读挂载读取选定凭据，经 FD3 交给可信 Pi 内存存储，随后关闭描述符。密钥不进入 CLI 参数、环境变量或持久化沙箱文件。认证失败不会自动改用环境变量、订阅登录、其他端点或模型。

reviewer 保持 `access:none`，没有文件范围、shell 或工具；调度、超时、取消、清理、角色及结果契约继续生效。移除 Bun 后，reviewer 也使用空 `/proc`。`check_claude_auth` 成功只代表本地配置格式正确，不证明余额、权限或真实模型可用性。修复认证后需由主代理明确授权恢复心跳，成功后才恢复任务。

## 依据与验证边界

这是根据官方对第三方产品使用 API key/支持云凭据的指导所作的迁移；Claude Code 主客户端的官方登录与下层 API 认证独立。[Anthropic 条款](https://code.claude.com/docs/en/legal-and-compliance)

Sonnet 5 支持 max effort；固定的 Pi 0.84.4 模型目录含该模型及 max 映射。[官方 effort 文档](https://platform.claude.com/docs/en/build-with-claude/effort)

本轮使用假密钥做离线回归、配置 ACL 与打包验证；实际结果见 [VERIFICATION.md](../VERIFICATION.md)。未读取用户真实密钥、未进行付费 API 调用，未证明真实账户访问、Claude Code UI 接入或干净机器完整安装成功。服务条款继续适用，本实现不代表 Anthropic 背书。

旧 0.5.1 评估中识别的订阅中介路径已从发布实现移除；LSP 上游版权通知的独立问题仍受公开发布检查约束，见 [第三方说明](../THIRD_PARTY.md)。
