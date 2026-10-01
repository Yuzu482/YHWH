# Workflow improvement, phase B / 工作流改进 B 阶段

Status: **live reviewer route acceptance passed** on 2026-09-28. Phase B was installed through the explicitly authorized full installer. Luna repaired the trusted heartbeat prompt; host tests, a controlled two-file upgrade and the production recovery probe passed. A real pre-change review of the bounded role-alias plan was approved: audit `outcome=completed`, `runtime=host-cli`, `durationMs=247442`. This proves the live route and that plan's review only; Phase B source inspection remains **local review, not independent source approval**. Phase C–G has not started, and phase B has not been committed.

状态：2026-09-28 **真实 reviewer 路线验收通过**。B 阶段已按用户明确授权完整安装；Luna 修复可信心跳提示后，宿主测试、两文件受控升级和生产恢复探针通过。角色别名子方案的真实前评审已批准，审计 `outcome=completed`、`runtime=host-cli`、`durationMs=247442`。这只证明路线及该子方案，B 阶段源码检查仍为**本地审查，非独立源码批准**。C–G 阶段未开始；B 阶段未提交。

## Local implementation / 本地实现

The prepared reviewer route is `claude-code-cli / claude-sonnet-5 / max / access:none`. It uses the official local CLI via a constrained host process, a fresh empty working directory, stdin-only review packet, a sanitized environment, a Windows Job Object, and a single reviewer slot. The existing Anthropic API route remains an explicit option; there is no automatic fallback. The runner checks supported CLI flags and read-only `auth status --json` before model invocation. Failed or ambiguous preflight stops without reading or changing credentials. The gateway validates the v2 review result and records `runtime:host-cli`.

本地源码已经准备好上述 reviewer 路由。未登录、认证、额度、超时和输出格式错误均有受控分类；不会自动登录、续期、读取凭据或切换模型。该路由在宿主 Windows 上运行，不能当作 WSL 沙箱内执行。

Changed or added for phase B: `payload/pi-dispatch/scripts/{claude-reviewer-cli,reviewer-route-config,headless-host,headless-job,provider-policy,role-policy,worker-enforcement,dispatch,gateway,gateway-client}.mjs` (with `headless-job.ps1`), `payload/pi-dispatch/extensions/{admission-scheduler,audit-log}.js`, corresponding tests including `claude-reviewer-cli.test.mjs`, `claude-reviewer-dispatch.test.mjs`, and `reviewer-route-config.test.mjs`, plus `templates/{host-primary.md,agent-references/pi-routing.md,agent-references/pi-auth.md}`, `payload/pi-dispatch/skills/pi-dispatch/SKILL.md`, generated `payload/pi-dispatch/workflow/catalog.json`, and `SECURITY-HARDENING.md`. The dirty worktree also contains pre-existing tier-gate changes from the preceding task; those have not been attributed to phase B.

## Verification / 验证

The following bullets retain the earlier pre-install snapshot. Current host evidence: targeted CLI-probe regression 31/31 passed; full tests 431 total, 429 passed, 0 failed, 2 skipped; Build-Release passed including memory regression and 135 one-click checks; installed self-test passed. Production `probe-1790579938035` passed with `runtime:host-cli`, heartbeat passed and execution 11.3 seconds. Real pre-review `subagent-fix-real-pre-review-20260928-1` failed at 300 seconds without a result; its audit has `outcome:failed` and no completed runtime field. No independent approval is implied by installation or heartbeat.

下列项目保留安装前的历史快照。最新宿主证据：探针相关回归 31/31 通过；完整测试 431 项、429 通过、0 失败、2 跳过；Build-Release（含内存回归和 135 项一键安装检查）及 Installed 自检通过。生产探针 `probe-1790579938035` 为 `runtime:host-cli`、心跳通过、执行约 11.3 秒。真实前评审 `subagent-fix-real-pre-review-20260928-1` 在 300 秒超时，审计 `outcome:failed`，没有完成的 runtime 字段。安装和心跳不构成独立审查通过。

- Targeted host regression: 11/11 passed after correcting a fake-CLI fixture that initially corrupted the new auth-status preflight.
- `npm test`: 431 tests, 429 passed, 0 failed, 2 skipped.
- `npm run test:memory`: passed.
- `./Build-Release.ps1`: passed locally, including package validation and 135 one-click checks. The local ZIP was not published or installed; the build reported no bundled credentials or runtime state.
- `install/Test-PiKether.ps1 -Installed`: **failed due expected source/installed drift**. The running Pi still has the earlier reviewer route and older headless files. The pending stage B source was intentionally not deployed while live acceptance is blocked.
- After manual login, read-only `claude auth status --json` reported `loggedIn:true`. The isolated source gateway's real `probe_model` with `recovery:true` completed in about 38 seconds, with `runtime:host-cli`, `osSandbox:none`, and a closed route circuit; audit request `probe-1790524051194` records `outcome=completed`.
- A 40 KB pre-deployment review packet and a narrower 21 KB CLI security review packet both passed gateway request validation but reached the 300-second execution deadline. Their audit requests `phase-b-predeploy-review-20260927-2` and `phase-b-cli-security-review-20260927-1` record `outcome=failed`; neither has a v2 decision or completed `runtime:host-cli` reviewer audit record. The smaller request was a new scoped task after reassessment, not a replay of a write.

上述安装前快照的目标测试、完整测试、内存回归、本地打包和真实 recovery probe 通过；当时的安装漂移失败符合未部署状态。最新 Installed 自检已经通过，但**阶段 B 的独立 reviewer 验收仍未通过**。

## Manual handoff / 手动接续

Investigate why structured reviewer tasks exceed the 300-second limit while the exact-route plain recovery probe completes. Preserve the existing route and safety boundaries; do not auto-replay the timed-out requests or lower pinned reviewer thinking. After a bounded, source-grounded fix, complete a real pre-deployment review and verify audit `outcome=completed` with `runtime=host-cli`. Then upgrade the gateway through the repository's backed-up installation path, re-run installed drift and required tests, and accept and commit phase B. Only then may this prompt proceed to phase C. Do not edit or remove Pi credential or settings entries automatically.

Claude Code 已登录；当前阻塞点是结构化 reviewer 任务超时，不是认证。本报告不授权自动续期、凭据清理、推送或发布。
