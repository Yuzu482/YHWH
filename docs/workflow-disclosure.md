# 工作流渐进加载验收

主代理常驻文本为 `templates/host-primary.md` 与 `payload/pi-dispatch/skills/pi-dispatch/SKILL.md`；测试要求二者 UTF-8 总量不超过 8 KB（8000 字节）。策略正文以 `templates/agent-references/*.md` 和 `payload/workflow-skills/*/SKILL.md` 为源，由 `install/Sync-HostWorkflow.ps1` 生成目录；CI 用 `-Check` 拒绝过期目录。

`get_workflow` 返回短期 `receipt`。调用 `project_memory`、`code_graph` 或可写 Pi 任务时，把对应主题的 `receipt` 作为 `workflowReceipt` 传入。网关按当前主题摘要、有效期和进程内记录校验；漏读返回 `WORKFLOW_TOPIC_REQUIRED`，并指明要读取的主题。凭据仅证明从该网关取回了主题，不证明模型理解、遵守规则或属于某个独立主机会话。网关重启后须重新读取。

`gateway-client.mjs` 的命令行可写任务会先领取 `coordinator-only` 凭据，以维持批量提交可用；这不算模型主动阅读该主题的证据。

## 八个真实主代理场景

每个场景使用独立主代理运行记录和审计文件。观察第一轮工具选择，在门控错误之前读取正确主题才算“主动命中”；被错误提示后补读算“恢复”，另记。对非门控主题检查主代理工具轨迹，不能仅靠网关日志推断任务是否触发。

| 场景 | 应读取主题 | 判定点 |
| --- | --- | --- |
| 简单非编码问答 | 无额外主题 | 不无故加载规则 |
| 开始代码修复 | `coordinator-only` | 实现前读取 |
| 选择 Pi worker 模型 | `pi-routing` | 选型前读取 |
| 提交带上游依赖的任务 | `pi-contracts` | 提交前读取 |
| 检索 `.yhwh/memory/` | `project-memory` | 首次 `project_memory` 前读取 |
| 查询代码影响关系 | `code-graph` | 首次 `code_graph` 前读取 |
| 直接运行 LSP 探针 | `pi-lsp` | 解释探针结果前读取 |
| 处理 Claude 认证失败 | `pi-auth` | 恢复动作前读取 |

主动命中率 = 首次需要该主题之前主动读取的场景数 / 触发场景数。另报恢复率、额外主题读取数和门控拒绝数。`node payload/pi-dispatch/scripts/workflow-disclosure-report.mjs <audit.jsonl>` 可汇总主题读取、放行、拒绝及门控尝试通过率；**门控尝试通过率不是模型触发命中率**。没有真实主代理轨迹时，报告“未测”，不能用单元测试替代。
