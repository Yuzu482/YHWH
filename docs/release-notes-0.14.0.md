# YHWH v0.14.0

## 中文

YHWH v0.14.0 带来更严格的 Pi worker 执行策略、更清晰的任务交接与协作流程，以及 Windows 安装和网关控制台方面的更新。

### 主要更新

- **由 YHWH 管理普通 Pi worker 的 strict/off 策略。** 支持原生 OpenAI `gpt-6-luna`；Sonnet reviewer 保留为明确的例外。
- **角色预设与确定性结果提交。** 新增 role presets，以及面向 WSL 读取和 workspace 写入任务的 `yhwh_submit_result` 工具。该工具执行 fail-closed 验证；旧式无访问权限 envelope 仍受支持。
- **类型化交接与阶段连续性。** v2 handoffs 提供类型化任务交接并保留工作流阶段连续性。
- **协作任务包。** 支持将工作拆成 2–4 个互不重叠的小型任务包，以便协作执行。
- **Electron 网关控制台源码。** 提供网关监控与配置控制台源码，并包含独立 Windows 打包支持；此项不代表已发布 GUI 二进制文件。
- **Windows 安装与自检修复。** 修正 ACL 处理，使其兼容 PowerShell 5.1 和 7.6；同时修复 WSL/LSP 自检问题。

### 本机验证

以下是本机观察到的检查结果，不等同于全新机器端到端安装验证或发布流水线验证：

- 完整 Node 测试套件：376/376 通过；`npm ci` 干净完成。
- 更新过时测试 fixture 以使用 `gpt-6-luna` 后，内存回归测试通过：400 ordinary、40 large、40 cancelled、40 disconnected。
- workflow 配置与 headless 检查通过。
- Electron 源码语法检查及 `gateway-console-config` 测试：5/5 通过。
- ACL 合成 fixture 和本机真实 Pi ACL helper，在 PowerShell 5.1 与 7.6 下均通过；已安装 Pi 的自检在两个版本下均通过。

**尚未重新验证：** 全新机器上的完整一键安装，以及 Electron GUI 的实际运行体验。准备源码时 GitHub CI 与新产物尚未核实；最终状态请参阅发布页面及对应 CI，本机检查不能替代这些验证。

### 分发与许可说明

计划提供带版本号的 YHWH-OneClick ZIP、独立 `Install-YHWH` PS1、便携 ZIP 及校验和文件。包含 Electron EXE 打包源码，但不承诺发布 GUI 二进制资产。第一方代码采用 Apache-2.0；上游依赖继续遵循各自的许可条款。

普通许可清单检查通过（358 项）。公开仓库许可门禁 `node install/license-inventory.mjs --check --public` 仍未通过，涉及固定版本 `pi-lsp-extension` 1.3.0：该版本虽声明 MIT，但缺少完整的许可与版权通知文本。上游于 2026-09-24 在 1.4.0 中新增 MIT LICENSE，但未明确确认其是否适用于已经发布的 1.3.0，因此不能据此认定 1.3.0 的问题已解决，也不应表述为上游从未提供许可。此次公开分发依据用户此前明确授权的例外，并附透明说明；这不构成完整许可合规认证。

## English

YHWH v0.14.0 brings stricter execution policy for Pi workers, clearer task handoffs and collaboration workflows, and updates to Windows installation and the gateway console.

### Highlights

- **YHWH-managed strict/off policy for ordinary Pi workers.** Supports native OpenAI `gpt-6-luna`; the Sonnet reviewer remains an explicit exception.
- **Role presets and deterministic result submission.** Adds role presets and the `yhwh_submit_result` tool for WSL read and workspace-write tasks. The tool validates fail-closed; the legacy no-access envelope remains supported.
- **Typed handoffs and phase continuity.** v2 handoffs provide typed task transfer while preserving workflow phase continuity.
- **Cooperative task packs.** Work can be divided into 2–4 small, disjoint task packs for cooperative execution.
- **Electron gateway console source.** Includes source for gateway monitoring and configuration, plus standalone Windows packaging support; this does not mean a GUI binary is released.
- **Windows installation and self-test fixes.** ACL handling is fixed for PowerShell 5.1 and 7.6, alongside WSL/LSP self-test fixes.

### Local verification

These are checks observed locally; they are not equivalent to end-to-end installation on a fresh machine or verification of the release pipeline:

- Full Node test suite: 376/376 passed; `npm ci` completed cleanly.
- Memory regression passed after updating a stale test fixture to use `gpt-6-luna`: 400 ordinary, 40 large, 40 cancelled, and 40 disconnected.
- Workflow configuration and headless checks passed.
- Electron source syntax check and `gateway-console-config` tests: 5/5 passed.
- The ACL synthetic fixture and real local Pi ACL helper passed on PowerShell 5.1 and 7.6; the installed Pi self-test passed on both versions.

**Not reverified:** the complete one-click installation on a fresh machine and live use of the Electron GUI. At source preparation time, GitHub CI and the new artifacts were unverified; see the release page and corresponding CI for final status. Local checks do not substitute for those verifications.

### Distribution and licensing

Planned downloads include a versioned YHWH-OneClick ZIP, standalone `Install-YHWH` PS1, portable ZIP, and checksum files. Electron EXE packaging source is included, but no GUI binary release asset is promised. First-party code is Apache-2.0; upstream dependencies retain their respective license terms.

The ordinary license inventory passes (358 entries). The public-repository license gate, `node install/license-inventory.mjs --check --public`, still fails for pinned `pi-lsp-extension` 1.3.0: the package itself lacked a license notice. Upstream added an MIT LICENSE in 1.4.0 on 2026-09-24, but did not explicitly confirm that it applies to the already published 1.3.0. This does not establish that the 1.3.0 issue is resolved, nor is it accurate to say upstream has never supplied a license. This public distribution uses the user's earlier explicitly authorized exception with transparent notice; it does not certify full license compliance.
