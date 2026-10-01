---
name: kether-governance
description: Apply the user's Kether governance workflow to T2 or disputed ChatGPT Work and Codex tasks, including scope contracts, specialist routing, review gates, and evidence-based acceptance. Use when global instructions request Kether governance or the user invokes it; use task-tiers for compact T0/T1 writes.
---

# Kether governance

This skill is the detailed governance reference for the user's Kether workflow. `AGENTS.md` is the sole always-on index. Preserve the Kether roles, staged workflow, review gates, and evidence rules. Dispatch model-backed work only through the installed Pi bridge using the live role-bound provider: OpenAI Luna for workers and Anthropic Sonnet for reviewers. Do not enter another orchestration runtime or substitute a provider to evade a binding.

## Choose the execution path

1. Identify the actual host capabilities and active authorization. Higher-priority instructions and explicit user intent govern. Loading this skill does not switch the host into Plan mode or grant permissions.
2. Use compact primary mode for non-coding work. All coding, including small fixes, tests and implementation scripts, is authored by bounded Pi workers under the coordinator-only policy. The primary plans, inspects, mechanically integrates accepted patches and verifies; it does not take over failed implementation.
3. Classify workspace writes under the host's `task-tiers` reference. T0 uses Chesed and Netzach; T1 adds Geburah post-review; T2 uses the full staged path below with approved pre-review before mutation. Dispatch model-backed specialists through Pi with provider `openai-codex`; built-in subagents require an explicit user request for the current task. Workers are real calls, not simulated personas. The primary owns decomposition, integration, acceptance, and user communication.
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
| pre-review | Geburah | Approve, reject, or needs-clarification based on scope, authority, design, and evidence plan. |
| implementing | Chesed | Scoped changes and a record of outcomes, failures, and repair attempts. |
| verifying | Netzach | Actual checks against acceptance, evidence, uncovered areas, and next actions. |
| post-review | Geburah | Compare actual artifacts/diff and verification with the agreement; approve or return concrete findings. |
| final synthesis | Kether / primary | Evidence-backed result and remaining limits, without claiming skipped or failed stages passed. |

The staged order is part of the current Kether contract. Apply the canonical `task-tiers` trigger table rather than interpreting "substantive" or "non-trivial" ad hoc. Conditional stages can be not-needed in T0/T1 with a reason. Read-only tasks do not gain implementation authority. T2 pre-review precedes writes; T1/T2 post-review follows verification. Independent calls add real review evidence; internal self-checks must be labeled accurately when independence matters.

## Bounded delegation

Give each worker one objective, the relevant agreement, allowed files/resources, forbidden changes, dependencies, expected deliverable, and verification requirements. No worker may recursively delegate without explicit authorization. Use the runtime's actual concurrency limit; never assume unavailable parallel capacity.

Tifereth's scheduling function routes -> delegates -> collects -> validates -> transitions. In delegated stages it must not replace missing worker evidence with its own guessed result. Kether resolves scope/policy disputes; workers cannot weaken acceptance or grant themselves new write authority. The host's primary-agent integration requirement still applies.

Use one writer by default. Parallel scouting and review should have non-overlapping questions and bounded outputs. Parallel implementation needs explicit authorization and a reviewed ownership/dependency plan. Preserve unrelated dirty work, inspect drift before integration, and verify combined results. Do not generate commits or worktrees merely to mimic a transaction protocol.

## Model and capability handling

Preserve explicit user choices and the live role bindings. Native workers use gpt-6-luna with task-proportional thinking (medium by default) through Pi when supported; reviewers keep their explicit separate route. If a required route is unavailable, report the blocker rather than substitute. No built-in fallback or primary coding takeover: continue only local reasoning/diagnosis. Da'at is a focused capability bridge when configured; return observations and limitations to the owner without expanding authority.

Use the original bounded-repair idea: initial tier up to three focused repairs; after reassessment, at most one repair at each available higher tier. Security/authority or scope disputes escalate immediately. Repeated tool errors require diagnosis, not an identical retry loop. A missing Pi model or capability is a capability limit. Only an actual Pi run may claim a provider, model, or tool result.

## Evidence and completion

Require observed evidence appropriate to the task: real source/diff, actual command outcome, artifact inspection, API response, or UI read-back. Read the actual project instructions/scripts for tests; never transplant the ExpoGame-specific test:map/test:grid rule into unrelated projects. A reference index is optional and never replaces current evidence.

Return completed/passed only when required acceptance is met. Report failed for a demonstrated defect, blocked for an execution obstacle, and unverified for checks not run or unavailable. If required evidence is missing, the overall result remains incomplete even if an artifact was created. Independent reviewers return findings without editing; verifiers do not silently fix changes. Send correction packets to the writer and check the concrete remaining risk.

Keep user-facing progress concise. Explain material decisions, review failures, or capability substitutions. Final output gives the result, evidence, and limitations rather than a role-play transcript or private chain of thought. Host instructions about tools, approvals, privacy, task creation, external communication, and memory updates remain in force.

For Pi v2 result contracts and stage handoffs, load the host's `pi-contracts` topic (or its installed `agent-references/pi-contracts.md`). This skill does not duplicate that protocol.

For a comparison with the historical DSH preset, read [source mapping](references/source-mapping.md). Only when invoking a compatible DSH Tifereth workflow, read the [strict DSH dispatch contract](references/dsh-contract.md); it is not the native Pi schema.
