# Codex 原生工作流

[English](native-codex-workflow.en.md)

这套模板适用于已有原生子代理能力的 Codex 宿主。主代理可以直接工作，也可以把独立任务交给子代理。需要 Pi 的模型路由、写入锁、账本或正式审查时，走已授权的网关流程。

## 启用

1. 确认当前 Codex 宿主支持并已启用原生子代理。备份当前全局 `AGENTS.md`，查看并合并[规则片段](../templates/codex-native/AGENTS.fragment.md)，保留原有项目说明和受管区块。
2. 在仓库源码目录用 Python 3.11 或更新版本生成需要的角色。先检查输出。宿主支持具名角色时，可把生成内容保存为当前 Codex 配置目录下的 `agents/native_researcher.toml`，并用 `--check` 核对。已有同名角色时先核对差异。
3. 把示例中的核对路径替换为当前 Codex 配置目录。在新会话检查角色是否可选。如果宿主只接受任务说明，把 `--instructions` 的输出写进派单即可。

```powershell
python templates/codex-native/agent-presets/scripts/compose.py native_researcher
python templates/codex-native/agent-presets/scripts/compose.py native_researcher --instructions
python templates/codex-native/agent-presets/scripts/compose.py native_researcher --check 'C:\Path\To\CodexHome\agents\native_researcher.toml'
```

[模板](../templates/codex-native/agent-presets/templates.toml) 决定特质与顺序，[技能说明](../templates/codex-native/agent-presets/SKILL.md) 包含核对方法。原生套件从源码按需启用。Pi 便携安装及现有宿主设置按各自的流程管理。

## 选择角色

| 角色 | 合适的任务 | 特质顺序 |
| --- | --- | --- |
| `native_researcher` | 只读调查与诊断 | Malkuth |
| `native_planner` | 梳理目标、范围、风险与实施计划 | Yesod → Binah → Hod → Chochmah |
| `native_implementer` | 在明确的写入范围内实施并自检 | Malkuth → Chesed → Netzach |
| `native_verifier` | 按验收条件复核结果 | Netzach |
| `native_reviewer` | 独立审查改动与证据 | Geburah |

## 主会话记录示例

- **派单**。实施代理选 `native_implementer`。允许 `apply_patch` 编辑 `docs/`，允许 shell 在仓库根目录运行 `rg -n --fixed-strings "Setup" docs/` 核查标题。主代理负责 `tests/`。只读核查选 `native_verifier`，只允许通过 `Get-Content -LiteralPath docs/setup.md` 读取验收材料，无可写目录。
- **交接**。`docs/` 由实施代理交给主代理。确认代理报告完成、相关检查进程已退出，记录停写证据后再转移写入权。停写状态不明时暂缓移交。

任务说明里的工具清单用于协作。技术限制以宿主实际启用并核实的工具配置、审批和沙箱为准。
