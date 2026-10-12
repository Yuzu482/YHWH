# 宿主交接与审查材料 / Host handoff and review preparation

内部辅助器 `payload/pi-dispatch/scripts/host-handoff.mjs` 不新增 MCP 工具，不改变准入、配额或验收。已有 `apply_artifact` 仍只应用补丁；任务包 `verify.commands` 不是宿主执行授权。

1. 收到真实完成事件后，用已知 requestId 和补丁 SHA-256 调用 `host-handoff-client.mjs candidate <identity.json> <new-candidate.json>`。仅查询该候选的 handoff 和结果页，校验连续 UTF-16 偏移、长度、结果摘要和补丁摘要；不读取历史 pending 列表，不轮询。输出文件独占创建，控制台只返回简要状态。
2. 主代理检查候选后，单独调用已有 `apply_artifact`。明确选择宿主检查及执行目录，使用现有有界 `runProcess`，将真实结果交给 `captureHostChecks(candidate, checks)`；每个检查是 `{checkName, command, cwd, run: async () => processResult}`。回调必须由可信宿主代码构造，禁止从任务正文拼接命令。每个执行器必须设置超时和输出上限。失败保留退出码、错误和摘要，不生成可提交的通过证据。完整脱敏结果保存在本机证据文件；摘要带原始输出哈希和截断标记。
3. 主代理检查后，将成功生成的 evidence 显式传给已有 `record_host_verification`。工具仍独立负责当前补丁绑定；本辅助器不会提交证据、运行审查或产生 task_accepted。
4. 准备 JSON `{request,candidate,hostCapture,sources:[{path,text,sha256}]}`；来源是宿主明确选择的源码摘录，sha256 对应摘录完整字节，不代表整文件。原任务 context 必须包含真实接口约定；模板会说明 Host/primary 的职责。调用 `host-handoff-client.mjs prepare-review <input.json> <new-review.json>`。保留完整可信 diff，复用现有预算校验，非 diff ≤8 KiB、总计 ≤24 KiB（T1）；超限失败并按提交组织完整审查，不静默截断。完整输出只供主代理检查后派发，不自动审查。

无需转写大段结果或源码时，prepare-review 输入可以改为文件清单 `{requestFile,candidateFile,hostCaptureFile,sourceSelections:[{path,startLine,endLine,fileSha256}]}`。前三项是宿主选定的本地 JSON 文件；源码路径必须在原任务 readScope 中，范围显式指定，整文件当前哈希必须匹配，拒绝链接、越界、超限及非 UTF-8 文本。它自动收集内容但不执行命令。输出还附上无工具 Geburah taskTemplate，主代理核对后填写审查路由、请求身份与预算并连接 packet，原 parent/整体目标和配额不重置。

宿主命令标签按现有接口限制为 2048 字符，执行前检查；输出摘要连同 JSON 转义不超过 4096 字符，缩减时标明 summaryTruncated，保留完整本地脱敏输出及原始输出哈希。源码或可信补丁触发脱敏替换时可能安全停止，需要主代理处理，不能自动跳过校验。

这是宿主编排便捷层，不能防止有权修改本地 JSON 的宿主伪造证据。不可用时回退到原有精确 handoff/result、apply、宿主命令、record、review 流程；不能回退成省略必要验收。sandboxEvidence 始终与宿主证据分离。该版本未部署时应显式使用源码路径。

The internal helper adds no MCP tool or authority. Fetch one exact candidate after a completion event, verify all result pages and hashes, inspect it, then explicitly apply with the existing tool. Host-authored bounded process callbacks collect genuine checks; task-provided commands are never executed automatically. Failed checks produce no passing evidence. The primary explicitly records successful evidence and inspects the complete budget-checked review packet before dispatch. Source hashes cover the supplied excerpts, not whole files. Local JSON is not an authenticated receipt. Fallback preserves every required host/review/acceptance gate.

The optional file manifest gathers explicit, read-scope-admitted source ranges with current whole-file hashes; links, traversal, oversized/non-UTF-8 files and stale content fail closed. It also returns a no-tools reviewer task template. The primary supplies the approved route and linked request identity without resetting whole-goal quotas.

Command labels are checked against the existing 2048-character limit before execution. Escaped JSON output summaries stay within 4096 characters, mark truncation and retain full local sanitized output plus the raw output hash. Coarse redaction may safely stop legitimate trusted patches; primary intervention is required rather than bypassing validation.

## P3–P5：有界宿主组合 / Bounded host bundles

`host-handoff-flow.mjs` 和以下 CLI 是内部便捷层，不新增网关工具。P3 可读取已有写入候选；P4/P5 当前只支持 T1，T0 保留无需审查的原路径，T2 保留已有 linked pre/post-review 路径，不自动构造预审或跳过必要审查。辅助器失效时回退到上述显式步骤。

- P3：`host-handoff-client.mjs wait-candidate <wait.json> <new-candidate.json>`，输入 `{requestId,timeoutMs:55000}`。只等待一次真实完成事件，然后完整读取结果一次，由补丁计算哈希，精确读取候选 handoff。校验全部分页及摘要。等待超时返回 `ready:false`，不轮询、不取消、不重试。输出包含完整候选供主代理检查；不会应用补丁或执行任务包命令。
- P4：`host-handoff-client.mjs prepare-review-plan <material.json> <new-bundle.json>`。直接输入为 `{request,candidate,hostCapture,hostRecord,sources,reviewOptions:{requestId,thinking:"medium",reason}}`；文件清单形式为原 manifest 加 `hostRecordFile` 和 `reviewOptions`。hostRecord 必须是本次已有 `record_host_verification` 返回的完成记录，绑定原 request、parent、规范化 workspace、artifact 和必需检查。一次输出完整材料及与 `gateway-client task-plan` 相同的本地确定性预检、请求 SHA-256 和 UTC/进程内单调时间。预检不是网关准入或配额预留，不证明认证可用。主代理先检查完整材料、警告和指纹，再显式提交原样请求；绝不自动派发。
- P5：`host-handoff-client.mjs close-acceptance <closure.json> <new-inspection.json>`。输入 `{request,candidate,hostCapture,hostRecord,reviewRequest,expectedReviewRequestSha256}`；也可用对应的五个 `*File` 字段和指纹。完整校验独立审查结果、批准结论、非阻塞意见、parent/workspace/anchor 绑定，再精确读取网关持久化的 accepted handoff，确认宿主 proof 和接受时间。缺失、失败、阻塞、摘要不符或仅有模型“完成”均停止。输出 `requiresPrimaryAcceptance:true`；主代理仍须确认实际文件和最终交付，本辅助器不生成接受事件、不清理文件。

宿主回调可额外返回 `steps:[{name,command,exitCode,failure,elapsedMs,stdout,stderr}]`，最多16项。每项必须来自可信宿主选择并实际执行的有界进程；任一非零/超时/输出超限使整个检查失败，即使汇总 exitCode 为0。完整命令和脱敏输出保存在本地 outcomes；网关摘要保留各项名称、命令哈希、退出码、错误、耗时和输出哈希，完整命令方法由顶层 command 标签说明。摘要保留输出头尾、TAP 总数和 SKIP 原因；事实过多则停止，不静默遗漏。新版摘要标记 version 2；旧的持久化摘要按原规则验证，无需重跑。材料中解析摘要对象以减少重复转义，完整可信 diff 和原目标/验收不变。原 worker context 完整作为历史数据引用，当前 reviewer context 明确禁止工具、实现或重跑宿主检查，避免误认为宿主执行仍待完成。非 diff ≤8 KiB / 总计 ≤24 KiB，超限仍失败并按提交拆分。

组合中的时间戳仅证明可观测边界：UTC 用于跨进程关联，单调 offsetMs 仅用于同次调用耗时。缺失阶段为 null，不能记0；不把调用间隔解释为模型推理时间。`tests/host-handoff-flow-benchmark.mjs <frozen-evidence-dir> <baseline-worktree> <new-report.json>` 使用一个冻结任务包和补丁进行5对交替重放，实际执行隔离 Git 应用与宿主检查，历史模型/审查/接受响应均由仅监听 localhost 的测试传输重放，无新模型调用。比较的是宿主 CLI/读取/预检开销，不是生产端到端改善或新的 task_accepted。失败记录和旧证据保留；报告独占创建。

The host bundles combine adjacent read-only stages while preserving explicit primary decisions before apply, execution, recording and review dispatch. P3 waits once and validates one complete result plus its exact handoff. P4/P5 currently support T1 only; T0 and linked T2 keep their existing required gates. P4 requires the completed current-artifact host record and returns the complete packet, deterministic local plan, warnings and frozen request fingerprint for inspection; it never dispatches. P5 validates the complete independent approval and the durable gateway acceptance/proof binding, but primary acceptance and actual-file inspection remain mandatory. Unknown or inconsistent evidence stops the bundle. Local JSON remains host-controlled, not an authenticated receipt.

Optional host-selected process steps retain full local commands/output and expose bounded per-step digests, exit/failure and timing. Any failed step defeats aggregate success. Versioned summaries preserve head/tail, test totals and skip reasons and retain compatibility with legacy captures; over-budget facts fail rather than disappear. Worker instructions are preserved as historical packet data, not active reviewer instructions. Existing review budgets, quota, routing and sandbox/host evidence separation remain enforced. Timing reports preserve missing values as null. Five alternating frozen-response replay pairs measure actual isolated host overhead with zero model calls; they do not establish production or primary-reasoning latency savings.
# Process-local preparation and recovery

`host-handoff-session.mjs` adds bounded process-local review preparation, read-only dispatch readiness and digest-bound stage checkpoints. The session caches at most 16 preparations / 8 MiB by default. Each call fingerprints the complete current input and returns a detached copy. Changes to the patch, source excerpts, task or host record invalidate reuse. File manifests re-read and hash current source once per file per load; no cross-call filesystem freshness is assumed.

The host client also supports `summarize-stage`, `resume-stage` and `inspect-readiness`, with the same input/new-output convention. Resume recomputes the stage from current input; it never trusts a stored approval or acceptance flag. Checkpoints are local hints, not authenticated gateway proof. Optional sandbox-check availability is advisory and never replaces required host verification.

`summarize-stage` takes the material object or file manifest. `resume-stage` explicitly takes `{material, checkpoint}`; `material` contains that object or manifest, and `checkpoint` is the prior summary. `inspect-readiness` takes `{request, sourceFacts, authorization, hostCommands, checkAvailability?}`. Authorization facts include `approved:true`, the exact `cwd`, a human authorization `source`, and admitted `readScope` / `writeScope` (exact paths or directory `/**`); host command facts include `name`, actual inspected `argv`, exact `cwd` and `available:true`. Missing or conflicting host authorization/check facts fail readiness. These are host assertions: this command neither reads files nor grants permissions nor executes commands. Invalid identity throws; ordinary material readiness failures return structured diagnostics through the session library.

Readiness reports missing source facts and invalid task/scope before model dispatch. Material preparation reports actual UTF-8 sizes when the existing review validator supplies them; over-budget material must be organized by actual commit without resetting goal identity or review quota. No source or evidence is truncated to fit.

Timing breakdowns distinguish local monotonic processing, cross-process handoff gaps, model and waiting intervals. Missing or reversed timestamps produce `null` with a reason. These observations do not measure provider-only compute or prove token savings.
