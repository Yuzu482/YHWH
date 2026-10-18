# 宿主证据 P1

内部辅助函数，不是 MCP API，不应用补丁、执行命令、写账本或接受任务。

- `projectHostEvidence({dispatches,events,hostRecords,until})`：输入宿主已读取的选定派发、审计及 pending/attestation；按 request、workspace、parent、artifact/record 哈希关联。默认拒绝缺 parent/workspace 的事件；历史回放仅在宿主证明该 request/artifact 完整身份索引及 pending 后显式传 legacyScopeComplete:true 才可关联；跨派发或 pending 出现不同身份或重复绑定即 conflict，缺 pending 不能绑定。abandon 须绑定唯一有效 pending；完整性冲突留 unknown/conflict。操作 completed 不是任务 accepted。正式宿主失败也计首次验证，缺失不填零。`accepted-recorded` 是审计投影，不是验收权限。
- `captureFrozenPatch(files)`：每项显式传入 path、before/after UTF-8 文本（不存在为 null）及各自 SHA256。生成按路径排序的全文件 unified diff，默认 git apply -p1 可用；不经过模型誊写。保留 CRLF 和文件末尾换行；二进制、无效路径、空文件模式变更、超既有4MiB预算均拒绝。调用者仍须核查授权范围与基线；哈希不是授权。返回工件后仍需显式应用、宿主检查、记录和审查。
- `verifyFrozenPatch(patch,files)` 校验捕获工件字节。它要求相同规范 diff，不证明其他 diff 布局语义不等价。Git 的 autocrlf/attributes 仍可能改写应用后的字节；`verifyFrozenFiles(files,actualFiles)` 必须核对宿主重新读取的完整文件（path/text/sha256），不匹配即拒绝。`prepareHostReview` 提供 frozenSources 时必须同时提供 capturedFiles 并通过两项校验；省略时保持原流程，不得声称与冻结源码一致。
- `inspectCheckCoverage(changedFiles,commands,facts)` 将显式 inspected 的 path/commandIds 关联列为 declared-only；无事实则 unknown，不从 presentation 通过推断 Python/浏览器覆盖，也不把可选沙箱检查缺失当宿主不能验收。

定向测试包括20条状态回放、两次失败、身份/指纹漂移、git默认应用、真实离线Python入口和隐藏面板/短屏浏览器fixture。浏览器测试用显式 `YHWH_TEST_PLAYWRIGHT_MODULE` 指定现有 Playwright 模块；未提供则记录 skip，不安装依赖或更改白名单。fixture通过不证明生产页面或历史补丁通过。
