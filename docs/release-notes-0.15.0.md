# YHWH v0.15.0

## 中文

本版本汇总 v0.14.0 之后的工作流治理、真实宿主验收、Claude CLI 审查、补丁完整性与运行时质量改进。

### 更新

- 规则、技能和 Hindsight wrapper 从仓库统一生成；按需主题凭据、可读角色名和安装哈希检查减少规则漂移。
- T0/T1/T2 分级及网关门控；持久 `awaiting-host-verification` 允许主代理提交真实命令证据，再将任务转为 completed 或 failed，不篡改原 worker 结果。
- 官方 Claude Code CLI 成为默认 Sonnet reviewer 传输；Luna 继续负责 worker 编码。CLI 登录由官方客户端管理，API key 路线为显式选项，不自动回退。
- F1–F5 Windows 基线验证：完整 TAP、严格分类与重复 ID 校验、realpath 比较、BOM 解码、相对路径和同名测试序号。基线清空后保留 npm 非零即失败。
- 原字节补丁策略：阻止本任务下发的临时凭据及固定编码形式；通用疑似凭据只标记并要求主代理人工确认；旧记录不重扫、不重写。
- 审计分开记录 operationOutcome、taskOutcome 和 dispatch runtime；打包插件版本自动带 Git 提交哈希及干净构建来源。
- 快照自动创建受限的新文件父目录；新增只读 fixtureScope，跨语言范围校验、独立复制、只读挂载和最终完整性检查。
- hostEvidence 从已校验的 handoff 计算规范 runAnchor，修复读取不存在字段导致的解析失败。
- runtime-code 通用约定和项目简版：具名参数、明确进程成功条件、句柄收尾、真实解释器样本检查；任务预检仅返回警告，审计保存静态分类计数。
- Windows CLI 预检预算、内存回归取消时序及文件锁收尾修复；保留原测试和断言。

### 验证与审查

运行时提交392c232：宿主全量510项，508通过、0失败、2既有跳过；原生 WSL 21/21，零跳过；内存40取消/40断连，原阈值通过。Windows CI36847185313成功。最终发布元数据及 main CI 结果以 Release 所附链接为准。

前序宿主验收、补丁策略及 CLI 预算有真实独立审查；本轮 fixture pipeline 独立后审通过，其意见已修复。最终剩余部分按用户明确例外由主代理审查，**本地审查，非独立审查**，没有伪造 Geburah 结论。持久账本回归使用明确标注的 synthetic 样本，不能冒充真实模型全链路验证。

本机0.1.0+392c232a2e95已安装，264托管文件零漂移；真实 Luna/Claude CLI 探针分别约9.0/7.3秒。最终发布包哈希来自发布提交，不声称本机已再次部署该元数据版本。两三天效果统计尚未完成，没有量化提速声明。

### 分发与限制

提供便携 ZIP、自包含安装 PS1、双击 OneClick ZIP 及 SHA256。包不含凭据、本机日志、node_modules 或第三方依赖二进制；安装仍需网络准备固定依赖。未单独提供 GUI EXE。

自有代码采用 Apache-2.0。沿用用户此前已明确授权的发布例外：固定 pi-lsp-extension 1.3.0 的完整上游通知适用性仍未确认，公开许可门禁仍拒绝；不声称完整许可证审计通过。上游1.4.0已提供MIT文件，但不自动证明1.3.0的适用性。

PowerShell7是工作流要求，5.1不支持 Verify。上游 Pi 依赖审计、standard worker时间上限及Claude CLI分段耗时仍待处理。通用疑似凭据提示不能保证补丁无秘密；CLI reviewer在宿主运行，不受worker WSL隔离。本地安装器尝试创建新名称计划任务时被拒绝，已有启动任务保留、服务已恢复；本次不宣称该新任务已创建。Codex当前会话缓存更新可能需要重载。

`yhwh_run_check` 仅有[设计方案](runtime-check-tool-proposal.md)，等待用户决定，没有开放 worker 执行权限。fixture源路径大小写不敏感查找的负例含模拟，真实Linux内核只读和复制检查已运行。

## English

This release consolidates governance, genuine host verification, Claude CLI review, patch integrity and runtime quality work since v0.14.0.

### Changes

- Generate rules, skills and the Hindsight wrapper from repository sources. Topic receipts, readable role names and installation hash checks reduce policy drift.
- T0/T1/T2 tiers and gateway gates. Durable `awaiting-host-verification` lets the primary submit real command evidence and complete or fail a task without rewriting the original worker result.
- Official Claude Code CLI becomes the default Sonnet reviewer transport; Luna remains the worker route. Official clients manage CLI login. API keys are explicit alternatives, with no automatic fallback.
- F1–F5 Windows baseline checks: complete TAP, strict classifications and unique IDs, realpath comparison, BOM decoding, repository-relative paths and duplicate-name ordinals. The empty baseline retains failure on nonzero npm exit.
- Preserve raw patch bytes. Block task-issued temporary credentials and pinned encodings; generic secret-like content warns and requires primary human confirmation. Legacy records are not rescanned or rewritten.
- Separate audit operationOutcome/taskOutcome and dispatch runtime. Build plugin versions from the Git commit with clean-source provenance.
- Create admitted new-file parents in private snapshots. Read-only fixtureScope adds cross-language scope validation, private copies, read-only mounts and final integrity checks.
- Compute canonical hostEvidence runAnchor from validated handoffs, fixing comparison against a missing field.
- Runtime contracts and a short project template cover named arguments, explicit process success, handle cleanup and real interpreter fixtures. Admission checks are advisory; audit stores static warning-category counts.
- Repair Windows CLI preflight budgets, memory cancellation timing and bounded file-lock cleanup without deleting tests or weakening assertions.

### Verification and review

Runtime commit392c232: host510tests/508pass/0fail/2existing skips; native WSL21/21 with zero skips; memory40cancel/40disconnect with original thresholds passing. Windows CI36847185313 succeeded. Release-metadata and main CI links accompany the final Release.

Earlier host acceptance, patch policy and CLI budgets received genuine independent reviews. The runtime fixture pipeline was independently approved and its findings were fixed. The remaining final facets used the user's explicit primary-review exception: **local review, not independent review**. No Geburah approval was forged. Durable-ledger regressions use explicitly synthetic samples, not a claimed live model chain.

Local0.1.0+392c232a2e95 was installed with zero drift across264managed files. Real Luna/Claude CLI probes took approximately9.0/7.3seconds. Final release hashes identify the release commit; the local runtime has not been redeployed merely for release metadata. The two-to-three-day outcome comparison is pending; no quantified speedup is claimed.

### Distribution and limitations

Downloads include portable ZIP, standalone installer PS1, double-click OneClick ZIP and SHA256 files. No credentials, local logs, node_modules or third-party dependency binaries are bundled; installation still prepares pinned dependencies using the network. No separate GUI EXE is supplied.

First-party code is Apache-2.0. This release retains the user's previously authorized exception: applicability of the complete upstream notice to pinned pi-lsp-extension1.3.0 remains unconfirmed and the public license gate still rejects. Full license-audit clearance is not claimed. Upstream1.4.0 has an MIT file, which does not automatically establish coverage of1.3.0.

Workflow Verify requires PowerShell7;5.1 is unsupported. Upstream Pi dependency auditing, the standard worker ceiling and segmented Claude CLI timing remain follow-ups. Generic secret warnings do not prove a patch contains no secrets. CLI reviewers run on the host outside worker WSL isolation. The local installer was denied creation of a newly named startup task; the existing task was preserved and service restored, not falsely reported as newly created. The active Codex session cache may require reload.

`yhwh_run_check` remains a [design proposal](runtime-check-tool-proposal.md), awaiting user decision; no worker execution permissions were enabled. The case-insensitive fixture-source lookup negative uses a simulation; real Linux copying and read-only kernel checks ran.
