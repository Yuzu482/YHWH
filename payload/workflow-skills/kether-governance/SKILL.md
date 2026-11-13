---
name: kether-governance
description: Apply the user's Kether governance workflow to T2 or disputed ChatGPT Work and Codex tasks, including scope contracts, specialist routing, review gates, and evidence-based acceptance. Use when global instructions request Kether governance or the user invokes it; use task-tiers for compact T0/T1 writes.
---

# Kether governance

This skill is a governance reference for the user's Kether workflow. The primary may implement directly or delegate as the host and user authorize. Pi-specific tier, role and stage requirements below apply when actually using Pi or an explicitly scoped legacy Pi contract; they do not grant or remove ordinary host permissions. For Pi dispatch use the live role-bound provider and actual gateway policy. Do not switch a backend or substitute a provider to evade a binding or uncertain operation.

## Choose the execution path

1. Identify the actual host capabilities and active authorization. Higher-priority instructions and explicit user intent govern. Loading this skill does not switch the host into Plan mode or grant permissions.
2. The primary may implement and test directly when authorized, or select bounded Pi work when useful. For Pi-governed implementation follow the coordinator-only contract and preserve its actual worker results, failures and uncertain attempts.
3. For Pi tasks classify the whole goal at the lowest justified tier; explain deliberate escalation with meaningful TIER_REASON= context and read task-tiers for boundaries. T0 uses Chesed and host checks, without Netzach/Geburah. T1 adds the required post-review; T2 keeps approved pre-review before writes and independent post-review, with the actual gateway's quotas and aggregate limits under pi-review. Known scope uses primary planning and artifact-bound host verification; scout/planner/Netzach calls are conditional as the protocol allows. Before runtime upgrade, follow its actual admitted chain. Primary owns integration and acceptance; workers are actual calls.
4. If required Pi capacity is unavailable, do not claim a Pi stage succeeded or bypass an uncertain operation; diagnose and reconcile it under its original identity. Unrelated authorized host work may continue. Distinguish local review from independent verification; a prompt or role name alone never establishes independent execution.

## Derive a task agreement

Record goal, original requirements, explicit versus inferred constraints, allowed resources/actions, exclusions, acceptance criteria, authorization basis, dependencies, verification evidence, selected stages, and escalation triggers. Use exact file ownership once discovered. For research or document work use actual sources, artifact paths, document IDs, or allowed ranges instead of invented Git identities. Unknown ownership means discovery remains read-only.

In explicit Plan mode, produce the concrete plan without mutation and wait for authorized transition to execution. In Execute mode, honor authorization already present in the user's request/session; internal pre-review is not another request for user approval. Scope changes require a revised agreement; seek user input only for a material missing decision or authorization. Never treat an answer to a clarification as approval of a separate external action.

## Pi stages and deliverables

| Stage | Owner | Required output |
| --- | --- | --- |
| compiled | Yesod | Lossless goal, constraints, scope, exclusions, acceptance, and labeled assumptions. |
| clarified | Binah | Resolved material ambiguity, or a reason no clarification is needed. |
| admitted | Tifereth under Kether | Host capability check, authorized mode, feasible stages and dependencies. |
| classified | Hod | Complexity, risk, decomposition value, model availability, escalation triggers. |
| scouted | Malkuth | Read-only current evidence, relevant paths/resources, baseline where relevant, and real verification commands. |
| planned | Chochmah | Bounded packets with ownership, dependencies, acceptance, and verification. |
| pre-review (effective T2 only) | Geburah | Approve, reject, or needs-clarification based on scope, authority, design, and evidence plan. |
| implementing | Chesed | Scoped changes and a record of outcomes, failures, and repair attempts. |
| verifying | Host for T0/T1/T2; Netzach for unavailable host execution or concrete independent execution needs | Actual checks bound to the final artifact, complete named acceptance, evidence and uncovered areas. |
| post-review (T1/T2 only) | Geburah | Compare actual artifacts/diff and verification with the agreement; approve or return concrete findings. |
| final synthesis | Kether / primary | Evidence-backed result and remaining limits, without claiming skipped or failed stages passed. |

For Pi tasks the required order follows the canonical `task-tiers` trigger table. Scout/planner and model verification are conditional where the actual protocol allows. Read-only tasks gain no write authority. Pi T2 pre-review precedes writes; Pi T1/T2 post-review follows actual verification. Required independent review remains required; primary self-review is not independent evidence.

## Bounded delegation

Give each worker one objective, the relevant agreement, allowed files/resources, forbidden changes, dependencies, expected deliverable, and verification requirements. No worker may recursively delegate without explicit authorization. Use the runtime's actual concurrency limit; never assume unavailable parallel capacity.

Tifereth's scheduling function routes -> delegates -> collects -> validates -> transitions. In delegated stages it must not replace missing worker evidence with its own guessed result. Kether resolves scope/policy disputes; workers cannot weaken acceptance or grant themselves new write authority. The host's primary-agent integration requirement still applies.

Use one writer by default. Parallel scouting and review should have non-overlapping questions and bounded outputs. Parallel implementation needs explicit authorization and a reviewed ownership/dependency plan. Preserve unrelated dirty work, inspect drift before integration, and verify combined results. Do not generate commits or worktrees merely to mimic a transaction protocol.

## Model and capability handling

Preserve explicit user choices and the live Pi role bindings. Pi workers use the configured route and task-proportional thinking; reviewers keep their explicit separate route. If a required Pi route is unavailable, report the blocker rather than substitute within that governed task. Unrelated authorized host work may continue. Da'at is a focused capability bridge when configured; return observations and limitations to the owner without expanding authority.

Bound implementation repairs under coordinator-only and keep the original task scope. Repairs, reassessment, new request IDs and tier changes never reset review budgets: apply pi-review's evidence-gated elastic quotas and aggregate count/time ceilings, with legacy runtime caps until upgraded; escalate if still failing. T1 nonblocking findings are conditional approval without re-review. Security/authority or scope disputes escalate immediately. Repeated tool errors require diagnosis, not an identical retry loop. A missing Pi model or capability is a capability limit. Only an actual Pi run may claim a provider, model, or tool result.

## Evidence and completion

Require observed evidence appropriate to the task: real source/diff, actual command outcome, artifact inspection, API response, or UI read-back. Read the actual project instructions/scripts for tests; never transplant the ExpoGame-specific test:map/test:grid rule into unrelated projects. A reference index is optional and never replaces current evidence.

Return completed/passed only when required acceptance is met. Report failed for a demonstrated defect, blocked for an execution obstacle, and unverified for checks not run or unavailable. If required evidence is missing, the overall result remains incomplete even if an artifact was created. Independent reviewers return findings without editing; verifiers do not silently fix changes. Send correction packets to the writer and check the concrete remaining risk.

Keep user-facing progress concise. Explain material decisions, review failures, or capability substitutions. Final output gives the result, evidence, and limitations rather than a role-play transcript or private chain of thought. Host instructions about tools, approvals, privacy, task creation, external communication, and memory updates remain in force.

For Pi v2 result contracts and stage handoffs, load the host's `pi-contracts` topic (or its installed `agent-references/pi-contracts.md`). This skill does not duplicate that protocol.

For a comparison with the historical DSH preset, read [source mapping](references/source-mapping.md). Only when invoking a compatible DSH Tifereth workflow, read the [strict DSH dispatch contract](references/dsh-contract.md); it is not the native Pi schema.
