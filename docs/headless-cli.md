# 官方 CLI 无头入口 / Official headless CLI entry

[简体中文](#简体中文) · [English](#english)

## 简体中文

这是新增的可选主代理入口：Codex、Claude Code 和 Google Antigravity 的官方 CLI 使用同一套 YHWH 运行器。它不会替换 Pi 下层调用，也不会更改 worker/reviewer 的模型绑定。运行器通过标准输入发送发行包内的主代理治理文本和用户任务，不拼接 shell 命令。现有安装器复制整个插件目录，因此发行包与安装副本使用同一份源码。

### 启用与调用

1. 按官方文档安装需要的 CLI，并通过该 CLI 自身登录。YHWH 不捆绑这些二进制文件，不安装远程服务，也不提取或迁移 OAuth 凭据。
2. 将 `payload/pi-dispatch/workflow/headless.example.json` 复制为发行包目录之外的 `headless.local.json`。设置真实 `workspaceRoots`；为需要的客户端设置 `enabled:true`、原生程序绝对路径、`expectedVersion`（完整的版本命令标准输出）、明确的 `model` 和可选 `effort`。Node 入口使用 `executable` 指向 Node、`nodeScript` 指向 CLI 的 JS 文件；不支持 `.cmd/.bat/.ps1` 包装器或自定义参数。
3. 使用下面的入口检查。`ready` 只表示版本一致、帮助中存在所需参数，认证和模型访问仍是 `unverified`。CLI 自更新后版本不符会阻止调用；先审核版本及协议，再显式修改配置，不自动接受漂移。

```powershell
./Workflow.ps1 -Action HeadlessDoctor -HeadlessConfigFile C:/YHWH-config/headless.local.json
./Workflow.ps1 -Action HeadlessRun -HeadlessConfigFile C:/YHWH-config/headless.local.json -HeadlessRequestFile C:/YHWH-config/request.local.json
./Workflow.ps1 -Action HeadlessCompare -ComparePluginRoot C:/Users/your-user/plugins/pi-dispatch
```

任务文件只接受这三个字段；`cwd` 必须是配置根目录内真实存在的目录：

```json
{"client":"codex","cwd":"C:/work/project","prompt":"检查当前改动并列出待验证项。"}
```

已安装副本也可以直接使用 Node：

```text
node <plugin-root>/scripts/headless-host.mjs doctor <headless.local.json>
node <plugin-root>/scripts/headless-host.mjs run <headless.local.json> <request.local.json>
node <release-plugin-root>/scripts/headless-host.mjs fingerprint <installed-plugin-root>
```

### 权限与证据

| 客户端 | 支持的策略 | 边界 |
| --- | --- | --- |
| Codex | `read-only`、`workspace-write` | 显式选择原生 shell 沙箱，不绕过审批或沙箱；已配置 MCP 等能力仍受宿主规则控制 |
| Claude Code | `no-tools`、`native` | 默认关闭工具、定制功能和 MCP，只处理提供的文本；`native` 需要 `acceptNativePermissions:true` |
| Antigravity (`agy`) | `native` | 需要 `acceptNativePermissions:true`；不宣称存在已验证的只读/无工具模式 |

`native` 使用客户端自身设置，包括工具权限、MCP、hooks 等；选择它之前必须理解这些设置。根目录列表只限制启动位置，不是操作系统隔离边界。Antigravity 原生策略允许工作区文件读写，不能因为无头运行就视为只读。运行器不传递跳过权限检查的参数。Claude `no-tools` 不会执行完整的代码工作流；需要工具的主代理应显式配置 `native` 并连接 Pi MCP。

运行时间为 1–1800 秒，默认 300 秒；stdout/stderr 合计上限为 1 KiB–8 MiB，默认 2 MiB。超时、取消和超限会终止进程树；无法确认清理时返回 `cleanup_unverified`，不报告成功。Windows 使用隐藏窗口和原生进程启动。原始 stderr 不输出到结果中，不自动保存任务、回复或凭据日志；客户端自身日志/会话行为仍由其产品管理。

结果包含统一状态、文本、用量（如有）、退出码、耗时、请求模型/effort、版本、适配器摘要和调用配置摘要。成功的协议终态只证明 CLI 完成；实际模型身份、调用次数、治理链及任务正确性仍需主代理验收。可识别的工具拒绝会标记 `unverified`；拒绝文本检测不是全面的权限审计。

### 发布与本地一致性

`HeadlessCompare` 比对两个适配模块、示例配置和治理目录的字节摘要，差异或缺失会失败。安装验证同样检查这些文件。每次真实调用前检查完整 CLI 版本输出；运行配置摘要覆盖客户端、模型、effort、策略和预算。路径与工作根目录可因机器不同而不同。

这些检查覆盖本特性的源码/治理和声明的调用配置，不验证整个 Pi 服务、CLI 全部依赖、原生配置、账号权限、系统环境或模型输出相同。运行器不会自动同步安装副本、更新 CLI、发布 release 或重启 Pi。本特性随 v0.11.0 分发；既有安装需要显式升级并重新比对。

验证范围：三种协议使用本地确定性夹具验证；本机 Codex 0.153.0、Claude Code 2.1.250 的版本/帮助检查通过。Antigravity CLI 尚未发现，未进行真实调用。三个客户端的带认证模型调用均未在此次变更中执行。所有客户端默认禁用，不因安装 YHWH 消耗模型额度。

官方接口依据：[Codex](https://developers.openai.com/codex/noninteractive)、[Claude Code](https://code.claude.com/docs/en/cli-reference)、[Antigravity](https://www.antigravity.google/docs/cli/headless/)。这些客户端由各自厂商分发和授权，YHWH 的 Apache-2.0 声明仅覆盖自有适配代码。

## English

This optional primary-host entry runs the official Codex, Claude Code and Google Antigravity CLIs through one YHWH runner. It does not replace Pi dispatch or change worker/reviewer model bindings. The runner sends the packaged primary governance text and user task through stdin without constructing shell commands. The existing installer copies the entire plugin directory, so releases and installations use the same source.

### Enable and run

1. Install the desired CLI using its official documentation and authenticate through that CLI. YHWH does not bundle these binaries, install remote-control services or extract/migrate OAuth credentials.
2. Copy `payload/pi-dispatch/workflow/headless.example.json` to a host-owned `headless.local.json` outside the distributable package. Set real `workspaceRoots`. For each desired client set `enabled:true`, an absolute native executable path, `expectedVersion` (the complete stdout from its version command), an explicit `model` and optional `effort`. For a Node entry use `executable` for Node and `nodeScript` for the CLI JS file. Shell wrappers (`.cmd/.bat/.ps1`) and custom arguments are unsupported.
3. Run the following checks. `ready` means that the exact version matches and required flags appear in help. Authentication and model access remain `unverified`. CLI auto-updates cause a version mismatch and block execution; review the version/protocol before explicitly updating configuration. Drift is never accepted automatically.

```powershell
./Workflow.ps1 -Action HeadlessDoctor -HeadlessConfigFile C:/YHWH-config/headless.local.json
./Workflow.ps1 -Action HeadlessRun -HeadlessConfigFile C:/YHWH-config/headless.local.json -HeadlessRequestFile C:/YHWH-config/request.local.json
./Workflow.ps1 -Action HeadlessCompare -ComparePluginRoot C:/Users/your-user/plugins/pi-dispatch
```

Requests accept only these three fields; `cwd` must resolve to an existing directory within a configured root:

```json
{"client":"codex","cwd":"C:/work/project","prompt":"Review the current changes and list outstanding verification."}
```

An installed copy also works directly through Node:

```text
node <plugin-root>/scripts/headless-host.mjs doctor <headless.local.json>
node <plugin-root>/scripts/headless-host.mjs run <headless.local.json> <request.local.json>
node <release-plugin-root>/scripts/headless-host.mjs fingerprint <installed-plugin-root>
```

### Permissions and evidence

| Client | Supported policies | Boundary |
| --- | --- | --- |
| Codex | `read-only`, `workspace-write` | Explicit native shell sandbox; no approval/sandbox bypass. Configured MCP and other capabilities remain governed by the host |
| Claude Code | `no-tools`, `native` | Default disables tools, customizations and MCP, processing supplied text only; `native` requires `acceptNativePermissions:true` |
| Antigravity (`agy`) | `native` | Requires `acceptNativePermissions:true`; no verified read-only/no-tools profile is claimed |

`native` uses the client's own settings, including tools, MCP and hooks; understand them before selecting it. Workspace roots restrict launch locations, not OS access. Antigravity's native policy permits workspace file reads/writes; headless does not mean read-only. The runner never passes permission-bypass flags. Claude `no-tools` cannot perform a complete coding workflow; a tool-capable primary must explicitly select `native` and connect Pi MCP.

Timeouts range from 1–1800 seconds (default 300); combined stdout/stderr is limited to 1 KiB–8 MiB (default 2 MiB). Timeout, cancellation and output overflow terminate the process tree. Unconfirmed cleanup returns `cleanup_unverified`, never success. Windows uses hidden native process launches. Results omit raw stderr; the runner does not automatically persist prompts, replies or credential logs. Native client logging/session behavior remains product-owned.

Results normalize status, text, usage when available, exit code, duration, requested model/effort, version, adapter digest and run-profile digest. A successful terminal protocol message only proves CLI completion. Actual model identity, model-call count, governance execution and task correctness still require primary acceptance. Recognized tool denials produce `unverified`; denial-text detection is not a comprehensive permission audit.

### Release/local consistency

`HeadlessCompare` compares byte digests for both adapter modules, the example configuration and workflow catalog. Missing files or drift fail the check. Installation verification checks those files too. Every run checks the exact CLI version output. The run-profile digest covers client, model, effort, permission policy and budgets. Executable paths and workspace roots may differ by machine.

These checks cover this feature's source/governance and declared invocation configuration. They do not prove parity of the entire Pi service, all CLI dependencies, native settings, accounts, OS environments or model outputs. The runner does not automatically synchronize installations, update CLIs, publish releases or restart Pi. This feature ships in v0.11.0; existing installations require an explicit upgrade and fresh comparison.

Validation: deterministic local fixtures cover all three protocols. Local Codex 0.153.0 and Claude Code 2.1.250 passed version/help probes. Antigravity CLI was not found and was not invoked live. No authenticated model calls were performed for any client in this change. Every client is disabled by default; installing YHWH does not consume model quota.

Official interfaces: [Codex](https://developers.openai.com/codex/noninteractive), [Claude Code](https://code.claude.com/docs/en/cli-reference), [Antigravity](https://www.antigravity.google/docs/cli/headless/). Each vendor distributes and licenses its client separately; YHWH's Apache-2.0 declaration covers the first-party adapter code only.
