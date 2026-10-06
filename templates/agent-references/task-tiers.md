# Workspace-write task tiers

Effective 2026-10-02. This policy supersedes older tier, review-thinking and verification-stage wording in skills/references. Classify the whole requested change; do not split related work to evade a tier. Read this document for boundary cases; ordinary classification uses the six core lines in AGENTS.md.

| Tier | Observable trigger | Required stages |
| --- | --- | --- |
| T0 | At most 3 files and 100 added plus deleted lines, Git rollback available, no T2 condition. Changes confined to tests, documentation or fixtures are T0 regardless of size (actual T2 operations still apply). | Chesed → host checks → complete. No Netzach or Geburah. |
| T1 | Beyond T0 size/scope, or modifies a shared module or public behavior, without a T2 condition. | Chesed → host checks → base one Geburah post-review, with at most one evidence-gated extra under pi-review, complexity-selected medium/high/xhigh thinking, reviewPacket at most 10 KB (UTF-8 serialized bytes). Nonblocking findings mean conditional approval; no repeat review. |
| T2 | Public API/protocol/schema; dependency or lockfile; security/auth/credentials; migration; irreversible/no rollback. Conditions otherwise unchanged. | Approved Geburah pre-review → Chesed → artifact-bound host verification (Netzach only if needed) → Geburah post-review. Review thinking medium/high/xhigh by complexity (medium default); base 2 pre-reviews and 2 post-reviews; one evidence-gated extra shared by the whole task (stage at most 3, total at most 5), execution at most 20 minutes. T1 execution is at most 10 minutes. Apply pi-review's runtime activation rule. If still failing, escalate to the user. |

Test/config changes alone never upgrade a task. Unknown scope never automatically becomes T2: dispatch one read-only Malkuth scout, establish the actual scope, then classify. A shared-module or public-behavior change is T1 unless it also changes a public API/protocol/schema or another T2 condition.

Choose the lowest justified tier for the whole goal, then apply the host profile. Do not default to T1 merely because implementation is delegated. A deliberate conservative escalation uses meaningful `TIER_REASON=` task context naming the shared/public behavior, larger related goal or concrete uncertainty; boilerplate such as "safer" is insufficient. Patch counts cannot disprove these semantic risks or automatically lower a declared tier. Deterministic advice is advisory and cannot replace primary judgment.

Known scope uses a source-backed primary plan in the pre-review material; no mandatory Malkuth or Chochmah call is added. Unknown scope still needs one scout. On a runtime that has not yet deployed the shortened linked protocol, use its existing valid chain and report the compatibility limitation; never forge predecessors or relabel dependent tasks.

Reviewer effort is selected separately from tier: medium by default, high for interacting modules or ambiguous evidence, xhigh (extra) for difficult concurrency/lifecycle/failure-path reasoning. Record the level and reason in task.context under pi-routing; do not automatically use max or raise effort just because a task is T2. Review budgets and stage requirements remain unchanged.

## Declaration and observed patch

The primary supplies tier and only these five semantic booleans in tierDeclaration: publicApiOrProtocol, dependencyOrLockfile, securityAuthOrCredentials, migration, irreversibleOrNoRollback. The gateway derives files and estimatedLines (added plus deleted) from the trusted actual patch; the primary must not invent patch counts. Exact task.writeScope remains the authorization boundary, separate from observed changed files.

Before mutation, semantic T2 conditions still require approved linked pre-review. After execution, the gateway recomputes the required tier from the patch and project profile. An overrun returns PI_TIER_EXCEEDED with the required tier and observed counts, with no successful contract or host-acceptance projection. Reclassify the whole change before further work. Auto-counting does not prove semantic safety: the primary checks shared/public behavior and the five declarations; recognizable sensitive paths may conservatively raise the required tier.

The deployed declaration schema accepts exactly these five flags. Do not send obsolete file/count or test/config escalation fields. If a different runtime advertises an incompatible legacy schema, report the compatibility gap instead of inventing counts or silently changing classification.

## Risk profiles

Host-owned configuration assigns each working directory a riskProfile: personal, standard or critical. Resolve canonical directories with longest matching ancestor; unmatched directories default to standard. Only the user designates personal directories. The YHWH source repository is critical.

Apply the profile after base classification: personal caps the effective tier at T1 and never requires pre-review; standard keeps the base tier; critical floors the tier at T1. Preserve base tier/risk flags in audit records even when a profile changes the effective tier. Profiles never grant write, credential, deployment or irreversible-action authorization.

## Evidence and acceptance

T0/T1/T2 may use real host command output and exit codes recorded through record_host_verification, bound to the final trusted artifact digest. Netzach is required when the host cannot provide execution evidence or a concrete independent execution check is necessary; a model merely restating passing host logs is not required. The gateway records caller-supplied execution observations and never runs the submitted command. It does not authenticate OS execution. Do not claim unavailable/unrun checks passed.

A T2 direct host path retains linked approved pre-review, same workspace/parent/goal/phase/digests, a complete passing durable host record, and independent post-review. Worker completion alone cannot replace host evidence. Host verification does not complete T1/T2 before required post-review. A correction creates a new current artifact and fresh required verification; prior attestation/post-review cannot approve the new patch. Keep review budgets and original goal identity.

T1 reviewers do not edit. Blocking findings leave the work incomplete; repair requires new host evidence, and an additional T1 review needs the evidence-gated extension defined in pi-review. Nonblocking findings are recorded as conditional approval with the outstanding conditions, not as a failure that causes another review. T2 review attempt limits survive repairs and request-ID changes; do not reset them by splitting a task.

The proposed primary-direct channel is not enabled. Coding remains worker-authored until the user separately decides on that proposal. Policy/document work may remain with the primary under coordinator-only.
