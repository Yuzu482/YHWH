# 受限 worker 检查工具方案（等待决定）

这是任务包 2.5 的设计方案，不是已实现功能。当前不增加执行工具、不修改任务 schema、沙箱、缓存或权限。只有用户批准实施后，才安排独立前评审和 worker 开发。

## 目标与接口方向

拟议工具名为 `yhwh_run_check`，只在已有 WSL 沙箱内对 Chesed 开放。任务包中的 `verify.commands` 是未来协议字段，当前网关不支持；实施时需要版本化 schema、校验器、能力描述和测试一并变更。

宿主先为检查分配稳定命令 ID。工具接收 ID，不接收 shell 字符串、可执行路径、任意环境变量或任意 argv。执行条件是任务批准的命令集合与项目宿主管理白名单的交集，必须精确匹配命令参数、目录和适用源码/依赖版本。网关保存白名单及任务计划的摘要，worker 不能扩展集合或覆盖白名单。

示例候选类型是指定测试文件、TypeScript 无输出类型检查，以及指定路径的 pytest。不得通过 `npx` 自动下载工具；使用已准备缓存中的固定入口。`npm test` 等项目脚本可能运行任意仓库代码，白名单只是选择限制，安全隔离仍必须由沙箱保障。

## 隔离保证

继续采用 WSL2 + Bubblewrap 的现有文件范围、无网络、内存/CPU/PID 限制及进程清理。执行采用直接 argv 和固定工作目录，不进入 shell。移除认证和网关环境变量，检查进程不得继承模型凭据管道、编辑器桥接或网关令牌。

依赖和基础源码只读挂载；经批准的 worker 写入范围仍按既有策略处理。测试临时目录、编译缓存和报告只允许写入本次任务的私有目录。必要的编译产物目录必须在前评审中列明，不能借测试获得工作区全写权限。禁止宿主路径、符号链接和硬链接逃逸。

每条命令和整项任务都有时间上限，仍受原执行预算约束，并为交付/清理保留时间。限制输出大小和进程数；超限、取消或超时终止整个检查进程树，等待退出并记录清理结果。任一清理不确定都不能记录为通过。输出脱敏，审计只保留命令 ID、固定 argv 摘要、退出码、用时和有界摘要。

## 依赖缓存

由宿主在独立、明确批准的联网准备步骤构建缓存，固定运行时、锁文件和依赖版本，记录来源及完整性摘要。worker 不安装包、不更新锁文件、不联网修复缓存。

按项目、运行时版本和锁文件摘要分区缓存，只读共享给任务。包管理器需要写缓存时复制到任务临时层，不写共享缓存。缓存缺失或不匹配则明确返回能力不足；禁止自动切换到宿主或联网执行。缓存来源校验、保留、磁盘配额和更新由宿主负责。

## 白名单维护与结果可信度

项目维护者通过受审查的宿主配置维护白名单，主代理可提出候选，但 worker 不能审批自己的命令。变更白名单属于执行权限变更，需要单独授权和前评审。绑定固定入口与运行时；对包管理器脚本记录实际解析后的脚本/配置摘要，出现漂移时拒绝执行。

执行结果由工具形成结构化证据，绑定 requestId、任务/命令摘要、源码基线、输出摘要和清理结果。模型不能用自由文本伪造通过。工具 exit 0 也不自动代表任务所有验收条件满足；网关及主代理仍检查运行范围、检查覆盖和后续独立审查。

## 回退到宿主验证

工具不可用、缓存缺失、预算不足或检查无法在只读依赖条件下运行时，保留合规补丁并进入 2.3 的 `awaiting-host-verification`。该状态不满足依赖，也不算通过；主代理实际执行检查后，经 `record_host_verification` 记录证据，再转为 completed 或 failed。

不得更换 access、关闭隔离或扩大执行白名单来规避失败。真实检查失败交回同一 worker 修复；宿主重新运行并记录证据。外部资源、设备/UI 或部署检查继续由宿主承担。

## 后续实施验收

批准后应覆盖：不在白名单的命令、注入参数、路径逃逸、凭据继承、缓存/源码漂移、超时、输出/PID 超限、进程树清理、无网络和结果伪造的拒绝测试；并验证正常检查及宿主回退链路。需要独立前后审查、完整测试、内存回归、构建和安装验收。

建议先继续使用 2.3 的宿主验证流程；待其稳定后再决定是否实施本工具。即使获准，也先只支持一个项目的一组固定检查，不默认对所有仓库开放。

## English summary

Proposal only; no execution tool or permission has been added. A future `yhwh_run_check` would accept host-approved command IDs within the existing WSL sandbox, with exact project allowlists, no network or credentials, read-only verified dependency caches, bounded resources and complete process cleanup. Host-maintained policies and gateway-generated evidence prevent workers from expanding authority or fabricating passing checks. Missing capability falls back to `awaiting-host-verification`. Implementation requires an explicit user decision, independent reviews and full acceptance checks.
