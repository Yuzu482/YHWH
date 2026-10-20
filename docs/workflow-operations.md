# 工作流验收、升级与变更影响 / Acceptance, upgrades and change impact

[简体中文](#简体中文) · [English](#english)

## 简体中文

本页描述 v0.12.0 收录的工作流改动。源码、已发布附件和本机运行服务是三个独立状态；修改源码不会自动升级服务或重发附件。

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

### 工作树风险与维护基线

宿主 `riskProfiles` 中，指向完整 Git 仓库根目录的 `critical` 配置对该仓库已登记的工作树（包括 detached HEAD 与子目录）提供 critical 下限。普通路径仍按最长祖先匹配；同仓库工作树内的 personal/standard 条目不能降低该下限。克隆、名称相近的兄弟目录、复制的 `.git` 指针不继承。指向仓库子目录的 critical 条目只作用于该路径，不提升整个仓库。允许根目录与 writeScope 的边界独立保留。

仓库身份在每次判定时通过物理路径、Git common-dir 与 `worktree list --porcelain -z` 登记重新核对；Windows 使用系统原生物理路径解析，统一 8.3 短路径与完整路径。身份损坏、检查超时/超量或 Git 不可用时拒绝判定，不回退到较低等级。一次风险判定共享 3 秒 Git 预算，启动时也检查配置的 critical 仓库身份；同步检查会占用宿主事件循环。这是源代码候选行为，只有单独授权安装后才影响运行网关。

开始维护时，从已核对的安装来源记录选择完整提交；若使用更新的 main，需先明确核对并批准该提交。不要用目录修改时间或本地分支名称选择基线。在候选源码的 `payload/pi-dispatch` 中运行：

```powershell
node scripts/maintenance-baseline.mjs --source-root C:/work/YHWH-clean-source --expected-commit <完整提交SHA>
```

命令要求精确仓库根目录、HEAD 等于该提交，且暂存区、已跟踪及未忽略的新文件均干净。检查时禁用仓库配置的过滤器；含 Git 子模块的基线直接拒绝，不进入子仓库运行检查。退出码 0 为可用基线，1 为检查不通过（含缺 Git、身份损坏、基线错误、脏目录或子模块），2 为参数错误；只返回 JSON，不生成文件。忽略文件不在干净性保证内。预期提交是宿主提供的信任输入；此检查不验证安装来源真实性、不刷新远端，也不替代授权、补丁指纹或测试。

先保留原目录状态和改动指纹；检查通过后，宿主显式从该完整 SHA 创建隔离工作树，再核对新工作树 HEAD/干净状态，并记录本轮逐文件范围、基准哈希和回滚位置。实现后在隔离候选记录完整差异、最终文件哈希、真实验证和独立审查。候选出现本轮改动后不再满足“干净基线”，应继续使用已冻结基线与当前补丁验收，不清理或移动原目录改动。该命令不创建工作树、不 reset/stash/checkout/clean/fetch，也不提交、推送、修改运行配置或部署。

## English

This page describes workflow changes included in v0.12.0. Source, published assets and the installed service are separate states; source edits neither upgrade the service nor republish assets.

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

### Worktree risk and maintenance baseline

A host critical riskProfiles entry at an exact Git repository root imposes a critical floor on its registered worktrees, including detached HEAD and nested working directories. Ordinary paths retain longest-ancestor matching; personal/standard entries in the same critical repository cannot lower that floor. Clones, prefix siblings and copied .git pointers do not inherit it. A critical entry on a repository subdirectory stays path-local. Allowed gateway roots and writeScope remain separate authorization boundaries.

Each resolution rechecks physical paths, Git common-dir and worktree list --porcelain -z registration. Windows uses native physical path resolution to unify 8.3 short and full path spellings. Invalid identity, unavailable Git and time/output limits fail closed rather than downgrade. Git calls share a three-second resolution budget; configured critical repositories are also inspected at startup. These synchronous checks occupy the host event loop. This source candidate affects a running gateway only after a separately authorized installation.

Before maintenance, select a full commit from verified installation provenance, or explicitly verify and approve a newer main commit. Directory timestamps and local branch names are insufficient. From the candidate payload/pi-dispatch directory run:

```powershell
node scripts/maintenance-baseline.mjs --source-root C:/work/YHWH-clean-source --expected-commit <FULL_COMMIT_SHA>
```

The source must be an exact registered repository root with matching HEAD and no staged, tracked or nonignored untracked changes. Configured filters are disabled during inspection; baselines containing Git submodules are refused before child repositories are inspected. Exit 0 means baseline ready, 1 means inspection/dependency/identity/commit/cleanliness/submodule failure, and 2 means argument error. JSON is returned without output files. Ignored files are excluded. The expected commit is host-supplied trust input: the command does not authenticate provenance, refresh remote refs, authorize work or replace artifact fingerprints and tests.

Preserve the original directory status and change fingerprints first. After a passing gate, the host explicitly creates an isolated worktree from the full SHA, verifies its initial HEAD/clean state and records exact file scope, before-hashes and rollback location. After implementation record the complete diff, final hashes, real checks and independent review in that candidate. A dirty implementation candidate is checked against its frozen baseline and patch; do not clean or move the original edits to satisfy the initial gate. This command creates no worktree, does not reset/stash/checkout/clean/fetch, and never commits, pushes, edits running configuration or deploys.

### CI and evidence

`.github/workflows/verify.yml` defines locked dependencies, Node/heap tests, installer and credential fixtures, catalog/license checks, packaging and an empty-target installation plan on Windows 2022. Actions are pinned to verified commits with repository read permission only; no model credentials, asset uploads or publication are configured. Only a successful actual GitHub run is CI evidence. An empty-directory plan is not Windows/WSL installation, live login or reboot testing.

For development packaging, use `./Build-Release.ps1 -SkipTests -OutputDirectory .test/development-build` to preserve existing `release/` assets. `-SkipTests` requires prior Node/heap validation of the same sources; other package checks still run. Actual outcomes are recorded in repository `VERIFICATION.md`.

# 部署前证据与 Git 检查故障隔离

部署计划包含只读清理预览：请求账本与审计日志分别列出候选路径、字节数和原因（保留期或容量）。预览复用实际清理选择规则，不实例化会在启动时清理的账本或日志写入器。运行中预览无法读取内存中的 in-flight 状态，仅作提示；正式备份在网关空闲、暂停接收新请求后进行。保留期和关键证据保护规则不变。

受管升级依次执行：旧程序文件备份、暂停接收请求、证据备份与校验、记录证据清单指纹、停服、替换、启动并检查健康。结果尚未落盘时拒绝暂停并保持运行，待落盘完成后再重试；暂停不会关闭结果监视器。证据备份失败会在停服前退出并恢复接收请求；恢复失败保留恢复锁和日志。程序回滚继续使用原有文件备份，不自动把旧账本覆盖回运行状态。

完整安装器的 `-PlanOnly` 也显示预览；正式安装在替换已安装文件前创建证据备份。完整安装器本身不执行停服，因此人工停服前必须先运行独立备份命令，再执行安装。安装器内部备份只是替换前的第二道检查，无法挽回更早停服已清理的数据。例如（路径须为绝对路径，备份目录必须不存在）：

```powershell
node payload/pi-dispatch/scripts/deployment-evidence.mjs --state-root C:/Users/asus/.local/state/pi-kether --preview
node payload/pi-dispatch/scripts/deployment-evidence.mjs --state-root C:/Users/asus/.local/state/pi-kether --snapshot --backup-root C:/Users/asus/.local/state/pi-kether/installer-backups/pre-stop-UNIQUE/evidence
```

使用其他配置文件名时，以重复的 `--config-file ABS_JSON` 明确列出状态目录内的运行设置与网关配置，最多四个额外文件；只记录哈希。受管升级自动传入它实际使用的两个配置文件。配置所指的账本和审计路径仍须在已覆盖的默认位置，否则停服前退出。

快照包含整个 `request-ledger`、当前及轮转的普通/关键审计日志、`installation-records`。网关与运行配置仅记录哈希，不复制令牌或配置内容；不会递归复制维护档案、以前的备份或修改任何任务状态。使用非标准账本/审计路径的配置会阻止部署，须先明确覆盖范围。每次最多 50000 个文件、单文件 16 MiB、合计 512 MiB；拒绝链接、硬链接、路径越界和与证据源重叠的输出。逐文件校验后重新核对源清单，新增、移除或变化都会使备份失败；失败副本与 `failure.json` 保留，不能作为完整快照使用。备份包含敏感工作内容，应存放在用户私有目录。跨文件快照仍要求暂停/停服期间无其他写入者，不能对抗同用户的恶意并发篡改。

网关写请求的 Git 身份检查在独立工作线程中执行，固定只读 Git 参数、共享 3 秒检查预算和 1 MiB 输出上限保留；队列最多 32 个请求，总等待有界。读请求完全跳过 Git。critical 仓库的身份在该实例内固定并逐次复查；线程异常不自动重建或重新认定身份。网关退出会回收线程及等待请求。

候选仓库身份损坏只拒绝该候选写请求。critical 映射损坏或被替换时，相关写请求仍拒绝；无法证明与其无关的 Git 仓库按 critical 下限处理。无关的普通目录继续按其路径配置处理。正常注册的同仓库工作树仍继承 critical，显式降低配置不能覆盖它；独立克隆不因路径相似而继承。检查故障不会同步卡住健康检查和能力查询，也不会降级放行身份不明的写请求。
