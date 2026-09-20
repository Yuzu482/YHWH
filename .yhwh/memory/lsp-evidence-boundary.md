---
{
  "schemaVersion": 1,
  "id": "lsp-evidence-boundary",
  "kind": "architecture",
  "status": "accepted",
  "title": "LSP 快照与证据边界 / LSP snapshot and evidence boundaries",
  "tags": [
    "LSP",
    "缓存",
    "multilspy",
    "性能",
    "cache"
  ],
  "sources": [
    {
      "path": "docs/pi-lsp-adapter.md",
      "sha256": "5d0a57237f1aaf234e9bdf066e60f04764d7d3b3a58d7e15ad1872c8db841e6a"
    },
    {
      "path": "payload/pi-dispatch/scripts/lsp-sandbox-broker.mjs",
      "sha256": "74c265de6bc39351bb83b7b71d8cefefda9cbab91d20fc75d46381db04a3ad31"
    }
  ],
  "sourceCommit": "57a12b63ff0c0ba849af0a663ac70daf706d00f7",
  "reviewedAt": "2026-09-20"
}
---
确定性语义探针通过 multilspy 和预装语言服务器运行；它不是模型推理。Pi 任务中的自有适配器复用同一任务内、未变化文件的隔离快照。文件变化需更新快照；空闲或任务结束后清理。因此这不是完整项目索引，也不是跨任务长期知识库。

解释诊断时核对实际状态、后端、诊断完成证据和清理结果。工具成功返回诊断不等于代码通过，单文件空诊断不等于项目编译成功。冷启动与暖调用的测量应分开，并记录语言、操作和夹具；不要把某次小文件耗时当作长期性能保证。

Deterministic semantic probes use multilspy and installed language servers without model reasoning. The Pi adapter reuses unchanged isolated file snapshots within a task, refreshing on changes and cleaning up after idle/task completion. This is neither a full-project index nor cross-task knowledge memory. Check actual status, backend, diagnostic completion evidence and cleanup. Returned diagnostics do not imply correct code, and empty single-file diagnostics do not prove a project build. Separate cold and warm measurements and identify the language, operation and fixture; one small-file benchmark is not a durable performance guarantee.
