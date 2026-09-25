# Pi 子代理角色预设

[English](pi-role-presets.en.md)

YHWH 为八个 Kether 子代理角色提供固定的 Pi preset。网关先确认角色、模型、访问级别和工具上限，再显式加载受控 Pi 扩展并传入角色 ID。扩展只向系统提示追加所选规范角色的一张简短、可执行职责卡，不会注入其他角色卡，也不授予权限。派发使用 `--no-skills`，避免自动技能发现；不读取任意项目或用户 `SKILL.md`。项目目录或用户目录中的 `.pi/presets.json` 不参与这条派发路径。

WSL 只读或限定写入任务通过受控 `yhwh_submit_result` 工具恰好提交一次结构化结果，网关确定性校验规范 JSON。无访问权限任务（包括 reviewer）仍使用单行 `KETHER_RESULT_JSON=` 最终封包。角色卡提示本身不能保证模型遵从；格式错误仍会被拒绝。

| 角色 | 职责 | 允许的文件访问 |
| --- | --- | --- |
| Yesod | 归一化目标与任务约束 | 无 |
| Binah | 澄清实质性歧义 | 无 |
| Hod | 评估复杂度与风险 | 无 |
| Malkuth | 侦察工作区并记录证据 | 无或只读 |
| Chochmah | 制定有界执行方案 | 无或只读 |
| Chesed | 在授权范围内编码与修改 | 无、只读或限定写入 |
| Netzach | 只读验证与验收记录 | 无或只读 |
| Geburah | 审查提供的材料 | 无 |

`worker`、`researcher`、`reviewer` 分别归一化为 Chesed、Malkuth、Geburah。Kether 和 Tifereth 留在主宿主；Da'at 目前不是可派发的 Pi preset。现有模型绑定保持不变：七个非审查角色使用 Luna，Geburah 使用 Claude Sonnet。无访问权限的任务不获得文件工具；只读任务按角色可用限定的读取与 LSP 工具。Chesed 的只读和限定写入预设开放核心文件工具及结果提交工具 `yhwh_submit_result`，不向编码任务暴露 LSP；确定性探针由主代理直接调用 `lsp_request`。只有 Chesed 在独立授权、明确 `writeScope` 且操作系统沙箱可用时才能写入。

preset 是职责和工具选择入口，不是独立的安全边界。网关拒绝未知角色、越权访问和不匹配的模型路由；启动参数把工具限制在角色上限内。文件读写还受任务范围、WSL 沙箱和写入后补丁校验约束。编辑器桥接是另行授权的能力，仍由专门的操作目录和宿主校验控制。审查者不能自行读取工作区，必须收到实际审查材料。

安装器将 `role-presets.js` 放到 `/opt/pi-kether/extensions/`，安装后自检确认该文件存在。可在仓库运行 `npm test --prefix payload/pi-dispatch` 验证角色表、每个角色卡的单独注入与长度上限、启动参数和拒绝规则；这类静态测试不等同于已升级的本地服务或实机模型调用，也不证明模型遵循了角色卡。
