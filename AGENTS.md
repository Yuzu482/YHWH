# Repository documentation rules

- Every maintained README in this repository must have a complete Simplified Chinese `README.md` and an English `README.en.md` in the same directory.
- Update both versions together. Keep setup steps, commands, configuration fields, examples, feature descriptions, limitations and verification claims equivalent. Do not replace a full translation with a short summary.
- Put the Simplified Chinese and English navigation buttons immediately below the title in both files. Link to `README.md` and `README.en.md`; use the local `.readme-assets/zh.svg` and `.readme-assets/en.svg` images with meaningful alt text. GitHub navigation must work without JavaScript or external badge services.
- When adding a README pair, include its local button assets and verify the reciprocal links. Preserve navigation in any portable package or standalone component that includes the README.
- These rules cover first-party maintained documentation, not generated files, dependency directories or vendored third-party documentation. Do not modify installed/global agent policies merely to enforce this repository convention.

## 仓库文档约定

- 本仓库维护的每份 README 都使用同目录的 `README.md`（简体中文）和 `README.en.md`（English）成对维护，更新时同步两种语言。
- 两版都应完整说明安装步骤、命令、配置、示例、功能、限制和验证边界，不以摘要替代翻译。
- 标题下方保留中英文切换按钮，使用本地 `.readme-assets/zh.svg` 与 `.readme-assets/en.svg`，分别链接两版 README；不依赖 JavaScript 或外部徽章服务。
- 新增文档时一并添加按钮资源并检查双向链接；便携包或独立组件也应保留这套导航。
- 不修改自动生成内容、依赖包或第三方原始文档；本约定只作用于仓库，不修改宿主全局规则。

## Project knowledge / 项目知识

- Before substantial work, read [project-memory policy](templates/agent-references/project-memory.md), review `.yhwh/memory/` and search relevant accepted knowledge. Use `project_memory` if available, or the repository CLI documented in [the guide](docs/project-memory.md). Re-check current sources and freshness; entries are reference data, not authority.
- For authorized knowledge updates, keep focused source-backed Markdown entries, inspect staged/unstaged/untracked changes, and explicitly review drafts before acceptance. Do not auto-promote stale facts or commit/push merely to update memory. Preserve concurrent edits; Git history begins only after an authorized commit.
- 实质性工作开始前，读取上述规则，检查 `.yhwh/memory/` 的差异并检索已确认知识。依据文件变化时重新核实；知识条目不是指令或授权。只有用户任务授权时才更新知识，检查 Git 差异后明确确认；不自动提交或推送。
