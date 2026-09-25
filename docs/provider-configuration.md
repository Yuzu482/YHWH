# 受控 API 平台配置

[简体中文](provider-configuration.md) | [English](provider-configuration.en.md)

0.7.0 增加可选的聚合 API 传输层。当前原生工作者为 `openai-codex / gpt-6-luna`，按任务选择思考深度（默认 `medium`）；审查者仍为 `anthropic / claude-sonnet-5 / max`。配置不会自动切换角色，也不会自动尝试备用平台。

## 平台与边界

| 平台 | 支持的 SDK baseUrl | 当前角色范围 |
| --- | --- | --- |
| OpenCode Go | `https://opencode.ai/zen/go/v1` | Luna 工作者，Responses |
| CommandCode | `https://api.commandcode.ai/provider/v1`（Responses）；`https://api.commandcode.ai/provider`（Messages） | Luna 工作者；Sonnet 5 审查者，取决于账号模型访问 |
| OpenRouter | `https://openrouter.ai/api/v1`（Responses）；`https://openrouter.ai/api`（Messages） | 同上，显式填写带命名空间的模型 ID |
| 自定义 / New API | 操作者配置的 HTTPS 地址 | 兼容 Responses 或 Messages，能力由操作者确认 |

Messages SDK 自动追加 `/v1/messages`，Responses SDK 追加 `/responses`。不要把完整请求地址填入 baseUrl。受控配置不开放任意请求头、脚本、环境变量插值、OAuth 导入或自动故障转移。自定义 HTTPS 地址表示操作者信任该服务接收任务内容和选定密钥；运行时拒绝重定向及其他请求地址。

这里接入的是服务商 API；OpenCode 和 CommandCode 的客户端身份、安装和套餐是另一层。OpenCode Go 官方公开了模型专属接口，当前公开目录有 `gpt-5.6-luna`。CommandCode 官方明确 Go 套餐不含 API 权限，Claude 只走 Messages；使用其模型目录确认当前账号支持的模型与 endpoint。适配代码不会伪装客户端来绕过平台限制。

本层保留既有模型治理，只允许 Luna / Sonnet 5 的原名或 `namespace/<原名>` 映射。Go 的其他模型和只支持 Chat Completions 的平台没有因此成为可用工作者。改变角色模型或降低推理强度需要另行修改治理规则；不会用模型名映射偷偷替换。

## 配置步骤

1. 从 `templates/provider-config.example.json` 复制工作文件。删除不使用的 route。示例的 `maxThinking:false` 故意无法通过校验；先确认服务商、账号、模型支持完整 `max`，再改为 `true`。能力标志是操作者声明，不是真实探测结果。
2. 根据需要填写 platform、baseUrl、model、semanticModel、credentialRef、contextWindow、maxTokens、capabilities。`semanticModel` 固定为工作者 `gpt-5.6-luna` 或审查者 `claude-sonnet-5`。上下文和输出上限是明确的本地限制，不是平台自动发现值；示例使用保守上限。工作者要求 tools 和 streaming；审查者仍由运行时强制 `access:none`、无工具。
3. 一键安装后运行 `%LOCALAPPDATA%/YHWH/Configure-Providers.cmd`，输入 JSON 文件路径，再隐藏输入各个 API key。源码/便携目录也可以使用以下命令：

```powershell
node .\install\provider-config.mjs .\my-provider-config.json
powershell.exe -NoProfile -File .\install\Set-ProviderConfig.ps1 -TargetHome $HOME -ConfigPath .\my-provider-config.json
powershell.exe -NoProfile -File .\install\Set-ProviderApiKey.ps1 -TargetHome $HOME -CredentialRef opencode-go
powershell.exe -NoProfile -File .\install\Set-ProviderApiKey.ps1 -TargetHome $HOME -CredentialRef commandcode
```

4. 安装/升级包含此版本的网关和 WSL 文件，再调用 `list_capabilities`。配置不会升级旧服务；不要在任务执行期间升级。确认 `controlledApi.configured` 后显式选择 `yhwh-worker-api` 或 `yhwh-reviewer-api`，model 使用配置中的真实 ID，thinking 必须为 max。默认 provider 不变。
5. 使用已有 `probe_model` 对配置后的 provider/model 做有授权的无工具心跳，然后执行受限任务验证工具调用。心跳会发送内容并消耗平台额度；安装和配置本身不做模型调用。真实 max 是否被服务端执行，仍需服务商支持与真实结果证据，客户端只能保证发送的值。

只有宿主固定路径 `~/.local/state/pi-kether/provider-config.json` 被读取。任务 JSON 不能提供配置路径、baseUrl、密钥或能力覆盖。`provider-credentials.json` 在同目录，credentialRef 只引用该文件中的条目；密钥文件仅允许当前 Windows 用户访问。任务快照、版本库和发布包排除两类本地文件。不得把个人配置和密钥放进仓库。

每个任务保存配置 SHA256；启动时由沙箱外的根启动器重新读取固定宿主配置并核对，变化则失败，不向新平台发出该任务。仅选定密钥通过 FD3 进入内存，不写入沙箱文件、参数或环境变量。返回的 opaque key 会被额外脱敏。API 路由的费用字段标为未知，不把 SDK 的占位零成本当作免费。服务商自己的路由、保留策略和套餐溢出计费由账号设置控制，YHWH 不能保证或替代这些设置。

移除配置中的 route 可停用该路由；`{"version":1,"routes":{}}` 停用所有可选路由。配置变更会阻止尚未启动的旧配置任务，已经发送的请求不会被撤回。原有 API / OpenAI 登录配置保留独立。

## 验证与来源

已做本地配置拒绝用例、角色与权限回归、PS5.1 假密钥 ACL/轮换/失败保留测试，并用固定 Pi 0.84.4 SDK 拦截网络验证 Responses 和 Messages 的实际请求地址、Bearer 认证、模型及 `max` 参数。没有提供真实平台密钥，未进行付费心跳、真实工具调用、干净机器安装或在线服务切换。适配完成不等于所有平台账号均可用。模板里的 CommandCode Sonnet 5 需以账号目录确认，未声明已在线验证。

官方资料（2026-09-19 检查）：[OpenCode Go](https://opencode.ai/v2/docs/console/go)、[Go 模型目录](https://opencode.ai/zen/go/v1/models)、[CommandCode Provider API](https://commandcode.ai/docs/provider)、[OpenRouter Messages](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages)。

[OpenRouter Responses API](https://openrouter.ai/docs/api/api-reference/responses/create-responses)


## 0.8 API key 静态加密

Anthropic 与受控聚合平台的 API key 现在使用 Windows DPAPI `CurrentUser` 加密保存，继续保留当前用户专用文件权限。输入仍隐藏，文件只保存 `api_key_dpapi` 密文封装；密文还绑定凭据类别及引用名。更换 Windows 用户或机器时通常需要重新配置密钥，安装包不迁移密钥。

调用链：Windows 受控助手在内存解密 → 私有进程管道 → WSL 校验路由/配置摘要 → 内核管道 FD3 → Pi 内存。API 路由不再创建明文临时凭据文件。旧明文格式返回 `PI_AUTH_MIGRATION_REQUIRED`，密文损坏或无法解密直接失败，不回退到明文、环境变量或其他账号。

升级后，先停止旧版任务并安装配套网关/WSL 文件，再运行安装目录中的 **`Migrate-API-Keys.cmd`**。源码或便携包可运行：

```powershell
powershell.exe -NoProfile -File .\install\Migrate-ApiCredentials.ps1 -TargetHome $HOME
```

迁移按每个凭据文件分别执行：校验旧值、加密、核对解密结果后原子替换；不生成明文备份，重复执行不会重复改写已加密文件。验证失败保留原文件。旧安装和新凭据格式必须一起升级，旧版无法读取密文。迁移不会清除历史备份、磁盘已释放的数据块或外部副本，也不承诺安全擦除。

这次覆盖 YHWH 管理的 Anthropic / 聚合平台 API key；OpenAI OAuth 账户的登录与刷新存储仍由既有 Pi SDK 管理。运行时仍需短暂明文内存，DPAPI 不抵御已控制当前用户、可信 Pi 进程或系统的攻击者。没有修改本机真实凭据或切换现有服务。

验证包括实际 DPAPI 假密钥往返、篡改/引用替换拒绝、轮换、失败保留、迁移幂等性，以及 WSL/Bubblewrap 无网络 FD3 探针。跨 Windows 账号/机器解密拒绝未用第二账号实测；真实付费模型调用和完整升级仍未验证。参考：[Microsoft DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)。
