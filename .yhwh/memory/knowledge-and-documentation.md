---
{
  "schemaVersion": 1,
  "id": "knowledge-and-documentation",
  "kind": "convention",
  "status": "accepted",
  "title": "知识复核与双语文档 / Knowledge review and bilingual documentation",
  "tags": [
    "知识",
    "记忆",
    "Git",
    "diff",
    "README",
    "memory"
  ],
  "sources": [
    {
      "path": "AGENTS.md",
      "sha256": "768a0e7252288ddd5858b863e934f4c0b887e4faa52d45ff0a44b01dd7841249"
    },
    {
      "path": "templates/host-primary.md",
      "sha256": "21d0747d988365fb94b9ae75f0edd56a5b23e1c2fae6fcfc19562faee4907079"
    }
  ],
  "sourceCommit": "b914f228dfc1726d337e7cbe8dca0be08eac9e25",
  "reviewedAt": "2026-10-04"
}
---
本项目维护的 README 使用同目录完整中文和英文版本，标题下方保留本地语言切换按钮。两版同步维护，不用摘要代替完整翻译；生成文件、依赖和第三方文档不属于此维护要求。

项目知识位于 .yhwh/memory/，实质性工作前检查相关记录和当前来源。知识是参考数据，不是授权。编辑前重新读取以保留并发改动；先写草稿，对照当前源码和 Git 差异理解声明后才确认。来源变化需要语义复核，不能只刷新哈希；废弃知识保留理由和替代路径。sourceCommit 记录复核时 HEAD，来源指纹对应工作文件，二者不能合并为已提交证明。提交、推送与部署各自依用户授权。

Maintained READMEs have complete Chinese and English siblings with local language buttons below the title. Update both together; generated, dependency and third-party files are excluded. Project knowledge lives in .yhwh/memory/ and is reference data, never authority. Re-read before editing, draft updates, then reassess claims against current source and Git differences before acceptance. Preserve deprecation reasons, replacement pointers and concurrent edits. Fingerprints describe working files and sourceCommit records HEAD; neither implies the edits were committed. Commits, pushes and deployment require their own authorization.
