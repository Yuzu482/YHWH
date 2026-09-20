# 工作流验收、升级与变更影响 / Acceptance, upgrades and change impact

[简体中文](#简体中文) · [English](#english)

## 简体中文

本页描述 v0.11.0 之后的开发改动。源码、已发布附件和本机运行服务是三个独立状态；修改源码不会自动升级服务或重发附件。

### CLI 验收与连续调用

使用宿主自己维护的 `headless.local.json`，每个客户端均需明确启用、提供真实路径并锁定完整版本。Antigravity 的路径默认留空且保持禁用，确定实际路径并审核其原生权限后再配置。

```powershell
./Workflow.ps1 -Action HeadlessAccept -HeadlessConfigFile C:/YHWH-config/headless.local.json
./Workflow.ps1 -Action HeadlessAccept -HeadlessConfigFile C:/YHWH-config/headless.local.json -Live
./Workflow.ps1 -Action HeadlessEvents -HeadlessConfigFile C:/YHWH-config/headless.local.json -HeadlessRequestFile C:/YHWH-config/request.local.json
./Workflow.ps1 -Action HeadlessBatch -HeadlessConfigFile C:/YHWH-config/headless.local.json -HeadlessRequestFile C:/YHWH-config/batch.local.json
./Workflow.ps1 -Action HeadlessBatchEvents -HeadlessConfigFile C:/YHWH-config/headless.local.json -HeadlessRequestFile C:/YHWH-config/batch.local.json
```

默认验收只检查安装，不调用模型。`-Live` 在新建的空 Git 夹具中发送随机回显令牌，使用官方 CLI 自己的登录状态，可能产生模型用量；不读取或搬运认证文件。回显通过只证明该次认证、模型访问和结果协议正常。报告中的权限、取消与 CLI→Pi MCP 是独立验收项，不能依据模型自述改为通过；完整验收未完成时保留 `complete:false`。

使用 `-Live -CancelProbe`（Node 入口为 `--live --cancel`）额外执行取消验收：回显通过后重新启动一次 CLI，在入口进程启动 1.5 秒后取消。只有实际发出取消、进程清理返回 cancelled 才通过；提前完成、准备失败或清理无法确认均不会算通过，请求的验收未通过会返回非零退出码。Ctrl+C/SIGTERM 也会传递给活动验收。此项证明本地入口/进程树取消，不证明远端模型停止计算或停止计费。

Windows 上需要确认 Codex 取消时，可在自己维护的配置中显式设置 `"processTreeMode":"job-object"`。实测该模式通过；同一次验证中的原生 taskkill 路径返回 cleanup_unverified，仍保留失败，不自动切换模式。Claude 的原生取消通过。测试结果不代替其他机器和 CLI 版本的验收。

`HeadlessEvents` 输出 NDJSON 元数据：预检、版本、帮助、指纹、缓存、运行阶段，以及首次输出和响应活动；静默期间每秒提供当前阶段的 `waiting` 状态。等待状态来自本地运行器，不代表模型正在生成或输出推理过程。Claude 仍使用最终 JSON，首次响应可能直到结束才出现。进度不包含提示、工具参数或原始 stderr；`result` 才包含完整回答。

`HeadlessBatch` 输入为 1–20 个普通任务对象组成的数组；`HeadlessBatchEvents`（Node 入口 `batch-events`）使用相同输入，实时输出 `batch-start`、每项的 `request-start`、进度、`request-result`，末行 `result` 汇总整批结果。`index` 从 0 开始，`count` 为请求数。开始执行前校验整批配置、提示和目录，避免发现后续请求错误时已有模型调用。按顺序执行，首次非 completed 或取消时停止，保留已完成结果并报告 `notRun`。文件总上限 220000 字节，单条提示上限 200000 字节。

单个批次/库会话缓存最多 16 份帮助结果、32 份文件摘要，均在 60 秒后过期；每次仍执行完整版本检查，并重新核对真实路径、文件身份、大小及高精度修改/变更时间。文件变化或过期会重新读取并计算 SHA-256；这不是防御恶意文件系统所有者的完整性屏障。`createHeadlessSession().run()` 固定提交时的输入，串行处理最多 20 个待处理请求，前项失败阻止后续调用。`clear()` 只清空缓存；失败后需新建会话并明确重新提交。独立命令不共享缓存，不复用模型进程、对话或凭据，也不自动把前一项回答传给后一项。

事件的 `elapsedMs` 从该项预检开始计时，`batchElapsedMs` 从整批开始计时。每项证据含 `queueMs`、`preflightMs`、`durationMs`、`totalMs`；首次输出/响应相对正式执行开始，无相应输出时为 null。`digestCache` 给出 hits/misses/bytesRead；整批 `summary` 汇总预检、执行、总耗时和缓存读取量。它们区分排队、预检和 CLI 执行，不能推断远端推理耗时。错误只报告经过分类的原因。这项优化减少重复读取与哈希开销，不保证模型响应速度。

可选顶层配置 `"processTreeMode":"job-object"` 只用于 Windows x64。可信启动器先挂接 Job Object 再启动 CLI，Node 运行器异常退出或 CLI 正常结束时清理关联子进程。默认 `native` 保持现有行为。Job Object 不是文件或网络权限沙箱；原生客户端权限继续生效。此模式每次会增加 PowerShell/C# 启动开销，需按任务选择。

### 受管插件升级

新安装在校验后生成 `.yhwh-managed-files.json`。升级前使用完整的新发行目录运行：

```powershell
# 只输出计划
./install/Update-PiKether.ps1 -TargetHome C:/Users/your-user
# 明确执行已检查的升级范围（执行前会重新生成并验证计划）
./install/Update-PiKether.ps1 -TargetHome C:/Users/your-user -Apply
```

目标须为支持维护入口的共享 HTTP 服务，并具有有效受管基线。旧安装可用 `-BaselinePlugin <旧版原始插件目录>` 比对，但这不会绕过维护接口或本地改动冲突。缺少基线/接口、服务忙碌、本地代码不同、依赖清单变化或涉及 WSL 副本的改动都会阻止替换。WSL、工具链、宿主规则和 provider/auth 迁移需要单独的完整安装方案；此命令不承担它们。

执行时锁定升级操作，先建立并校验备份与恢复日志，再关闭新任务接入、确认进程身份、等待网关释放资源并退出。重新核验文件后执行替换，以独立隐藏后台进程启动服务并检查进程身份及 healthz/readyz。没有按进程名强杀的降级路径。维护失败不会解除其他操作的维护状态；停服失败且无法恢复接单时保留恢复锁和日志。健康检查失败则恢复原文件及基线，再检查旧服务。`.mcp.json`、认证文件、`*.local.*`、依赖目录及运行状态不参与替换和代码备份。

若回滚遇到并发编辑、备份损坏或旧服务无法恢复，返回 `recovery-required` 并保留插件父目录的 `.yhwh-upgrade.lock` 与 `.yhwh-upgrade-<id>/journal.json`。宿主进程中途崩溃同样需要人工核对日志、实际文件与服务状态；尚未提供自动崩溃恢复命令。不要直接删除锁后重复执行，也不要用新版本文件冒充旧基线。healthz/readyz 成功不代表所有模型、LSP、Tunnel 或重启持久性已验收。

### Git 变更影响候选

```powershell
./Workflow.ps1 -Action ChangeImpact -ProjectRoot C:/work/project
node payload/pi-dispatch/scripts/change-impact.mjs C:/work/project
```

报告合并 HEAD 差异、已暂存差异和未跟踪文件；也可向 Node 入口传入完整提交 SHA 作为第二参数。最多 512 个候选路径，按现有文件安全规则排除不应读取的内容。新鲜关系索引提供最多三层相对导入反向关系，生成知识复核和测试文件候选。索引缺失或过期时只保留直接变更，不读取过期关系；先通过已有宿主命令刷新索引再重查。未跟踪源码不会为索引而自动暂存。

候选不是完整调用图或测试充分性证明；动态调用、非相对模块解析及未被源文件声明覆盖的知识可能缺失。命令不执行测试、不刷新索引、不提升知识状态、不写入 Git。

### 持续集成与证据

`.github/workflows/verify.yml` 定义 Windows 2022 上的锁定依赖安装、Node/堆内存测试、安装器与凭据夹具、目录/许可检查、打包及空目标安装计划。Actions 固定到已核对的提交，只授予仓库读取权限，不需要模型凭据，不自动上传附件或发布。检查只有在 GitHub 实际运行成功后才算 CI 证据。空目录计划不等于安装 Windows/WSL、真实登录或重启测试。

本地开发打包可用 `./Build-Release.ps1 -SkipTests -OutputDirectory .test/development-build`，避免覆盖 `release/` 已有附件；`-SkipTests` 只适用于同一源码已完成 Node/内存验证的情况，其余打包检查仍执行。实际结果记录在仓库 `VERIFICATION.md`。

## English

This page describes development changes after v0.11.0. Source, published assets and the installed service are separate states; source edits neither upgrade the service nor republish assets.

### CLI acceptance and sequential calls

Use a host-owned `headless.local.json`. Each client requires explicit enablement, its real executable path and an exact full version. Antigravity defaults to an empty path and disabled state; configure it only after locating the executable and reviewing native permissions.

```powershell
./Workflow.ps1 -Action HeadlessAccept -HeadlessConfigFile C:/YHWH-config/headless.local.json
./Workflow.ps1 -Action HeadlessAccept -HeadlessConfigFile C:/YHWH-config/headless.local.json -Live
./Workflow.ps1 -Action HeadlessEvents -HeadlessConfigFile C:/YHWH-config/headless.local.json -HeadlessRequestFile C:/YHWH-config/request.local.json
./Workflow.ps1 -Action HeadlessBatch -HeadlessConfigFile C:/YHWH-config/headless.local.json -HeadlessRequestFile C:/YHWH-config/batch.local.json
./Workflow.ps1 -Action HeadlessBatchEvents -HeadlessConfigFile C:/YHWH-config/headless.local.json -HeadlessRequestFile C:/YHWH-config/batch.local.json
```

Default acceptance checks installations without calling a model. `-Live` sends a random echo token from a new empty Git fixture, using the official CLI's own login and potentially consuming model usage; credentials are not read or transferred. An exact response establishes only that invocation's authentication, model access and result protocol. Permissions, cancellation and CLI-to-Pi MCP are separate acceptance fields; model assertions cannot mark them passed. Incomplete acceptance retains `complete:false`.

Use `-Live -CancelProbe` (`--live --cancel` for Node) for an additional cancellation check. After a successful echo it launches another CLI invocation and requests cancellation 1.5 seconds after the entry process starts. Passing requires an actual cancellation request and a cancelled result with confirmed cleanup. Early completion, fixture failure or unverified cleanup cannot pass; unsuccessful requested checks exit nonzero. Ctrl+C/SIGTERM also propagate to the active acceptance check. This establishes local entry/process-tree cancellation, not termination of remote model computation or billing.

To verify Codex cancellation on Windows, explicitly select `"processTreeMode":"job-object"` in the host-owned configuration. This mode passed live testing; the native taskkill path in the same acceptance run returned cleanup_unverified and remains failed, without automatic mode switching. Claude native cancellation passed. These observations do not validate other machines or CLI versions.

`HeadlessEvents` emits NDJSON metadata for preflight, version, help, fingerprint, cache and running phases, plus first-output and response activity. A local `waiting` event reports the current phase every second during silence; it does not establish model generation or expose reasoning. Claude still uses final JSON, so first response may arrive only at completion. Progress excludes prompts, tool arguments and raw stderr; `result` contains the full answer.

`HeadlessBatch` takes an array of 1–20 ordinary requests. `HeadlessBatchEvents` (Node action `batch-events`) uses the same input and streams `batch-start`, each `request-start`, progress and `request-result`, followed by a final `result` containing the batch report. `index` is zero-based; `count` is the number of requests. Configuration, prompts and directories for the entire batch are validated before any execution. Calls run sequentially and stop on the first non-completed result or cancellation, retaining completed results and reporting `notRun`. The request file is limited to 220000 bytes; each prompt to 200000 bytes.

A batch/library session caches up to 16 help results and 32 file digests, each expiring after 60 seconds. Every invocation still checks the exact version and rechecks real paths, file identity, size and high-resolution modification/change timestamps. Drift or expiry forces fresh SHA-256 reads; this is not an integrity barrier against a hostile filesystem owner. `createHeadlessSession().run()` snapshots admitted inputs and serializes up to 20 pending calls, blocking later calls after failure. `clear()` clears caches only; recovery requires a new session and explicit resubmission. Separate commands share no cache, model process, conversation or credentials; answers are not automatically passed to later requests.

Event `elapsedMs` starts at that request's preflight; `batchElapsedMs` starts at batch entry. Per-call evidence includes `queueMs`, `preflightMs`, `durationMs` and `totalMs`; first-output/response timings start at formal execution and may be null. `digestCache` reports hits/misses/bytesRead. Batch `summary` totals preflight, execution, wall time and cached reads. These separate queueing, preparation and CLI execution, without inferring remote inference time. Errors expose sanitized categories only. The optimization reduces repeated reads and hashing without promising faster model responses.

Optional top-level `"processTreeMode":"job-object"` requires Windows x64. A trusted launcher assigns the CLI to a Job Object before resuming it, cleaning associated descendants when the Node runner dies or the CLI exits normally. Default `native` preserves existing behavior. Job Objects are not filesystem or network sandboxes; native permissions still apply. PowerShell/C# startup adds per-call overhead, so select this mode for the workload.

### Managed plugin upgrades

New installations write `.yhwh-managed-files.json` after verification. Run from a complete new distribution:

```powershell
# Show the plan only
./install/Update-PiKether.ps1 -TargetHome C:/Users/your-user
# Explicitly apply the reviewed scope; regenerate and verify the plan before execution
./install/Update-PiKether.ps1 -TargetHome C:/Users/your-user -Apply
```

The target must be a shared HTTP service supporting maintenance and a valid managed baseline. Legacy installs may compare against `-BaselinePlugin <original-old-plugin-directory>`, which bypasses neither missing maintenance support nor local conflicts. Missing baselines/endpoints, busy services, modified code, changed dependencies and files also deployed to WSL block replacement. WSL, toolchains, host policies and provider/auth migration require a separate full installation plan.

Application locks the update and first creates verified backups and a recovery journal. It then closes admission, validates process identity and waits for gateway cleanup and exit. Files are rechecked before replacement; the service starts as a detached hidden background process with identity and healthz/readyz checks. There is no process-name force-kill fallback. Failed maintenance acquisition does not release another operation's maintenance state; a failed stop followed by failed admission recovery retains the recovery lock and journal. Failed health checks restore old files and the baseline and check the old service. `.mcp.json`, credentials, `*.local.*`, dependencies and runtime state are excluded from replacement and code backups.

Concurrent edits during rollback, corrupt backups or failed old-service recovery return `recovery-required`, retaining `.yhwh-upgrade.lock` and `.yhwh-upgrade-<id>/journal.json` in the plugin parent. A crashed upgrade process also requires manual reconciliation of the journal, files and service; automated crash recovery is not implemented. Do not simply remove the lock and retry or substitute new files for the old baseline. Passing healthz/readyz does not establish model, LSP, Tunnel or reboot acceptance.

### Git change impact candidates

```powershell
./Workflow.ps1 -Action ChangeImpact -ProjectRoot C:/work/project
node payload/pi-dispatch/scripts/change-impact.mjs C:/work/project
```

The report combines HEAD differences, staged differences and untracked files; the Node entry also accepts a full baseline commit SHA as its second argument. Existing source safety rules filter up to 512 candidate paths. A fresh graph supplies reverse relative-import relationships up to depth three to identify knowledge-review and test-file candidates. Missing/stale graphs retain direct changes only; explicitly refresh with the existing host command before checking again. Untracked sources are never staged merely for indexing.

Candidates are neither complete call graphs nor proof of sufficient tests. Dynamic calls, non-relative module resolution and knowledge outside declared source relationships may be missed. The command executes no tests, refreshes no index, promotes no knowledge and mutates no Git state.

### CI and evidence

`.github/workflows/verify.yml` defines locked dependencies, Node/heap tests, installer and credential fixtures, catalog/license checks, packaging and an empty-target installation plan on Windows 2022. Actions are pinned to verified commits with repository read permission only; no model credentials, asset uploads or publication are configured. Only a successful actual GitHub run is CI evidence. An empty-directory plan is not Windows/WSL installation, live login or reboot testing.

For development packaging, use `./Build-Release.ps1 -SkipTests -OutputDirectory .test/development-build` to preserve existing `release/` assets. `-SkipTests` requires prior Node/heap validation of the same sources; other package checks still run. Actual outcomes are recorded in repository `VERIFICATION.md`.
