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
