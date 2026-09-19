# YHWH LSP 组件说明

[English](lsp-component.en.md)

## 开发版状态

0.9.0 开发源码已接入 Microsoft `multilspy@0.0.15`，尚未发布；探针部分已部署到维护者当前运行服务并通过真实网关检查。已发布的 v0.8.1 及附件保持原样。除主 Agent 的确定性 `lsp_request` 语义查询外，现增加自有 Pi 适配插件供受管工作代理使用，不改变模型路由、权限和单文件探针范围。

## 操作与实际后端

| 入口 | 后端 | 行为 |
| --- | --- | --- |
| diagnostics、hover、definition、references、symbols、completions、code_actions | multilspy 0.0.15 官方语言适配器或受控协议配置 + 预装语言服务器 | 无模型、只读查询；代码操作仅返回建议，拒绝服务端写入请求 |
| overview、search | pi-lsp-extension 1.3.0 / Tree-sitter | 保留原结构分析能力；不是 multilspy，也不是语义查询失败后的回退 |
| Pi 模型任务的 `yhwh_lsp_*` | YHWH 自有 Pi 适配插件 + multilspy | 七项只读语义工具，使用当前任务文件的隔离快照；[接入说明](pi-lsp-adapter.md) |
| Pi 模型任务的旧工具名称 | 原 pi-lsp-extension | 兼容保留，不表示已移除旧扩展或解决其许可缺口 |

`list_capabilities.lsp` 公布语义和结构后端，结果包含 `engine`、版本、`adapter`、`adapterVersion`、`backend` 和 `modelCalls:0`。缺少依赖、服务不支持某方法或初始化失败会返回 unavailable/failed，不自动切回旧语义后端。

## 语言服务与安装

- Python 符号查询：官方 JediServer + 已锁定的 jedi-language-server 0.41.3；Python 诊断及 code_actions：受控 Pyright 配置。JavaScript/TypeScript（含 JSX/TSX）：官方 TypeScriptLanguageServer；Java：受控 JDT LS；C/C++：受控 clangd；C#：受控 csharp-ls。
- TypeScript 7.0.2 编译器继续保留。新探针使用独立别名 `typescript-lsp` 固定 TypeScript 6.0.3，并显式指定其中的 tsserver；禁用自动类型下载及配置的插件。TypeScript 7 包不含该旧服务需要的 tsserver.js。这一配置不声称支持 TypeScript 7 新增语义。
- WSL 安装器创建 `/opt/pi-kether/multilspy-venv`，使用 Ubuntu 24.04 x86_64 / Python 3.12 的固定轮包版本和 SHA-256。18 项 Python 依赖见 [锁文件](../payload/multilspy-requirements.txt)及 [来源清单](../licenses/multilspy-dependencies.json)。
- Python 使用官方工厂创建 JediServer；TypeScript 继承官方适配器，仅替换依赖准备逻辑，使用预装固定命令。两者都不在运行时下载服务器。安装阶段仍需访问 PyPI/npm 等下载源，确定性沙箱继续隔离网络与凭据。
- `-SkipWsl` 不安装这一 Python 运行时，也不是完整 LSP 排除开关。升级必须更新成套网关、WSL 脚本和依赖；只复制网关文件不会完成迁移。

## 输入、结果与清理

输入位置是 **1-based UTF-16** 行列；原始 LSP 结果保留 **0-based UTF-16**，在结果中明确标注。精确 query 只在文件中唯一出现时定位；重复匹配要求调用者提供位置，不猜测引用或声明位置。symbols 的 query 精确匹配符号名称。

主 Agent 仍只提供单文件快照，跨文件引用和完整项目依赖可能不可见。单文件最大 4 MiB，协议请求和输出有大小限制。没有诊断通知、旧版本诊断、超时或不支持的功能均不能冒充“检查通过”。实际收到错误诊断表示工具成功获取证据，不表示代码无错误；空诊断也仅是本次通知的观测结果，不证明项目无缺陷。

JavaScript/TypeScript 的诊断及代码建议不能用第一条通知判断分析完成：类型服务可能先发布空的语法结果，再发布类型错误。适配层通过上游支持的 `typescript.tsserverRequest` 等待固定的 `syntacticDiagnosticsSync`、`semanticDiagnosticsSync`、`suggestionDiagnosticsSync` 三类只读响应，校验响应并统一为 LSP 位置；全部完成且收到当前文件的有效诊断通知后，才返回 `diagnosticCompletion.complete:true`。该证据同时列出 `method:tsserver-sync`、三个命令和文档版本。`diagnosticsPublished` 仍仅表示实际收到通知。缺少能力、部分响应失败、格式异常或超时均不能报告完整检查；其他语言没有因此获得新的完整性保证。

适配层显式拒绝 `workspace/applyEdit`。`workspace/executeCommand` 仅用于上述固定的 TypeScript 只读诊断，不接受用户或代码建议返回的任意命令；代码建议仍不会被执行。进程以独立进程组启动，在空 `/proc` 环境中也能清理；外层 cgroup 与沙箱清理检查继续保留。原 `.pi-lsp.json`、Lombok 禁用补丁继续用于仍保留的旧扩展。

网关启动 WSL 任务、清理及健康检查时固定 `--cd /`，工作区仍通过显式范围参数提供。这样可避免 WSL 自动将宿主当前目录映射到另一任务的临时 Windows 挂载，造成并发请求无法卸载。清理失败仍明确返回失败，不使用延迟卸载来冒充清理成功。

## 许可证边界

YHWH 自有适配器采用 Apache-2.0；multilspy 的 [Microsoft MIT 文本](../licenses/multilspy-0.0.15-MIT.txt)和协议客户端内嵌的 [OLSP MIT 通知](../licenses/multilspy-OLSP-MIT.txt)均保留。[Python 依赖通知](../licenses/multilspy-dependency-notices.txt)来自散列核验的官方轮包。

仍保留 pi-lsp-extension 的结构后端和模型工具，因此其完整上游通知问题没有消失。[上游 Issue #14](https://github.com/samfoy/pi-lsp-extension/issues/14)和 [补齐记录](lsp-license-remediation.md)继续有效，`Build-Release.ps1 -PublicRelease` 继续阻断。语言服务器和依赖分别保留自己的许可；此清单不代表整个产品完成合规审计。

## 复现验证

在 Windows 上执行 `python install/Test-Multilspy.py --wheel-dir <锁定wheel目录> --typescript-archive <typescript-6.0.3.tgz>`，需要已有 Ubuntu-24.04 Pi 沙箱及语言服务器；可用 `--distro` 指定其他配置匹配的发行版。提前下载 Python 清单和 npm 锁文件记录的精确文件；脚本校验哈希，不下载依赖或升级服务。`--skip-live` 仅运行协议测试，不需要 TypeScript 压缩包。

脚本使用 WSL 临时目录，运行 26 项协议与生命周期测试（含先空后错、三阶段完整诊断、异常与超时拒绝通过），再执行真实 Python、TypeScript 查询、三轮 TypeScript 小文件/千函数文件/正常文件复测，以及六项 Bubblewrap 检查（四项语义、两项结构）。验证只读工作区、无网络和空 `/proc`，并检查源文件未改变。这证明适配器与启动脚本调用链，不代表全新机器安装、已部署网关请求或 cgroup 资源耗尽测试。Java、C/C++、C# 已配置，但这些检查尚未实际运行它们。详见[验证历史](../VERIFICATION.md)。

## 官方适配器的接入边界

本阶段使用固定发行版 0.0.15 内的官方类。官方 JediServer 负责 Python 的 hover、definition、references、symbols、completions；官方 TypeScriptLanguageServer 负责 JS/TS 的七项语义操作。它们的启动、握手及正常关闭流程实际运行上游代码。YHWH 保留请求编排、UTF-16 位置校验、诊断证据检查、只读能力声明、进程组清理和超时兜底；因此这是受控封装，不是原样启用官方默认配置，也不表示微软提供或认可 YHWH 插件。

结果中的 `adapter` 分别为 `official-jedi`、`official-typescript` 或 `controlled-protocol`。官方适配器启动失败会直接失败，不自动换引擎。Python 类型诊断预先选择 Pyright，以免将 Jedi 的分析能力等同于类型检查。官方库的默认编辑器身份被改为 YHWH，未支持的写入能力不对外宣称。

0.0.15 轮包不包含新版主分支中的 clangd 适配器。Java/C#/C/C++ 此次保留原受控配置；没有安装 Serena 或第三方 MCP 适配器；运行服务随后仅升级了探针部分。当前查询仍受单文件快照范围限制。

## 当前 Go / Rust 路由

1.6.0 适配插件增加 Go/gopls 完整拉取诊断，以及 Rust/rust-analyzer + rustc 单文件元数据诊断，均为 `controlled-protocol` 路由。语言配置、隔离例外、诊断完成条件和 Cargo/模块范围限制见[适配插件说明](pi-lsp-adapter.md)。上面的 26 项数字是早期阶段记录；当前完整验证入口为 `install/Test-PiLspAdapter.py`，包括 42 项协议测试及各语言真实 SDK 检查。最新本机部署证据见[验证记录](../VERIFICATION.md)，不代表全新机器安装或完整项目编译。
