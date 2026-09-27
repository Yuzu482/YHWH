# Workflow improvement, phase A / 工作流改进 A 阶段

Status: completed locally on 2026-09-27. Review: primary-agent local review, **not independent review**; the configured Anthropic reviewer remained unavailable before phase B.

状态：2026-09-27 本地完成。审查方式为主代理本地审查，**不是独立审查**；阶段 B 之前，既有 Anthropic reviewer 路由仍不可用。

## Scope and source / 范围与来源

The prompt's repository and host snapshot was older than this branch. A file-by-file comparison found no host-only rule content to recover. The existing canonical sources remain `templates/AGENTS.kether.md`, `templates/agent-references/`, `payload/workflow-skills/kether-governance/`, `templates/hindsight-coding-agent/SKILL.md`, and `payload/pi-dispatch/skills/pi-dispatch/SKILL.md`. The catalog was already generated from reference templates. The old `governance.md` indirection and removed worker-skill paths were already absent; no duplicate template tree was introduced. `AUTH-RENEWAL.md` now points to the canonical `pi-auth` reference instead of repeating its credential instructions.

提示词中的仓库与本机快照早于当前分支。逐文件比对未发现需要回收的本机独有规则。以上现有目录继续作为单一来源；catalog 的模板生成、治理入口直达以及失效角色路径清理均已存在，因此没有另建一套模板副本。

Changed files in this phase: `install/HostWorkflowDrift.ps1`, `install/Test-HostWorkflowDrift.ps1`, `install/Sync-HostWorkflow.ps1`, `install/Test-HostWorkflowSync.ps1`, `install/Test-PiKether.ps1`, `install/Test-Headless.ps1`, and `payload/pi-dispatch/AUTH-RENEWAL.md`.

本阶段增加上次成功同步的 SHA-256 基线，涵盖受管理的 AGENTS 区块、引用文件、治理 skill、Pi skill、catalog 和插件清单。安装检查仍以仓库与本机的实际一致性决定通过或失败；不一致时另报 `source-changed`、`host-changed`、`both-changed` 或 `baseline-unknown`。第一次建立基线前的旧安装只能报告 `baseline-unknown`；同步后可区分方向。基线不包含凭据或宿主绝对路径。

## Verification / 验收

- Before sync, `install/Test-PiKether.ps1 -Installed -SkipWsl` failed and listed 10 managed-rule mismatches. After the backed-up `Sync-HostWorkflow.ps1 -InstallHost`, both `-Installed -SkipWsl` and the full `-Installed` check passed with no drift. The backup is under `~/.codex/backups/yhwh-host-workflow/20260927-190004-992/`.
- `install/Test-HostWorkflowDrift.ps1` passed its directional-classification cases. `install/Test-HostWorkflowSync.ps1` passed creation, hash, repeat-sync stability, and backup checks. `Sync-HostWorkflow.ps1 -Check` passed.
- `install/Test-Headless.ps1` now restores an initially absent process variable as absent and preserves a prior `strict` value. PowerShell parsing and both same-process restoration cases passed. This fixed the build-only `YHWH_WORKER_ENFORCEMENT_INVALID` regression without changing the original serial test command or assertions.
- `npm test` passed both before and after `npm ci`; `npm run test:memory` passed. The final unmodified `Build-Release.ps1` test path passed: 408 tests, 407 passed, 0 failed, 1 skipped. The one-click installer checks also passed.
- The local portable ZIP contains 405 entries, including the new tier reference and drift helper, with no credential, audit, `.test`, `.git`, backup, or local-state entry. `git diff --check` passed.

首次完整构建因无头自检遗留空环境变量而出现失败并停滞；确认根因后，只结束了该构建的进程树。曾尝试将发布测试改成 `npm test` 的补丁已撤回，最终通过的是原有串行测试流程。

## Limits and next step / 限制与下一步

The local gateway process still runs the older task schema while this branch has uncommitted tier-gate source from the preceding task. Its schema does not persist the submitted tier fields. Phase C must upgrade and verify the runtime gate; this phase only established rule-source parity. Phase B must make the independent reviewer route usable before its own acceptance. No push, release publication, credential edit, or account login occurred.

本机网关进程仍使用旧任务 schema；当前分支里先前任务的分级网关源码尚未部署到运行进程，旧 schema 不会记录提交的分级字段。阶段 C 必须完成运行时升级和强制门控验收；阶段 B 则需先恢复独立 reviewer 路由。本阶段未推送、正式发布、修改凭据或登录账号。
