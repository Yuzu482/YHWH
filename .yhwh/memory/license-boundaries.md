---
{
  "schemaVersion": 1,
  "id": "license-boundaries",
  "kind": "decision",
  "status": "accepted",
  "title": "自有代码与第三方许可边界 / First-party and third-party licensing boundaries",
  "tags": [
    "许可",
    "Apache-2.0",
    "MIT",
    "LSP",
    "license"
  ],
  "sources": [
    {
      "path": "NOTICE",
      "sha256": "ae0c1b3cfbd22f0082a306edbdf0daf844fd32cb0c5d1bd5e86571c4a63966a3"
    },
    {
      "path": "docs/lsp-component.md",
      "sha256": "223f674b3ea71b909edb084f20a463e5310802df31633102e1abfe7fc20f8838"
    }
  ],
  "sourceCommit": "57a12b63ff0c0ba849af0a663ac70daf706d00f7",
  "reviewedAt": "2026-09-20"
}
---
YHWH 自有代码、文档和配置采用 Apache-2.0；第三方代码、依赖、摘录与通知保留各自许可证。不能用项目自己的声明替代第三方通知。

LSP 文档记录 multilspy 及其依赖通知，同时仍保留旧 pi-lsp-extension 的结构查询和兼容路径。接入 multilspy 或自有 Pi 适配器本身，不表示旧组件已被移除或其上游许可缺口已解决。发布前重新核查实际依赖清单、许可文本和公开发布检查；此条不构成当前上游许可状态或发布资格的证明。

YHWH original code, documentation and configuration use Apache-2.0. Third-party code, dependencies, excerpts and notices retain their own licenses. The LSP documentation retains multilspy notices while legacy pi-lsp-extension structural and compatibility paths remain. Adding multilspy or the first-party Pi adapter does not itself remove the legacy component or resolve its upstream notice gap. Recheck actual inventories, notices and public-release validation before publishing; this entry does not establish current upstream licensing status or release eligibility.
