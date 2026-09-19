# 第三方组件与许可

[English](THIRD_PARTY.en.md)

YHWH 自有代码、文档和配置采用 [Apache-2.0](LICENSE)。第三方代码、引用片段、依赖及原始许可文本保留各自许可证，不受该声明重新授权。版权说明见 [NOTICE](NOTICE)。

| 组件 | 固定版本 | 许可与证据 |
| --- | --- | --- |
| Pi Coding Agent / Pi 同仓库组件 | 0.84.4 | MIT；[上游完整文本](licenses/pi-0.84.4-MIT.txt)，Copyright 2025 Mario Zechner |
| pi-claude-code-provider（历史组件，0.6 已移除） | 0.1.4 | MIT；[上游完整文本](licenses/pi-claude-code-provider-0.1.4-MIT.txt)，Copyright 2026 chem |
| pi-lsp-extension | 1.3.0 | 包声明 MIT；[原始元数据](licenses/pi-lsp-extension-1.3.0.package.json)；[缺失完整文本的记录](licenses/pi-lsp-extension-NOTICE.txt) |
| Claude Code（历史组件，0.6 不再下载） | 2.1.250 | [原始版权声明](licenses/claude-code-2.1.250-NOTICE.txt)；受 Anthropic 协议约束，不是 MIT/Apache-2.0 |

Pi 的 MIT 授权与 YHWH 对自有代码采用 Apache-2.0 可以共存；保留第三方版权及许可文本。桥接插件的 MIT 授权不授予 Claude 服务或订阅凭据的使用权限。

## 分发范围

源码包和安装包包含 YHWH 脚本、文档、配置、锁文件以及许可材料；不捆绑 npm 依赖目录或 Node.js、Java、.NET、JDT LS、clangd、Claude Code 等依赖二进制。安装器从上游下载依赖。目标环境仍受每个下载组件自己的条款约束，下载时安装不免除这些义务。

[依赖声明清单](licenses/dependency-inventory.json) 从 Windows 网关和 WSL 两份 npm 锁文件生成，包含传递及可选依赖、版本、声明许可证、分发地址与完整性值。它是元数据清单，不是完整许可证文本审计，也不覆盖 Ubuntu、PowerShell、Node、Java、.NET、JDT LS、csharp-ls、clangd、Bubblewrap 等系统/独立下载组件。它们的版本和来源仍以安装脚本及引导依赖清单为准；若未来捆绑这些组件，必须补充相应再分发材料。

`install/patch-pi-lsp.mjs` 含上游源代码匹配片段，并修改安装后的 LSP 扩展。相关片段及依赖保持上游许可。本次未完成逐文件来源审计；缺失的 LSP 上游完整通知仍待补齐，不能将本清单视为整个产品的合规认证。

## 维护与检查

运行 `node install/license-inventory.mjs` 更新锁文件声明清单及独立插件通知；运行 `node install/license-inventory.mjs --check` 检查漂移、原始材料散列与 Apache 元数据。构建器强制执行检查；一键安装包测试会检查许可材料完整且与源文件一致。修改依赖时也应重新评估原始许可证、来源及服务条款。

Claude Code 接入评估见 [可行性报告](docs/claude-code-feasibility.md)。0.6 已移除订阅凭据桥接，改用 Pi 原生 Anthropic API 与用户自备密钥。历史通知保留用于来源追溯。

## LSP 通知与公开发布状态

[原始包证据](licenses/pi-lsp-extension-evidence.json) 固定 npm 完整性值与源码提交；提供 [标准 MIT 条文](licenses/MIT-standard-reference.txt)作为参考，不虚构上游版权主体。上游版权通知仍待确认。`Build-Release.ps1 -PublicRelease` 强制执行此项阻断，默认构建仅生成本地预览。[上游询问草稿](docs/upstream-lsp-license-request.md)记录了草拟与发送状态。
