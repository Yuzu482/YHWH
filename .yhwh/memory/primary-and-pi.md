---
{
  "schemaVersion": 1,
  "id": "primary-and-pi",
  "kind": "architecture",
  "status": "accepted",
  "title": "主代理与 Pi 的职责 / Primary and Pi responsibilities",
  "tags": [
    "架构",
    "主代理",
    "Pi",
    "architecture"
  ],
  "sources": [
    {
      "path": "payload/pi-dispatch/scripts/gateway.mjs",
      "sha256": "8cdd9100ca871f9802982f7addd8ac894e6fa7f0153f820d5c15257f1df8a605"
    },
    {
      "path": "templates/host-primary.md",
      "sha256": "21d0747d988365fb94b9ae75f0edd56a5b23e1c2fae6fcfc19562faee4907079"
    },
    {
      "path": "templates/agent-references/pi-routing.md",
      "sha256": "e62c0415af212156fca9f886c74a1a0db68d8632b4e2491233cbf8bb2841107f"
    },
    {
      "path": "payload/pi-dispatch/scripts/provider-policy.mjs",
      "sha256": "8a032094614afba1329a49170bb86322376d15ba1cd5fc1994317a0830904a5e"
    }
  ],
  "sourceCommit": "b914f228dfc1726d337e7cbe8dca0be08eac9e25",
  "reviewedAt": "2026-10-04"
}
---
主代理负责意图、授权、拆分、整合和最终验收。Pi 提供受控下级模型调用与确定性工具；单次调用成功不证明宿主完成了整条治理链。当前默认 worker 为 openai-codex/gpt-6-luna，按任务复杂度选择思考级别，默认 medium；reviewer 为 claude-code-cli/claude-sonnet-5、access:none，本发布分支的默认思考级别为 max。已部署的新版宿主策略可能采用 medium/high/xhigh；派发前必须读取实时能力与适用路由规则，不能以本分支替代已部署服务的约定。

主代理先核对任务包的合法复杂度字段、当前阶段验收、接口、精确文件范围和验证执行者，再提交。规划完成与未来实现检查分开记录；未执行的未来检查不能冒充通过。实现由 Pi 编写，主代理检查补丁、执行宿主验证并验收。T0/T1/T2 的阶段、审查次数和权限边界仍依宿主规则。

派发前约定最终检查名和执行者；每一项未执行的宿主检查都要在自身证据中说明真实执行限制。交付观察放入 evidence/changes，不随意增加未分配执行者的检查。有效补丁因验证元数据不一致被拒绝，与补丁内容错误分开诊断；后续修复不改写原始失败，也不伪造宿主验收。

共享 MCP 连接只访问服务配置的工作根目录，不会自动传输远程客户端文件。知识确认、凭据、部署和外部发布权限依宿主与用户授权。这次指纹对应已复核的当前工作文件；sourceCommit 仅记录当时 HEAD，不证明这些改动已经提交。

The primary owns intent, authority, decomposition, integration and acceptance. Pi provides governed workers and deterministic tools; one successful invocation does not attest the entire host workflow. Current default workers use openai-codex/gpt-6-luna with task-proportional thinking (medium by default). Reviewers use claude-code-cli/claude-sonnet-5, access:none, max by default in this publication branch. A newer deployed host policy may select medium/high/xhigh; discover live capabilities and the applicable routing policy before dispatch rather than inferring deployed settings from this branch.

Validate packet assessment, stage acceptance, interfaces, exact scopes and verification ownership before submission. Completed planning does not claim future implementation checks passed. Pi authors implementation; the primary validates patches and host evidence under the applicable tiers. Shared MCP stays within configured roots. Host/user authorization governs knowledge acceptance, credentials, deployment and publication. Fingerprints describe reviewed working files; sourceCommit records HEAD rather than committed-content proof.

Agree final check names and execution owners before dispatch. Each unrun host check states its real execution limitation in its own evidence. Delivery observations belong in evidence/changes; avoid inventing checks without assigned execution. Distinguish verification-metadata rejection from incorrect source changes. Later repairs preserve original failures and never fabricate host acceptance.
