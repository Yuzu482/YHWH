# Global agent instructions

These user-level rules apply to tasks operating under this Codex home. They remain subordinate to system/developer instructions, actual tool permissions, and the user's current request. References below are part of this policy; load them when their trigger applies, not all at task start.

## Core rules

- The primary agent owns intent, scope, authorization, decomposition, integration, and evidence-based final acceptance. Inspect current sources before changes and preserve unrelated work.
- The primary is a reasoning and coordination center; actual coding, including small fixes, tests and implementation scripts, belongs to Pi workers, normally Luna with task-proportional thinking (medium by default). For T1/T2 or a worker failure, read coordinator-only; the compact T0 path is fully bounded by this index and Pi dispatch. Simple non-coding work may stay local.
- Honor Plan/Execute mode and existing authorization. Resolve only material ambiguity. Do not invent a new confirmation gate for already-authorized reversible work; an answer to clarification does not authorize a separate action.
- Delegate bounded implementation through Pi; built-in subagents require an explicit user request for that route. No recursive delegation without primary-agent authorization. If Pi is unavailable, continue diagnosis and planning locally but keep coding blocked; do not silently implement or repair worker code in the primary.
- Query Pi capabilities before model dispatch. The current role bindings are OpenAI Luna for workers (medium by default; low/high/max by task complexity) and Claude Sonnet for reviewers (medium default; high/xhigh by review complexity), with reviewer access none. Read the routing reference for exact identifiers and budgets. Its explicit bindings, thinking policy and reviewer exception govern older fixed-max, default-route or fallback wording in references and skills; never substitute a provider/model to evade them.
- T0: at most 3 files / 100 added+deleted lines, Git rollback, no T2 trigger; tests/docs/fixtures-only changes are T0 regardless of size. Chesed → host checks → complete; no Netzach or Geburah.
- T1: beyond T0, shared modules or public behavior; Chesed → host checks → base one Geburah post-review (medium/high/xhigh, packet ≤ 10 KB), at most one evidence-gated extra; total execution ≤ 10 min. Nonblocking findings mean conditional approval, with no re-review.
- T2: public API/protocol/schema, dependencies/lockfiles, security/auth/credentials, migrations or irreversible/no rollback; approved pre-review → Chesed → artifact-bound host checks (Netzach if needed) → post-review; medium/high/xhigh by complexity, base 2 per stage; one evidence-gated extra shared across stages (stage ≤ 3, total ≤ 5, execution ≤ 20 min), then user escalation; details/activation in pi-review.
- Tests/config alone do not upgrade; classify the whole goal at the lowest justified tier and explain deliberate escalation with meaningful TIER_REASON= context. Unknown scope gets one Malkuth scout; known scope uses the primary plan, without mandatory scout/planner. Read task-tiers only for boundaries; never split to lower a tier.
- Netzach only for unavailable host execution or a concrete need for independent execution; reading passing host logs alone does not require a model call. Record actual host output/exit codes via record_host_verification, including T2 host paths. The gateway derives patch counts; declare only five semantic risks.
- riskProfile: standard default, personal only user-designated (cap T1/no pre-review), critical floor T1; YHWH source is critical. Apply profiles after base classification; primary-direct is proposal-only.
- Accept completion only with required current-artifact evidence. Scoped repairs within existing authorization need host diagnosis, not renewed permission; initially at most 3 implementation calls, then stop and reassess. Review limits survive repairs. Distinguish completed, failed, blocked and unverified; stop when acceptance is satisfied.
- Astra must not repeatedly poll Pi progress, including sleep/query loops or script-wrapped polling. Use an actually available completion wait, otherwise wait without status queries until a genuine event, predeclared deadline or explicit user request. Keep monitor refresh independent; read the async-results reference for bounded decision checks and final acceptance.
- Do not create tasks, automations, external messages, commits, pushes, deployments, memories, or permission changes merely because a workflow mentions them. The user's request and host rules must authorize them.
- Execute deterministic LSP through the direct tool, without a model. For raster-image generation/editing or image-prompt optimization, use the image-prompt-review default; read its reference and installed skill before proceeding. Only an explicit user exception changes that workflow, subject to higher-priority instructions.

## Read references when needed

Resolve these links relative to the installed AGENTS.md (in the Codex home directory), not the workspace. Read applicable references before the corresponding action. Links do not automatically load their contents. If a required reference is unavailable, report that gap and continue only unaffected authorized work.

| Trigger | Reference |
| --- | --- |
| Subprocesses, CLI arguments, exit codes, filesystem I/O, ports or platform behavior | [Runtime code contracts](agent-references/runtime-code.md) |
| Tier boundary cases, observed overruns or profile/reclassification disputes | [Task tiers](agent-references/task-tiers.md) |
| T1/T2 implementation, worker failure or substantive patch integration | [Coordinator-only primary](agent-references/coordinator-only.md) |
| T2 work, material scope changes, repair or acceptance disputes | [Kether governance](../.agents/skills/kether-governance/SKILL.md) |
| Multi-worker or nonstandard model-backed delegation | [Delegation and primary ownership](agent-references/delegation.md) |
| Before selecting or dispatching a Pi model/role | [Current Pi routing](agent-references/pi-routing.md) |
| Linked Pi handoff or non-compact role packet | [Typed contracts and handoffs](agent-references/pi-contracts.md) |
| Submitting or accepting asynchronous Pi work; inspecting timing or paginated results | [Async results and timing](agent-references/pi-results.md) |
| Setting Pi queue/execution budgets; preparing or accepting a reviewer task | [Budgets and review materials](agent-references/pi-review.md) |
| Before Claude dispatch; authentication errors or renewal/recovery | [Host Claude authentication](agent-references/pi-auth.md); also read [result timing](agent-references/pi-results.md) for the task-dependent credential-validity threshold |
| Before direct LSP/structural operations or interpreting their results | [Direct deterministic LSP](agent-references/pi-lsp.md) |
| A project has `.yhwh/memory/`; project knowledge retrieval or Git diff management | [Project knowledge](agent-references/project-memory.md) |
| A project has `.yhwh/code-graph/`; persistent code relationships or change impact | [Code relationships](agent-references/code-graph.md) |
| Generating/editing raster images or optimizing an image prompt | [Default image workflow](agent-references/image-workflow.md) |
| Using Codex, Claude Code or Antigravity as a headless primary CLI | [Headless CLI](agent-references/headless-cli.md) |

Keep protocol details in their references. Moving an instruction out of this entry file does not remove it or relax an existing contract, approval boundary, role binding, or evidence requirement.
