# 代码关系持续记忆 / Persistent code relationships

[简体中文](#简体中文) · [English](#english)

## 简体中文

关系索引保存在项目根目录 `.yhwh/code-graph/index.json`，跨任务、跨进程保留。它与人工确认的 `.yhwh/memory/` 知识分开：解析器不会自动确认或改写知识。首次支持 JavaScript/JSX、TypeScript/TSX 和 Python；C#、C/C++、Java、Go、Rust 的既有 LSP 能力不等于已经支持它们的持久关系索引。

索引保存文件、命名类、函数、方法、类型声明、包含关系、导入关系，以及带行号的调用、构造和基类提及。Python 方法以类下的函数表示。仅唯一匹配的相对模块路径连到目标文件；其余导入保留为未解析或歧义提及。调用提及不会猜测目标函数。动态调用、类型推断、重载、跨文件符号绑定、路径别名、Python 绝对导入与 `from . import 子模块` 的子模块推断均不在当前覆盖内。匿名函数的调用归到最近的命名声明或文件；类型语法不代表运行时行为。

### 使用

运行机器需要 Node 与 Git，并先在 `payload/pi-dispatch` 安装锁定依赖（`npm ci --ignore-scripts`）。以下在源码仓库根目录执行；安装后将脚本路径替换为插件的 `scripts/code-graph.mjs`。`cwd` 必须是目标项目的绝对 Git 根目录。

```powershell
$request = @{cwd=(Get-Location).Path; action='refresh'} | ConvertTo-Json -Compress
node payload/pi-dispatch/scripts/code-graph.mjs $request
$request = @{cwd=(Get-Location).Path; action='search'; query='Gateway'; limit=20} | ConvertTo-Json -Compress
node payload/pi-dispatch/scripts/code-graph.mjs $request
```

MCP 工具为 `code_graph`，只读操作如下；CLI 同样支持。先查询 `status`，再从 `search` 返回结果复制完整节点 `id`。

| action | 作用 | 参数 |
| --- | --- | --- |
| `status` | 是否存在/过期，新增、变化、删除、解析失败及未覆盖扩展名 | `cwd` |
| `search` | 查找文件或声明/提及 | `query`、`offset`、`limit` |
| `neighbors` | 查询包含、导入、调用/基类提及边及端点 | `id`、`direction: incoming/outgoing/both` |
| `impact` | 从节点所属文件反查相对导入链中的潜在受影响文件 | `id`、`depth:1..8` |

默认 `limit:40`，最大 100；用 `nextOffset` 翻页。默认拒绝过期索引；删除前后的历史追踪可显式 `allowStale:true`，但结果仍标为过期。查看 `parseErrors`、`excluded`、`unsupported`、`truncatedDepth`：空影响结果不证明没有影响。

### 更新与持续性

`refresh` 是宿主 CLI 写操作，不属于 MCP。只扫描 Git 已跟踪、非忽略、普通 UTF-8 源文件；未跟踪的新文件须等获得授权的 Git add 后才进入索引，不自动暂存。比较完整文件清单和 LF 规范化 SHA256，复用未变化 AST 事实，重新计算关系；删除、重命名、分支切换和解析器版本变化会使旧数据失效。索引不存变化时间戳，无变化时不重写，适合 Git diff。源文件不动、Git 索引不动，知识状态也不动。

主代理规则要求在授权源码修改后刷新，跨任务读取前检查过期状态。需要编辑期间自动刷新时显式运行限时监听：

```powershell
$request = @{cwd=(Get-Location).Path; action='watch'; intervalSeconds=5; durationSeconds=300} | ConvertTo-Json -Compress
node payload/pi-dispatch/scripts/code-graph.mjs $request
git diff -- .yhwh/code-graph/index.json
```

监听每轮串行刷新，间隔 2–60 秒、最长 3600 秒（默认 5 秒/300 秒），出错即停；Ctrl+C/SIGTERM 在当前刷新结束后退出。不会默认常驻、开机启动或创建计划任务。未跟踪索引首次不会出现在普通 `git diff`，需先阅读文件；提交、推送和服务升级仍需任务授权。已有安装需更新插件并重启才能发现新工具，纯聊天宿主只能查询，需要已有授权执行工具或操作者刷新。

### 边界与恢复

最多 512 个支持文件、单文件 1 MiB、源读取总量 16 MiB、索引 8 MiB、事实 60000 条。解析在独立 Worker 内，单文件 10 秒、刷新约 120 秒上限（另含有界 Git/文件检查）；V8 堆限制不等于操作系统/WASM 总内存隔离。不会运行项目代码、加载项目配置、启动 LSP 或调用模型。语法错误清空该文件事实并显式报告，不沿用旧事实。

拒绝符号链接、junction、硬链接、凭据路径和非普通文件；固定写入索引位置，以排他锁、两次源检查、修订检查和同目录原子替换保护已有索引。可传 `expectedRevision`（来自 `status`，或 `null` 表示只允许首次创建）防止覆盖已变化版本。锁协调遵守协议的进程，不抵御有本地写权限的恶意目录替换。发现残留 `refresh.lock` 时先核实进程已退出再由操作者处理；不会自动抢锁。索引损坏则停止，恢复已知版本或明确移除后重建。生成文件是可编辑、未签名的数据；散列匹配证明来源文字未变，不证明索引未被伪造。保留源码复核与 Git 审查。

解析器固定为 Microsoft `@vscode/tree-sitter-wasm@0.3.1`，许可/来源见 [清单](../licenses/code-graph-parser.json) 与 [原始通知合集](../licenses/code-graph-tree-sitter-notices.txt)。它不依赖旧 `pi-lsp-extension`，也不改变该旧组件的许可状态。

## English

The relationship index lives at `.yhwh/code-graph/index.json` in the project root and survives tasks and processes. It is separate from accepted `.yhwh/memory/` knowledge: parsing never accepts or rewrites human knowledge. Initial adapters cover JavaScript/JSX, TypeScript/TSX and Python. Existing LSP support for C#, C/C++, Java, Go and Rust does not imply persistent graph support for those languages.

The index stores files, named classes, functions, methods, type declarations, containment, imports, and call/construction/base-type mentions with source lines. Python methods appear as functions nested under classes. Only uniquely matching relative module paths link to target files; other imports stay unresolved or ambiguous. Call mentions do not guess target functions. Dynamic calls, type inference, overloads, cross-file symbol binding, path aliases, Python absolute imports and submodule inference for `from . import submodule` are outside this coverage. Calls inside anonymous functions belong to the nearest named declaration or file; type syntax is not runtime behavior.

### Usage

The runtime host needs Node and Git. Install pinned dependencies in `payload/pi-dispatch` first (`npm ci --ignore-scripts`). Run the examples above from the source repository root; after installation use the plugin's `scripts/code-graph.mjs` path instead. `cwd` must be the target project's absolute Git root.

The read-only MCP tool is `code_graph`; the CLI supports the same queries. Start with `status`, then copy an exact node `id` from `search`.

| action | Purpose | Parameters |
| --- | --- | --- |
| `status` | Existence/freshness, added/changed/deleted paths, parse errors, unsupported extensions | `cwd` |
| `search` | Find files, declarations and mentions | `query`, `offset`, `limit` |
| `neighbors` | Containment/import/call/base edges and their endpoints | `id`, `direction: incoming/outgoing/both` |
| `impact` | Reverse relative-import reachability from the node's file | `id`, `depth:1..8` |

Default `limit` is 40, maximum 100; paginate with `nextOffset`. Queries refuse stale indexes by default. Historical deletion tracing can explicitly use `allowStale:true`, with stale labeling retained. Inspect `parseErrors`, `excluded`, `unsupported` and `truncatedDepth`: an empty impact result does not prove absence of impact.

### Refresh and continuity

`refresh` is a host CLI write operation, never an MCP action. It scans tracked, non-ignored, ordinary UTF-8 sources only; new untracked files enter after an authorized Git add, never automatic staging. It compares the full inventory and LF-normalized SHA256 hashes, reuses unchanged AST facts, and re-resolves relationships. Deletion, rename, branch switches and parser version changes invalidate old data. No changing timestamps are stored, and no-op refresh preserves bytes and mtime for useful Git diffs. Sources, the Git index and knowledge status remain unchanged.

Primary-host rules require refresh after authorized source edits and a freshness check before cross-task reuse. For automatic refresh during editing, explicitly run the `watch` example above: `intervalSeconds:5`, `durationSeconds:300`. Refreshes run serially, with a 2–60 second interval and a maximum duration of 3600 seconds (defaults 5/300); errors stop the watcher. Ctrl+C/SIGTERM exits after the current refresh finishes. No persistent service, startup entry or scheduled task is installed. A first untracked index is not shown by ordinary Git diff; inspect the file directly. Commit, push and service upgrades still require task authorization. Existing installations need a plugin update/restart to discover the tool; chat-only hosts need an already-authorized execution tool or operator for refresh.

### Boundaries and recovery

Limits: 512 supported files, 1 MiB per source, 16 MiB total source reads, 8 MiB index, 60000 facts. Parsing uses a separate Worker with a 10-second file deadline and an approximately 120-second refresh budget plus bounded Git/file checks; the V8 heap cap is not OS/WASM total-memory isolation. No project code/configuration, LSP server or model is executed. Syntax errors clear that file's facts and are reported, rather than retaining old facts.

Symlinks, junctions, hardlinks, credential paths and non-ordinary files are rejected. Writes have a fixed destination, exclusive lock, repeated source/revision checks and same-directory atomic replacement. `expectedRevision` from `status`, or `null` for creation only, prevents overwriting a changed revision. Locks coordinate cooperating processes; they do not defend against malicious directory replacement by a local writer. Reconcile a leftover `refresh.lock` owner before an operator removes it; locks are never stolen automatically. Malformed indexes stop processing: restore a known version or explicitly remove before rebuilding. Generated data is editable and unsigned; matching source hashes establish text consistency, not authenticity of the graph. Retain source inspection and Git review.

The parser is pinned to Microsoft `@vscode/tree-sitter-wasm@0.3.1`; see [provenance](../licenses/code-graph-parser.json) and [original notices](../licenses/code-graph-tree-sitter-notices.txt). It does not depend on legacy `pi-lsp-extension` and does not change that component's licensing status.
