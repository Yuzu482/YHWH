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
      "sha256": "773462d23993f1830ae2206eb25f6bb8d1d8e32dcc78eab3c4ac8f81fe246449"
    },
    {
      "path": "templates/host-primary.md",
      "sha256": "44c06cb0ccddd857babe92352dfac492c2670d2330a33e7578867e0d00b54037"
    }
  ],
  "sourceCommit": "57a12b63ff0c0ba849af0a663ac70daf706d00f7",
  "reviewedAt": "2026-09-20"
}
---
主代理负责意图、授权、拆分、整合和最终验收。Pi 提供受控下级模型调用与确定性工具；调用通过并不证明宿主执行了完整治理链。源码默认 worker 是 Luna/max，reviewer 是 Sonnet 5/max 且 access:none；部署可能保留宿主特定认证适配，实际派发前必须读取当前能力与路由规则。

MCP 是客户端接入边界。共享连接仍只访问运行服务配置的工作根目录，不会自动传输远程客户端文件。主代理的文件编辑、知识确认和外部发布权限仍由宿主与用户决定。

The primary owns intent, authorization, decomposition, integration and final acceptance. Pi provides governed lower-agent execution and deterministic tools; successful invocation does not prove full host governance. Source defaults bind workers to Luna/max and reviewers to Sonnet 5/max with access:none. Installed services may retain host-specific authentication adapters; discover live capabilities and routing before dispatch. Shared MCP connections remain confined to configured runtime roots and do not automatically transfer remote files. Host permissions and user authorization govern edits, knowledge acceptance and publication.
