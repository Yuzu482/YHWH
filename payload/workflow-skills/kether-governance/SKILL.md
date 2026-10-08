---
name: kether-governance
description: Apply the user's Kether governance workflow to T2 or disputed ChatGPT Work and Codex tasks, including scope contracts, specialist routing, review gates, and evidence-based acceptance. Use when global instructions request Kether governance or the user invokes it; use task-tiers for compact T0/T1 writes.
---

# Kether governance

This skill is the detailed governance reference for the user's Kether workflow. `AGENTS.md` is the sole always-on index; its current tier/profile rules select the required stages. The table below describes role outputs, not mandatory calls for every task. Dispatch model-backed work only through the installed Pi bridge using the live role-bound provider: OpenAI Luna for workers and Claude Sonnet for reviewers, with the exact transport in pi-routing. Do not enter another orchestration runtime or substitute a provider to evade a binding.

## Choose the execution path

1. Identify the actual host capabilities and active authorization. Higher-priority instructions and explicit user intent govern. Loading this skill does not switch the host into Plan mode or grant permissions.
2. Use compact primary mode for non-coding work. All coding, including small fixes, tests and implementation scripts, is authored by bounded Pi workers under the coordinator-only policy. The primary plans, inspects, mechanically integrates accepted patches and verifies; it does not take over failed implementation.
3. Classify the whole goal at the lowest justified tier; explain deliberate escalation with meaningful TIER_REASON= context and read task-tiers only for boundaries. T0 uses Chesed and host checks, without Netzach/Geburah. T1 adds one complexity-selected post-review ≤10 KB; nonblocking findings mean conditional approval without re-review. T2 keeps approved pre-review before writes and independent post-review, medium/high/xhigh by complexity, evidence-gated elastic quotas and aggregate count/time ceilings under pi-review before user escalation. The upgraded known-scope path uses primary planning and complete artifact-bound host verification, without mandatory scout/planner/Netzach calls. Netzach is for unavailable host execution or a concrete independent execution need. Unknown scope still gets one Malkuth scout; tests/config alone do not upgrade. Before runtime upgrade, follow its actual admitted chain. Workers use Pi `openai-codex`; built-in subagents need explicit user request. Primary owns integration and acceptance; workers are actual calls.
4. If mandatory worker capacity is unavailable, coding stays blocked; continue only primary reasoning/diagnosis. Distinguish local review from independent verification. A prompt or role name alone never establishes independent execution; require actual Pi dispatch and accepted worker artifacts. Primary-authored coding needs an explicit subsequent user exception.

## Derive a task agreement

Record goal, original requirements, explicit versus inferred constraints, allowed resources/actions, exclusions, acceptance criteria, authorization basis, dependencies, verification evidence, selected stages, and escalation triggers. Use exact file ownership once discovered. For research or document work use actual sources, artifact paths, document IDs, or allowed ranges instead of invented Git identities. Unknown ownership means discovery remains read-only.

In explicit Plan mode, produce the concrete plan without mutation and wait for authorized transition to execution. In Execute mode, honor authorization already present in the user's request/session; internal pre-review is not another request for user approval. Scope changes require a revised agreement; seek user input only for a material missing decision or authorization. Never treat an answer to a clarification as approval of a separate external action.

## Stages and deliverables

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

The required order follows the canonical `task-tiers` trigger table, not an ad hoc interpretation of "substantive". Scout/planner and model verification are conditional, including known-scope T2 with trusted host evidence on the upgraded protocol. State why a conditional stage is not needed. Read-only tasks gain no write authority. T2 pre-review precedes writes; T1/T2 post-review follows actual verification. Independent review remains required; primary self-review is not independent evidence.

## Bounded delegation

Give each worker one objective, the relevant agreement, allowed files/resources, forbidden changes, dependencies, expected deliverable, and verification requirements. No worker may recursively delegate without explicit authorization. Use the runtime's actual concurrency limit; never assume unavailable parallel capacity.

Tifereth's scheduling function routes -> delegates -> collects -> validates -> transitions. In delegated stages it must not replace missing worker evidence with its own guessed result. Kether resolves scope/policy disputes; workers cannot weaken acceptance or grant themselves new write authority. The host's primary-agent integration requirement still applies.

Use one writer by default. Parallel scouting and review should have non-overlapping questions and bounded outputs. Parallel implementation needs explicit authorization and a reviewed ownership/dependency plan. Preserve unrelated dirty work, inspect drift before integration, and verify combined results. Do not generate commits or worktrees merely to mimic a transaction protocol.

## Model and capability handling

Preserve explicit user choices and the live role bindings. Native workers use gpt-6-luna with task-proportional thinking (medium by default) through Pi when supported; reviewers keep their explicit separate route. If a required route is unavailable, report the blocker rather than substitute. No built-in fallback or primary coding takeover: continue only local reasoning/diagnosis. Da'at is a focused capability bridge when configured; return observations and limitations to the owner without expanding authority.

Bound implementation repairs under coordinator-only and keep the original task scope. Repairs, reassessment, new request IDs and tier changes never reset review budgets: apply pi-review's evidence-gated elastic quotas and aggregate count/time ceilings, with legacy runtime caps until upgraded; escalate if still failing. T1 nonblocking findings are conditional approval without re-review. Security/authority or scope disputes escalate immediately. Repeated tool errors require diagnosis, not an identical retry loop. A missing Pi model or capability is a capability limit. Only an actual Pi run may claim a provider, model, or tool result.

## Evidence and completion

Require observed evidence appropriate to the task: real source/diff, actual command outcome, artifact inspection, API response, or UI read-back. Read the actual project instructions/scripts for tests; never transplant the ExpoGame-specific test:map/test:grid rule into unrelated projects. A reference index is optional and never replaces current evidence.

Return completed/passed only when required acceptance is met. Report failed for a demonstrated defect, blocked for an execution obstacle, and unverified for checks not run or unavailable. If required evidence is missing, the overall result remains incomplete even if an artifact was created. Independent reviewers return findings without editing; verifiers do not silently fix changes. Send correction packets to the writer and check the concrete remaining risk.

Keep user-facing progress concise. Explain material decisions, review failures, or capability substitutions. Final output gives the result, evidence, and limitations rather than a role-play transcript or private chain of thought. Host instructions about tools, approvals, privacy, task creation, external communication, and memory updates remain in force.

For Pi v2 result contracts and stage handoffs, load the host's `pi-contracts` topic (or its installed `agent-references/pi-contracts.md`). This skill does not duplicate that protocol.

For a comparison with the historical DSH preset, read [source mapping](references/source-mapping.md). Only when invoking a compatible DSH Tifereth workflow, read the [strict DSH dispatch contract](references/dsh-contract.md); it is not the native Pi schema.
