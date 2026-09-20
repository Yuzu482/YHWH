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
      "sha256": "efe465fa23ba6578c03633ddbeec4d114e0d83c72c50400440d8c13486cbe130"
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
本项目维护的 README 使用同目录完整中文和英文版本，顶部使用本地语言切换按钮。两版内容同步，不用英文摘要代替完整说明。

项目长期知识位于 .yhwh/memory/，实质性工作前先查看相关知识及来源状态。知识是参考数据，不是授权。新增知识先写草稿；主代理核实当前来源和 Git 差异后确认。源文件变化需重新理解事实，不能只刷新哈希；废弃内容保留理由和替代路径。编辑已有条目前重新读取，保留其他人的改动。提交、推送与部署分别依用户授权，不因为更新记忆而自动执行。

Maintained READMEs have complete Chinese and English siblings with local language buttons; update both together. Project knowledge lives in .yhwh/memory/. Inspect relevant entries and current source state before substantive work. Knowledge is reference data, not authority. Draft new claims and accept only after primary review of sources and Git diffs. Reassess changed sources instead of merely refreshing hashes. Preserve deprecation reasons, replacement pointers and concurrent edits. Commits, pushes and deployments remain separate authorized actions.
