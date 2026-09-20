# YHWH v0.12.0 — 协调分工、连续调用与心跳 / Coordination, sequential calls and heartbeats

[简体中文](#简体中文) · [English](#english)

## 简体中文

本版汇总 v0.11.0 之后的两轮功能提交（`bee3e54`、`3c65085`），包含此前尚未进入 release 的优化。

- **主代理协调，Luna 编码**：Astra 或宿主主模型负责意图、拆分、调度、补丁整合和验收；Pi Luna/max 编写代码、测试及修复。worker 失败不自动回退到主代理编码。保留任务范围、交付来源、结果结构和清理检查。该规则属于宿主指令与审计策略，不是禁用所有客户端编辑工具的技术屏障。
- **严格禁止反复轮询**：禁止 Astra 重复查询进度，包括等待后查询、固定时间批次和脚本包装的查询循环。优先使用实际可用的完成等待接口；缺少接口时，等到真实事件、预定截止时间或用户询问再读取必要状态。独立监控界面与本地心跳继续运行；本版没有新增完成事件订阅或自动唤醒 Astra 的接口。
- **无模型监管心跳**：异步任务运行后每 10 秒更新一次本地心跳，超过 30 秒未更新视为过期，执行进度单独计时。排队不启动计时器，状态读取不刷新心跳，取消及全部终态停止并冻结，重放不重复创建。现有状态/列表接口提供元数据；未添加界面心跳徽标。`modelCalls:0` 仅指监管心跳，不证明子进程或远端模型健康，也不触发自动重试、探测或放宽超时。
- **更透明的连续 CLI 调用**：`HeadlessBatchEvents` 显示每项阶段、首次输出、等待、结果及整批汇总。先验证整批输入，再串行执行；失败或取消停止后续任务并保留已有结果。会话内帮助与文件摘要缓存减少重复读取，仍逐次验证完整版本和文件身份，提供缓存与分段耗时证据。不复用模型进程、会话或凭据，也不保证远端推理加速。
- **CLI 验收与进程清理**：增加显式实机回显和取消验收，以及可选 Windows Job Object 进程树管理。本机历史验收中 Claude 原生取消通过，Codex Job Object 通过、原生清理仍未确认；不自动切换模式。Antigravity 路径留空、默认禁用，实机验收待完成。
- **受管 Pi 升级与回滚**：维护暂停、状态、恢复和停止入口；受管文件基线、升级锁、备份校验与日志、冲突拒绝、后台独立重启和失败回滚。WSL 副本、工具链、宿主规则与认证迁移不在定向升级范围；崩溃日志仍需人工核对。
- **Git 变更影响候选**：结合已暂存、未暂存、未跟踪文件及新鲜的反向相对导入关系，提示知识复核和测试候选。不会自动运行测试、刷新索引或确认知识，不代表完整语义调用图。
- **WSL 模型工具隔离**：普通模型任务停止自动加载旧 LSP 扩展工具及其生命周期钩子，保留受控 `yhwh_lsp_*`、读写范围和授权编辑器桥接。直接确定性探针及宿主兼容路径仍保留；不代表旧依赖已彻底移除。

继续保留：项目长期知识、持久化代码关系、多语言确定性 LSP、18 个宿主配置入口、三个可选官方 CLI 主代理入口、受控 API 平台配置和 Windows DPAPI 密钥加密。这些来自此前版本，不重复计为本版新增。

### 验证与限制

既有专项证据包含协调/路由 45/45、任务拆分组合 51/51、心跳/网关 55/55、实际安装副本 10/10、策略 5/5；这些套件有重叠，不能累加为独立测试数量。版本元数据由 Pi Luna/max 交付，发布前后审查由主代理本地完成，不宣称独立 reviewer 或完整运行时阶段链。最终构建与测试结果见本次 GitHub release 的验证补充和仓库 `VERIFICATION.md`。

基线提交 `3c65085` 的 [Windows CI](https://github.com/Yuzu482/YHWH/actions/runs/35531780910) 存在 7 项失败：2 项涉及 CI 缺少已安装的 Pi/LSP 入口，5 项涉及认证续期持久化/跨进程夹具。未据此宣称 CI 通过或无凭据环境可完整复现。全新机器安装、重启持久性、所有宿主实机体验与完整治理链不属于本版已完成证据。

维护者本机此前已定向部署心跳和 WSL 工具隔离；这不表示发布包与含本机认证适配的全部运行文件完全相同。创建 release 不会自动升级任何本地服务。

### 下载与许可

一般安装选择 `YHWH-OneClick-0.12.0.zip`；单脚本分发选择 `Install-YHWH-0.12.0.ps1`；检查完整内容选择 `pi-kether-portable-0.12.0.zip`。核对附带 `.sha256`、`SHA256SUMS.txt` 和版本清单。已有安装先备份，按 `docs/workflow-operations.md` 核查受管升级条件。

本 release 保持在现有私有仓库。自有代码采用 Apache-2.0；第三方许可证不变，旧 `pi-lsp-extension` 完整上游通知仍待补齐，公开再分发检查仍受限。附件不包含 CLI 二进制、认证文件、主机私有配置、运行日志或 `node_modules`。

## English

This release collects both feature commits since v0.11.0 (`bee3e54` and `3c65085`), including improvements not previously shipped in a release.

- **Primary coordination, Luna implementation:** Astra or the host-selected primary owns intent, decomposition, scheduling, patch integration and acceptance. Pi Luna/max authors code, tests and repairs. Worker failure does not silently fall back to primary coding. Scope, provenance, result structure and cleanup checks remain required. This is a host instruction and audit policy, not a technical barrier disabling every client's editing tools.
- **Strict no-polling policy:** Astra must not repeatedly query progress through sleep/query loops, fixed-interval batches or script-wrapped loops. Prefer an actually available completion wait; otherwise wait until a genuine event, a predeclared deadline or a user request before reading necessary status. Independent monitoring and local heartbeats continue. No completion-event subscription or automatic Astra wakeup interface was added.
- **Model-free supervision heartbeats:** Running asynchronous tasks receive a local heartbeat every 10 seconds; more than 30 seconds without a beat is stale. Execution progress is tracked separately. Queued tasks have no timer, reads do not refresh beats, cancellation and every terminal path stop/freeze the timer, and replay does not duplicate it. Existing status/list APIs expose metadata; no UI heartbeat badge was added. `modelCalls:0` refers only to supervision, not child-process or remote-model health. No automatic retry, probing or relaxed timeout is introduced.
- **More transparent sequential CLI calls:** `HeadlessBatchEvents` reports each request's phases, first output, waiting, result and batch summary. Validate all inputs before serial execution; stop later work on failure/cancellation while retaining prior results. Session-local help/digest caches reduce repeated reads while preserving exact version and file-identity checks, with cache and phase timings. Model processes, conversations and credentials are not reused; remote inference acceleration is not guaranteed.
- **CLI acceptance and process cleanup:** Explicit live echo/cancellation acceptance and optional Windows Job Object process-tree management. Historical local acceptance passed Claude native cancellation and Codex Job Object cleanup; Codex native cleanup remains unverified, with no automatic mode switching. Antigravity stays disabled with an empty path and pending live acceptance.
- **Managed Pi upgrades and rollback:** Maintenance pause/status/resume/stop, managed-file baselines, upgrade locks, verified backups/journals, conflict rejection, detached restart and rollback on failure. Targeted upgrades exclude WSL copies, toolchains, host policies and authentication migration; crash journals still require manual reconciliation.
- **Git change-impact candidates:** Combine staged, unstaged and untracked paths with fresh reverse relative-import relationships to suggest knowledge-review and test candidates. This runs no tests, refreshes no index, accepts no knowledge and is not a complete semantic call graph.
- **WSL model-tool isolation:** Ordinary model tasks no longer automatically load legacy LSP tools and their lifecycle hooks. Controlled `yhwh_lsp_*`, read/write scopes and authorized editor bridges remain. Direct deterministic probes and host compatibility paths remain; this does not mean the legacy dependency was fully removed.

Retained capabilities include project knowledge, persistent code relationships, multilingual deterministic LSP, 18 host configuration entries, three optional official CLI primary hosts, controlled API-platform configuration and Windows DPAPI key encryption. These shipped earlier and are not counted again as new features.

### Validation and limitations

Existing focused evidence includes coordination/routing 45/45, decomposition integration 51/51, heartbeat/gateway 55/55, installed-copy 10/10 and policy 5/5. These suites overlap and must not be added as unique tests. Pi Luna/max delivers version metadata; release pre/post review is local primary review, not an independent reviewer verdict or a complete runtime-attested stage chain. Final build/test results are recorded in this GitHub release's validation addendum and repository `VERIFICATION.md`.

The baseline `3c65085` [Windows CI run](https://github.com/Yuzu482/YHWH/actions/runs/35531780910) has 7 failures: 2 involve missing installed Pi/LSP entries and 5 involve authentication-renewal persistence/cross-process fixtures. Neither passing CI nor complete reproduction on a credential-free host is claimed. Fresh-machine installation, reboot persistence, every host's live experience and a complete governance chain remain outside this release's completed evidence.

The maintainer previously deployed heartbeats and WSL tool isolation locally. That does not establish whole-runtime parity with host-specific authentication adaptations. Publishing a release does not upgrade local services.

### Downloads and licensing

Use `YHWH-OneClick-0.12.0.zip` for normal installation, `Install-YHWH-0.12.0.ps1` for single-script distribution, or `pi-kether-portable-0.12.0.zip` to inspect the full payload. Verify accompanying `.sha256`, `SHA256SUMS.txt` and the release manifest. Back up existing installations and check managed-upgrade conditions in `docs/workflow-operations.md`.

This release remains in the existing private repository. First-party code is Apache-2.0; third-party licenses are unchanged. The complete upstream legacy `pi-lsp-extension` notice remains pending and public redistribution remains gated. Assets exclude CLI binaries, authentication files, private host configuration, runtime logs and `node_modules`.
