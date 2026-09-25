# 协作式小任务包

YHWH 可把一个目标编译为 2–4 个独立的 Pi 子任务。同一组任务使用相同的 `parentRunId` 和目标摘要；每个子代理只收到自己的目标、验收条件、上下文和文件范围。写入范围必须互不重叠，网关继续负责资源配额、并发和写入锁。规划不会调用模型，也不会提交任务。

在仓库根目录准备 JSON 文件，例如：

```json
{
  "cwd": "E:\\Projects\\Example",
  "parentRunId": "feature-20260925-01",
  "runGoal": "完成两个互不依赖的模块",
  "runAcceptance": ["两个模块分别验收通过"],
  "units": [
    {"id":"api","objective":"实现 API 模块","acceptance":["API 检查通过"],"context":[],"readScope":["src/shared.mjs"],"writeScope":["src/api.mjs"]},
    {"id":"ui","objective":"实现 UI 模块","acceptance":["UI 检查通过"],"context":[],"readScope":["src/shared.mjs"],"writeScope":["src/ui.mjs"]}
  ]
}
```

`cwd` 必须是网关允许的绝对工作目录；文件范围使用精确的仓库相对路径。可为整个运行指定可选的 `thinking`：`low` 或 `medium`；默认是 `medium`。此规划器面向规模较小、固定 120 秒时限的运行，不接受 `high` 或 `max`。`low` 仅适用于低风险且任务明确细小的工作；此前的对比结果只能作为提示，不能证明 `medium` 必然能避免输出格式错误。选择不同的 `thinking` 值会产生不同的稳定请求 ID。先查看计划，再从有权访问本机网关的终端提交：

```powershell
node payload/pi-dispatch/scripts/gateway-client.mjs cooperative-plan .\spec.json
$env:PI_GATEWAY_CONFIG = Join-Path $HOME '.local\state\pi-kether\gateway-silent.json'
node payload/pi-dispatch/scripts/gateway-client.mjs cooperative-submit .\spec.json
```

提交返回每个子任务的稳定请求 ID，而不是最终结果。通过现有 `list_subagents` / `get_subagent_result` 查看完成状态与完整结果。若部分回执失败或不确定，先按原请求 ID 核对网关状态；不要换 ID 自动重试。同一规范再次提交会复用稳定 ID。

编译器限制单元目标、上下文与验收条目长度，并限制每单元最多两个写入文件和请求大小。它不会自动分解模糊的大任务、共享完整对话、合并补丁或替主代理验收，也不声称形成了完整的 v2 阶段交接链。需要阶段依赖时仍由主代理使用现有 typed handoff；并行编码只适用于独立文件所有权。当前源码命令行已做两项只读任务的实时并发验收；已安装插件的同名命令行文件需另行同步，其他复杂写入任务尚未实机验收。
