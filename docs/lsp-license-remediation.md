# LSP 上游许可证补齐记录

[English](lsp-license-remediation.en.md)

## 当前结论

2026-09-19 核查：`pi-lsp-extension@1.3.0` 的包元数据和 README 声明 MIT，但未找到完整版权与许可通知。此记录补充来源证据，不代上游授权，也不宣布整个产品完成合规审计。公开发布检查继续阻断。

## 已核查的证据

- [固定版本 package.json](https://github.com/samfoy/pi-lsp-extension/blob/5edc932d325b630483f84f7d7f038e88ceba1eba/package.json) 与 [README](https://github.com/samfoy/pi-lsp-extension/blob/5edc932d325b630483f84f7d7f038e88ceba1eba/README.md)：声明 MIT。
- 从 npm 官方 registry 重新下载 1.3.0 原始包；53 个文件，无许可/版权通知类文件，SHA-256 与已保存证据一致。仅在内存检查压缩包，未安装或执行包内容。
- 当前主分支固定在 `f2433d19c3bb1300dfdc5f4505b062f9c9c0a1a6`，含 65 个可达提交；下载的全部分支与标签共有 66 个可达提交。历史路径中未找到 `license|licence|copying|copyright|notice`（不区分大小写）。这不覆盖已删除或未获取的引用。
- 固定版本和当前主分支内容中未找到 `copyright|permission is hereby granted|MIT License`；排除锁文件。此为定向搜索，不是所有历史文件内容的逐行审计。
- GitHub API 返回的 13 条开放/关闭 Issue 与 PR 标题未见许可证问题；未穷尽全部评论。

具体散列、文件清单、固定链接与检查范围见 [机器可读证据](../licenses/pi-lsp-extension-evidence.json)。GitHub 账户名、提交作者和标准 MIT 模板均不被用来推定版权主体。

## 上游需要提供什么

1. 由项目所有者确认版权主体及年份，提交完整 MIT 许可与版权通知。
2. 明确该通知是否覆盖已发布的 1.3.0 及固定源码提交；若只覆盖后续版本，YHWH 需升级依赖并重新验证补丁。
3. 在下一次 npm 发布中包含许可证文件，并检查实际打包结果。

[英文请求记录](upstream-lsp-license-request.md)已在用户授权后提交为 [上游 Issue #14](https://github.com/samfoy/pi-lsp-extension/issues/14)，并回读验证正文一致。请求只包含公开上游事实；许可证及版本覆盖仍待上游确认。

## 收到上游确认后的接入步骤

1. 原样保存通知到 `licenses/`，登记固定提交链接与 SHA-256；保存明确的版本适用依据。若通知晚于 1.3.0，仅有当前 LICENSE 不足以证明它覆盖旧版本。
2. 更新 `licenses/sources.json`、证据中的 `upstreamNotice`（`file`、`source`、`sha256`），并在来源与版本覆盖人工核验后将状态改为 `upstream-notice-verified`。标准模板不可作为该材料。
3. 同步更新中英文第三方说明、LSP NOTICE 及安装补丁生成的 `YHWH-PATCH-NOTICE.txt`，保留修改说明，移除已经解决的待确认描述。
4. 将新通知加入 `install/license-inventory.mjs` 的独立插件通知列表，重新生成 `THIRD_PARTY_NOTICES.txt`；验证新通知进入源码包、便携包和一键安装包。现有生成器不会仅凭新增 `upstreamNotice` 字段自动加入文本。
5. 执行 `node install/license-inventory.mjs --check --public` 及打包检查。散列与状态检查不是法律或来源判断的替代品；不得只修改状态来放行。
6. 为更新后的材料发布新版本。现有 v0.8.0 发布资产保留原样，不在相同标签下静默替换。

[MIT 标准条文](https://opensource.org/license/mit)要求保留版权与许可通知；本仓库的标准文本仅用于参考。
