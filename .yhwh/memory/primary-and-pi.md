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
      "sha256": "c593d4a26b35ea2f35f39e68d154dd70024865685835c4a7662569209cd61c88"
    },
    {
      "path": "templates/host-primary.md",
      "sha256": "2b6334c0f8cade013e26a76baeee0fc43f44769b4a032bf8b0342f203552a21a"
    }
  ],
  "sourceCommit": "ebe7a3a168f3c1af543b4aff2b1edf5d8b4df219",
  "reviewedAt": "2026-09-20"
}
---
主代理负责意图、授权、拆分、整合和最终验收。Pi 提供受控下级模型调用与确定性工具；调用通过并不证明宿主执行了完整治理链。源码默认 worker 是 Luna/max，reviewer 是 Sonnet 5/max 且 access:none；部署可能保留宿主特定认证适配，实际派发前必须读取当前能力与路由规则。

MCP 是客户端接入边界。共享连接仍只访问运行服务配置的工作根目录，不会自动传输远程客户端文件。主代理的文件编辑、知识确认和外部发布权限仍由宿主与用户决定。

The primary owns intent, authorization, decomposition, integration and final acceptance. Pi provides governed lower-agent execution and deterministic tools; successful invocation does not prove full host governance. Source defaults bind workers to Luna/max and reviewers to Sonnet 5/max with access:none. Installed services may retain host-specific authentication adapters; discover live capabilities and routing before dispatch. Shared MCP connections remain confined to configured runtime roots and do not automatically transfer remote files. Host permissions and user authorization govern edits, knowledge acceptance and publication.
