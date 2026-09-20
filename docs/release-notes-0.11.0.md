# YHWH v0.11.0 — 关系记忆与 CLI 无头入口 / Code relationships and headless CLI

[简体中文](#简体中文) · [English](#english)

## 简体中文

本版新增持久化代码关系记忆，以及 Codex、Claude Code、Antigravity 官方 CLI 的可选无头主代理入口。

- **代码关系记忆**：JS/TS/JSX/TSX/Python 文件与符号索引，支持检索、邻接关系及导入影响查询。按源文件哈希增量刷新；过期索引默认拒绝。MCP 查询只读，刷新和限时 watch 由宿主显式执行。语法提及不等于已解析调用。
- **统一 CLI 入口**：`HeadlessDoctor`、`HeadlessRun`、`HeadlessCompare`；明确模型与权限策略、精确版本校验、标准输入任务、统一终态、超时/取消/进程树清理。默认全部禁用，认证由各官方 CLI 管理，不改变 Pi 下层角色绑定。
- **一致性与安装检查**：比对适配模块、示例配置和治理目录；发布构建增加隔离复制与漂移拒绝测试。不同账号、原生配置和系统环境仍需分别验证。
- **文档与许可材料**：完整中英文 README 与语言切换按钮，补充 Tree-sitter/WASM 固定依赖的来源及原始通知。

验证基线：Node 回归 **270/270**，CLI 专项 **11/11**，隔离复制/漂移检查、安装与配置检查、许可证清单和内存回归通过；单文件安装器另有 **35** 项源码检查，发布生成的安装器执行附加解包验证。

证据边界：本机仅核实 Codex 0.153.0、Claude Code 2.1.250 的版本及帮助参数。Antigravity 只有官方协议与本地夹具证据，三个 CLI 均未执行带认证的真实模型测试。全新机器安装、本地服务升级和完整模型治理链不是本次发布证据。关系记忆仅覆盖受支持且已纳入 Git 的普通源文件。

下载：一般用户选择 `YHWH-OneClick-0.11.0.zip`；单脚本分发使用 `Install-YHWH-0.11.0.ps1`；检查完整文件使用 `pi-kether-portable-0.11.0.zip`。核对附带 SHA-256 文件。先备份并停止已有服务，再按安装器升级说明执行；发布不会自动更新本机服务。CLI 设置参考包内 `docs/headless-cli.md`，关系记忆参考 `docs/code-graph.md`。

该 release 位于现有私有仓库。自有代码使用 Apache-2.0，第三方许可证不变；旧 `pi-lsp-extension` 完整上游通知仍按现有记录标为待补齐，公开再分发检查仍保留限制。无 CLI 二进制、凭据、主机私有配置或依赖目录随附件分发。

## English

This release adds persistent code relationships and optional official Codex, Claude Code and Antigravity headless primary-host entries.

- **Code relationships:** file/symbol indexes for JS/TS/JSX/TSX/Python with search, neighbors and import-impact queries. Hash-based incremental refresh and stale-index rejection. MCP queries are read-only; the host explicitly runs refresh or bounded watch. Syntax mentions are not resolved calls.
- **Unified CLI entry:** `HeadlessDoctor`, `HeadlessRun` and `HeadlessCompare`, explicit models/permission policies, exact version checks, stdin tasks, normalized terminal results, timeout/cancellation and process-tree cleanup. All clients default to disabled; official CLIs retain authentication ownership and Pi lower-role bindings are unchanged.
- **Consistency and installation checks:** compare adapter modules, example configuration and workflow catalog. Release builds validate an isolated copy and reject drift. Account, native-configuration and OS differences still need separate validation.
- **Documentation and notices:** complete Chinese/English READMEs with language buttons, plus provenance and original notices for the pinned Tree-sitter/WASM dependency.

Validation baseline: **270/270** Node tests and **11/11** headless-specific tests; isolated-copy/drift, installation/configuration, licensing inventory and heap checks passed. The one-click source has **35** checks; generated release installers receive additional extraction validation.

Evidence limits: only version/help flags were checked on local Codex 0.153.0 and Claude Code 2.1.250. Antigravity has official-protocol and local-fixture evidence only. No authenticated live model test was performed through these three CLI adapters. Clean-machine installation, local-service upgrades and a complete model governance chain are outside this release's evidence. Code indexing covers supported ordinary Git-tracked sources only.

Downloads: use `YHWH-OneClick-0.11.0.zip` for the normal installer bundle, `Install-YHWH-0.11.0.ps1` for single-script distribution, or `pi-kether-portable-0.11.0.zip` to inspect the complete payload. Verify the accompanying SHA-256 files. Back up and stop existing services before following the installer's upgrade instructions; publishing does not upgrade local services. See packaged `docs/headless-cli.md` and `docs/code-graph.md` for configuration.

This release remains in the existing private repository. First-party code is Apache-2.0; third-party licenses are unchanged. The legacy `pi-lsp-extension` complete upstream notice remains pending in the existing evidence, and the public-redistribution gate remains intact. Attachments exclude CLI binaries, credentials, private host configuration and dependency directories.
