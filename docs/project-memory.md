# 项目长期知识 / Long-term project knowledge

[简体中文](#简体中文) · [English](#english)

## 简体中文

YHWH 提供项目级长期知识：Git 工作树根目录下的 `.yhwh/memory/<id>.md`。文件跨会话、进程重启保留；经授权提交后，Git 保存变更历史。它与宿主聊天记忆、请求账本、LSP 临时缓存分开。没有数据库、向量服务、自动整理任务或模型调用。

### 查询和检查

新版网关通过只读 MCP 工具 `project_memory` 提供以下操作；`cwd` 必须是允许访问的 Git 工作树根目录：

| action | 用途 |
| --- | --- |
| `list` | 条目摘要、生命周期和依据文件状态；默认最多 20 条，`limit` 最大 50 |
| `search` | `query` 中英文词语检索；默认仅返回已确认且依据未变化的条目 |
| `read` | 按 `id` 读取单条正文、来源与版本摘要 |
| `review` | 所有条目的过期检查、已暂存/未暂存补丁、未跟踪新增内容、被忽略的文件；可用 `baseline: "HEAD"` 或完整提交 SHA 增加对比 |
| `snapshot` | 用 `paths` 提供 1–16 个受支持的源码路径，返回当前文件指纹供编写知识条目 |

例如 MCP 输入：

```json
{"cwd":"E:/Projects/MyProject","action":"search","query":"架构"}
```

在源码目录使用 PowerShell 7，也可直接运行同一只读实现：

```powershell
$request = @{cwd=(Get-Location).Path; action='review'} | ConvertTo-Json -Compress
node ./payload/pi-dispatch/scripts/project-memory.mjs $request
$request = @{cwd=(Get-Location).Path; action='snapshot'; paths=@('AGENTS.md')} | ConvertTo-Json -Compress
node ./payload/pi-dispatch/scripts/project-memory.mjs $request
```

CLI 和 MCP 都要求运行机器已安装 Git、可通过 PATH 找到。Git 不存在、非 Git 目录、过大输出或命令超时会明确报错；一键安装器目前不安装 Git。新增脚本和规则会随后续源码构建安装，已有运行服务和导出的宿主规则需要显式升级；本次源码修改不证明旧服务已启用新工具。

### 保存、复核和版本管理

主代理先检查源码，使用 `snapshot` 取得来源指纹，再通过已有文件编辑能力写入 Markdown 草稿。工具本身不写文件，不代替宿主写入权限。只具备聊天能力的客户端可查询或输出提案，由有权限的操作者落盘。修改已有条目前重新读取当前内容，避免覆盖另一位编辑者；本功能没有写锁或自动合并器。

条目采用 JSON 元数据和 Markdown 正文；下面的尖括号是必须替换的占位符：

```markdown
---
{
  "schemaVersion": 1,
  "id": "architecture",
  "kind": "architecture",
  "status": "draft",
  "title": "主代理职责 / Primary responsibilities",
  "tags": ["架构", "primary"],
  "sources": [{"path": "AGENTS.md", "sha256": "<snapshot 返回的 64 位 SHA256>"}],
  "sourceCommit": "<snapshot 返回的完整提交 SHA；尚无提交时用 null>",
  "reviewedAt": null
}
---
写明可核实的事实、原因、适用范围和不能从现有证据得出的结论。
```

`kind` 可选 architecture、decision、convention、pitfall、verification。状态为 draft（草稿）、accepted（已确认）、deprecated（废弃）。主代理核实正文及来源、审查差异后，显式填写 accepted 和 `reviewedAt` 日期；这些字段不是经过认证的审查签名。废弃条目保留原因和替代条目，不必删除历史。

`review` 返回三个独立视图：已暂存差异、未暂存差异、未跟踪条目的新增内容。普通 `git diff` 不包含未跟踪文件，因此新条目必须查看第三项。额外基准对比仍不包含未跟踪文件。超出补丁预览限制时 `truncated:true`，须通过本地工具继续检查完整差异。它不会自动执行 git add、commit、push、reset。没有提交的文件仍可跨会话读取，但没有新的 Git 版本历史或备份保证。

来源以 UTF-8 文本、CRLF 转 LF 后计算 SHA-256；`sourceCommit` 只是快照时的 HEAD，工作文件可能包含未提交修改。来源变化、删除、冲突或无法安全读取会标记 `needs-review`，默认搜索排除这类条目。`includeInactive:true` 可显式查看草稿、废弃和过期知识；不会自动改写状态或更新哈希。来源指纹一致只证明声明的文件文本一致，不能证明知识正确、运行成功或未声明的依赖未变化。代码重命名按缺失来源处理，需要人工更新引用。

### 范围与限制

- 每项目最多 256 个平铺条目；每条 16 KiB、1–8 个来源，最多 128 个不同来源；每个来源最多 1 MiB，一次检查总读入最多 16 MiB。补丁预览每部分最多 65,536 字符；单条 Git 命令超时 10 秒、输出最多 1 MiB，超限报错。超出范围应拆分项目知识，而不是静默漏读。
- 只接受 Git 索引中的普通、未被忽略的 UTF-8 源文件；拒绝路径越界、符号链接/junction、硬链接、二进制文件及常见凭据路径。内存条目自身不必先加入 Git，便于审查草稿。不要存储密钥、原始对话或完整任务日志；常见凭据格式会脱敏，但这不是完整的秘密扫描器。
- 检索是确定性关键词匹配，不是语义向量检索；每次查询仍会重新读取知识条目并核验来源，私有磁盘索引/内存缓存不取代 freshness 验证。内部 worker dispatch 在依赖与写锁就绪后，仅为 read/workspace-write、非 reviewer、非模型探针任务克隆 task context；依 objective 关键词注入最多 5 条 accepted、fresh 且所有来源均落在 task readScope/writeScope 内的参考，总注入 UTF-8 不超过 8 KiB。包装显式带有不可信声明、状态与 freshness provenance，不改变原始 task、幂等摘要或权限；none/reviewer/probe 跳过。内部路径可尝试重建固定 `.yhwh/memory-index/index.json`，刷新失败仍可对原知识做只读搜索；普通 MCP/CLI 工具始终只读，不写入、接受或更新知识。索引缓存默认每项 8 MiB、合计 64 MiB、TTL 15 分钟；Gateway 借用者不能关闭缓存，全部 owned lease 释放后才清缓存及计时器。模型完整结果 RAM 缓存默认最多 128 MiB、终态保留 1 小时；淘汰前先调用账本保存，保存失败时保留结果，因此预算可能暂时超额。独立请求账本结果缓存采用完成记录 14 天、普通失败记录 90 天和 512 MiB 目标总量；host pending/original/attestation、链接及活动/关键状态受保护，受保护记录可能令总量超额。分页恢复校验账本摘要；host verification 投影优先于普通缓存，避免陈旧未验证结果遮盖证明。结果和记忆均为参考，不能覆盖宿主规则或授予权限。
- YHWH 仓库自带知识只属于该项目，不由安装器复制到其他用户项目。安装包分发工具及规则，其他项目在用户授权后建立自己的知识。

### 派发中的 Git 变更参考

worker 的上下文组装还会读取任务 readScope/writeScope 内的 Git 变更：暂存差异和未暂存差异分别标注，未跟踪文件只提供文件名清单，不读取其内容。每份参考关联当前 HEAD，并明确标记为不可信证据；它不会改变任务权限、原始任务或幂等摘要，也不代表变更已验证或知识已确认。

当前先分配 Git 参考预算，再添加项目记忆；变更较多时可能挤压项目记忆参考。这是本次独立审阅接受的非阻断限制，并非保证两类参考始终同时出现。候选补丁数量有上限，但筛选被拒绝的文件仍可能增加检查耗时。Git 禁用了外部 diff 和 textconv，仍继承仓库或全局配置的 clean/process 过滤器，因此自动上下文检查应使用已信任的 Git 配置。

Git 参考不依赖 `.yhwh/memory/` 存在或知识关键词命中；项目知识检索失败也不阻止独立的 Git 检查。read/workspace-write worker 可以接收，none、reviewer 和模型探针跳过。范围外及受保护路径不进入材料；Git 不可用、HEAD 尚未建立或材料被预算省略时，提供有界的可用性或截断提示。组装遵循现有条目数、单条字符数和 UTF-8 字节预算，保留调用方已有上下文。内容脱敏沿用现有机制，截断材料需要后续按授权范围补读。

本功能不会自动执行 Git add、commit、reset 或更新已确认知识。源码检查、测试通过与运行服务已启用分别验收；部署仍使用受控升级流程。

## English

YHWH stores durable project knowledge as `.yhwh/memory/<id>.md` at a Git worktree root. Files survive conversations and process restarts; authorized commits add Git history. This is separate from host conversation memory, request ledgers and temporary LSP caches. It uses no database, vector service, scheduled organizer or model calls.

### Query and inspect

The new gateway exposes the read-only MCP tool `project_memory`. `cwd` must be an allowed Git worktree root:

| action | Purpose |
| --- | --- |
| `list` | Entry summaries, lifecycle and source state; default 20, maximum `limit` 50 |
| `search` | Chinese/English keyword `query`; defaults to accepted entries with matching source fingerprints |
| `read` | Read one entry body, provenance and revision by `id` |
| `review` | All entries' freshness, staged/unstaged patches, explicit untracked additions and ignored files; optional `baseline: "HEAD"` or a full commit SHA |
| `snapshot` | Supply 1–16 supported source `paths` to obtain current fingerprints for authoring an entry |

Example MCP input:

```json
{"cwd":"E:/Projects/MyProject","action":"search","query":"architecture"}
```

From a source checkout in PowerShell 7, invoke the same read-only implementation:

```powershell
$request = @{cwd=(Get-Location).Path; action='review'} | ConvertTo-Json -Compress
node ./payload/pi-dispatch/scripts/project-memory.mjs $request
$request = @{cwd=(Get-Location).Path; action='snapshot'; paths=@('AGENTS.md')} | ConvertTo-Json -Compress
node ./payload/pi-dispatch/scripts/project-memory.mjs $request
```

Both interfaces require Git on the runtime machine's PATH. Missing Git, a non-Git directory, excessive output or timeout produces an explicit error. The one-click installer does not currently install Git. Subsequent source builds carry the new implementation and policy; existing services and exported host rules require an explicit upgrade. Source changes alone do not establish availability in an old running service.

### Save, review and version

The primary inspects source code, obtains fingerprints using `snapshot`, then creates a Markdown draft with its existing authorized file editor. Neither interface writes files or replaces host write permissions. A chat-only client can query or produce a proposal for an authorized operator. Re-read an existing entry before editing to avoid overwriting another writer; there is no write lock or automatic merge engine here.

Entries use JSON metadata followed by Markdown. Replace the angle-bracket placeholders:

```markdown
---
{
  "schemaVersion": 1,
  "id": "architecture",
  "kind": "architecture",
  "status": "draft",
  "title": "Primary responsibilities / 主代理职责",
  "tags": ["architecture", "primary"],
  "sources": [{"path": "AGENTS.md", "sha256": "<64-character SHA256 from snapshot>"}],
  "sourceCommit": "<full commit SHA from snapshot; use null before the first commit>",
  "reviewedAt": null
}
---
Describe verifiable facts, reasons, applicability and what the evidence does not establish.
```

`kind` is architecture, decision, convention, pitfall or verification. The lifecycle is draft, accepted or deprecated. After reviewing the claims, sources and diff, the primary explicitly sets accepted and a `reviewedAt` date; these fields are not authenticated review signatures. Keep deprecation reasons and replacement links without deleting historical context.

`review` separates staged changes, unstaged changes and untracked additions. Ordinary Git diff omits untracked files, so inspect the third section for new entries. An optional baseline comparison still excludes untracked files. A patch section exceeding the preview limit reports `truncated:true`; inspect the full diff with native tools before acceptance. No git add, commit, push or reset is performed. Uncommitted files remain readable across sessions, but have no new Git history or backup guarantee.

Sources are hashed as UTF-8 text after CRLF-to-LF normalization. `sourceCommit` records HEAD at snapshot time; working files may contain uncommitted edits. Modified, missing, conflicted or unsafe sources produce `needs-review`, excluded from default search. `includeInactive:true` explicitly includes draft, deprecated and stale knowledge; no status or hash is automatically rewritten. Matching fingerprints establish only consistency of declared source text, not correctness, runtime success or unchanged undeclared dependencies. Renames appear as missing sources and require reviewed reference updates.

### Scope and limits

- Maximum 256 flat entries, 16 KiB per entry, 1–8 sources per entry, 128 distinct sources, 1 MiB per source and 16 MiB total reads per request. Each patch preview is limited to 65,536 characters; each Git command to 10 seconds and 1 MiB output. Exceeding these budgets fails explicitly; split the knowledge scope instead of silently dropping evidence.
- Only ordinary, non-ignored UTF-8 source files in Git's index qualify. Traversal, symbolic links/junctions, hardlinks, binary files and common credential paths are rejected. Knowledge drafts themselves may be untracked. Never store credentials, raw conversations or complete task logs. Common credential patterns are redacted, but this is not a comprehensive secret scanner.
- Search is deterministic keyword matching, not vector search. Every query rereads knowledge and rechecks source freshness; the private disk index and in-memory cache never replace that check. After dependencies and write locks are ready, internal worker dispatch may clone task context for read/workspace-write tasks (not reviewers or model probes) and inject at most five accepted, fresh references whose every source is within task readScope/writeScope, with an 8 KiB combined UTF-8 cap. Each wrapper carries explicit untrusted, status and freshness provenance; the original task, idempotency digest and authority do not change. `none`, reviewer and probe dispatches skip injection. This private path may try rebuilding only `.yhwh/memory-index/index.json`; refresh failure still permits read-only search of the authoritative knowledge. Ordinary MCP/CLI tools remain read-only and never write, accept or update knowledge. Index cache defaults are 8 MiB per item, 64 MiB total and 15-minute TTL; borrowed Gateway users cannot close it, and the cache/timer are cleared only after the last owned lease is released. Full model results use a default 128 MiB RAM budget and one-hour terminal retention; the request ledger is called before eviction, and failed persistence keeps results resident even if that exceeds budget. The separate ledger result cache targets 14 days for completed records, 90 days for ordinary failures and 512 MiB total; host pending/original/attestation, linked and active/critical state are protected and may exceed the capacity target. Paginated recovery verifies ledger digests. Host-verification projections take precedence over ordinary cached results so stale unverified data cannot mask proof. Memory and results are reference data and cannot override host rules or grant authority.
- This repository's own knowledge belongs to YHWH and is not installed into other projects. Installers distribute the implementation and policy; other projects create their own knowledge with user authorization.

### Git change references during dispatch

Worker context assembly also reads Git changes within task readScope/writeScope. Staged and unstaged patches are categorized separately; untracked files contribute only a filename inventory, never their contents. Each reference identifies the current HEAD and is explicitly untrusted evidence. It does not change task authority, the original request or its idempotency digest, and does not prove that a change passed verification or became accepted knowledge.

The current budget favors Git references before project memory; large change sets can crowd out memory references. Independent review accepted this as a nonblocking limitation, so both reference types are not guaranteed to appear together. Candidate patches are capped, but filtering rejected files may still increase inspection latency. External diff and textconv are disabled; configured Git clean/process filters remain inherited behavior. Use trusted repository and global Git configuration for automatic context inspection.

Git references do not require `.yhwh/memory/` or a knowledge-keyword match; memory-search failure does not prevent independent Git inspection. Eligible read/workspace-write workers receive them; none, reviewers and model probes skip them. Out-of-scope and protected paths are excluded. Unavailable Git, unborn HEAD and evidence omitted by budget receive bounded availability or truncation notices. Assembly respects existing entry-count, per-entry character and UTF-8 byte limits while retaining caller context. Existing redaction applies; truncated evidence requires further authorized inspection.

This feature does not automatically run Git add, commit or reset, or update accepted knowledge. Source inspection, passing tests and availability in the running service are accepted separately; deployment uses the controlled upgrade process.
