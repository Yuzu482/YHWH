# YHWH v0.13.0 — 分级思考与交付预算 / Task-proportional thinking and delivery budgets

[简体中文](#简体中文) · [English](#english)

## 简体中文

本版收录 v0.12.0 后已完成的思考档位调整、任务诊断和 Windows 可复现性修复。主代理仍负责拆分、调度、补丁整合与最终验收，源码和测试由 Pi worker 编写。

- **原生 worker 分级思考**：`openai-codex / gpt-5.6-luna` 默认从 max 改为 medium；主代理根据任务显式选择 low、medium、high 或 max。精确低风险任务可用 low，复杂设计与疑难分析可用 high，困难推理才使用 max。显式参数保持有效；reviewer 的 Sonnet/max、受控 API 平台约束和模型绑定不变。不是自动复杂度分类或自动模型切换。
- **交付与清理预算**：派发使用单调时钟扣除认证和准备时间，并从原总时限内预留 `min(15 秒, 总时限×10%)`。内部沙箱时限向下取整；不足一秒时启动前失败。输出提供 `executionBudget`，原始资源限制不变。结构化任务收到提前交付提示，原始回显不受结果格式提示影响。提示是软约束，不是隐藏推理 token 上限；超时和不完整结果仍不通过验收。
- **区分思考、正文与工具活动**：执行诊断分别统计 thinking/text 增量、工具开始/结束/错误、首次正文与最近事件时间。不采集原始思考内容。历史一次 180 秒诊断观察到持续思考但无正文或工具活动，只能说明该次运行的阶段，不能推广为所有超时的原因。
- **Windows 与无凭据测试兼容性**：受控 PowerShell 子进程显式采用进程级执行策略参数，覆盖 ACL 保留、Job Object 和升级身份核验等路径；不修改机器全局策略。测试使用临时 Pi/LSP 入口和临时凭据夹具，降低对维护者本机安装的依赖。实际 GitHub CI 的结论以对应提交的运行结果为准。
- **规则与双语文档同步**：宿主模板、按需规则目录、职责文档和 README 更新为分级思考规则，并说明源码、全局规则、运行服务和 Release 是不同状态。

### 验证与边界

发布前相同实现源码的隔离完整回归 **326/326 通过**，无失败或跳过；专项预算/派发/角色/API 检查 **34/34 通过**，属于完整套件的子集，不累加。Luna/medium 实机短回显通过；最终源码由 Luna/high 成功交付并经主代理本地前后审查，独立 Claude 审查因认证问题未完成。版本元数据采用 Luna/low 的精确修改任务。

没有同任务档位对照实验，不声称总体提速、token 节省或低档位质量等同。事件等待接口和此前未完成的受控交付模板未作为完成特性发布。全新机器安装、重启持久性、全部客户端实机体验以及新预算逻辑在维护者常驻服务中的运行尚未验证。创建本 Release 不升级本地服务；已部署服务需按升级流程单独更新。构建、附件校验和 GitHub CI 结果见本次 Release 的验证补充及 `VERIFICATION.md`。

### 下载与许可

通常选择 `YHWH-OneClick-0.13.0.zip`；单脚本分发选择 `Install-YHWH-0.13.0.ps1`；完整可检查包为 `pi-kether-portable-0.13.0.zip`。使用附带 SHA-256 文件核对下载。附件不含本机认证、私有运行配置、会话诊断记录、依赖目录或 CLI 二进制。

仓库维持私有。自有代码采用 Apache-2.0，第三方许可证不变；旧 `pi-lsp-extension` 的完整上游通知仍按现有许可说明列为限制，不把本次私有发布解释为公开再分发许可问题已解决。

## English

This release includes completed thinking-policy changes, task diagnostics and Windows reproducibility fixes since v0.12.0. The primary retains decomposition, orchestration, patch integration and final acceptance; Pi workers author source and tests.

- **Task-proportional native worker thinking:** `openai-codex / gpt-5.6-luna` now defaults to medium instead of max. The primary explicitly selects low, medium, high or max for task complexity: low for exact low-risk work, high for complex design or uncertain diagnosis, and max for justified difficult reasoning. Explicit settings remain effective. Sonnet/max reviewers, controlled API platform restrictions and model bindings are unchanged. This is not automatic complexity classification or model switching.
- **Delivery and cleanup budgets:** dispatch subtracts authentication and preparation using a monotonic clock, reserving `min(15 seconds, total timeout×10%)` inside the original deadline. Inner sandbox seconds are rounded down; fewer than one second fails before launch. Results expose `executionBudget` while retaining original resource limits. Structured tasks receive early-delivery guidance without changing raw heartbeat output instructions. Guidance is soft, not a hidden reasoning-token cap; timed-out and incomplete results remain unacceptable.
- **Separate thinking, text and tool activity:** diagnostics count thinking/text deltas, tool starts/ends/errors, first text and latest event times without collecting raw reasoning. One historical 180-second diagnostic observed continued thinking without text or tools; that evidence describes that run only and cannot explain every timeout.
- **Windows and credential-free test compatibility:** controlled PowerShell child processes explicitly specify process-local execution policy for ACL preservation, Job Object and upgrade identity checks. Machine-wide policy is unchanged. Tests use temporary Pi/LSP entries and credential fixtures, reducing reliance on maintainer installations. Actual GitHub CI status comes from the run for the released commit.
- **Synchronized policy and bilingual documentation:** host templates, on-demand policy catalog, responsibility guides and READMEs now describe task-proportional effort and distinguish source, global rules, running services and releases.

### Verification and limits

The same implementation source passed an isolated full regression of **326/326**, with no failures or skips. Focused budget/dispatch/role/API checks passed **34/34**, a subset of the full suite rather than additional tests. A live Luna/medium short echo passed. Luna/high successfully delivered the final source, with local primary pre/post review; independent Claude review remains unavailable because of authentication. Version metadata uses an exact Luna/low task.

No matched-task effort benchmark establishes overall speed, token savings or equal quality at lower effort. Completion-event waits and previously unfinished controlled delivery templates are not advertised as completed features. Fresh-machine installation, reboot persistence, all-client hands-on behavior and the new budget logic in the maintainer's persistent service remain unverified. Creating this Release does not upgrade local services; existing installations need a separate upgrade. Build, artifact checks and GitHub CI results appear in this Release's verification addendum and `VERIFICATION.md`.

### Downloads and licensing

Use `YHWH-OneClick-0.13.0.zip` for ordinary installation, `Install-YHWH-0.13.0.ps1` for single-script distribution, or `pi-kether-portable-0.13.0.zip` to inspect the full package. Verify downloads against the attached SHA-256 files. Assets exclude local authentication, private runtime configuration, session diagnostics, dependency directories and CLI binaries.

The repository stays private. First-party code remains Apache-2.0 and third-party licenses are unchanged. The legacy `pi-lsp-extension` complete upstream notice remains a documented limitation; this private release does not establish that public redistribution concerns have been resolved.
