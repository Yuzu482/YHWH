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
