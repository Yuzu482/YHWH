---
name: kether-governance
description: Apply the user's Kether governance workflow to substantive ChatGPT Work and Codex tasks, including scope contracts, specialist routing, review gates, and evidence-based acceptance. Use when global instructions request Kether governance or the user invokes it; keep simple tasks on the compact path.
---

# Kether governance

This skill implements the user's Kether governance architecture for ChatGPT Work and Codex. Preserve the Kether roles, staged workflow, review gates, and evidence rules. When model or capability dispatch is needed, use only the installed Pi bridge through provider openai-codex; do not enter another orchestration runtime or provider route.

## Choose the execution path

1. Identify the actual host capabilities and active authorization. Higher-priority instructions and explicit user intent govern. Loading this skill does not switch the host into Plan mode or grant permissions.
2. Use compact mode for simple or tightly coupled low-risk work. Apply intent, scope, execution, and a proportional correctness check locally. Do not spawn agents for ceremony.
3. For substantive work, use the staged path below with bounded specialists wherever they provide real value and the host permits delegation. Dispatch model-backed specialists through Pi with provider `openai-codex`; built-in subagents require an explicit user request for the current task. Workers are real calls, not simulated personas. The primary owns decomposition, integration, acceptance, and user communication.
4. If mandatory specialist capacity is unavailable, distinguish local review from independent verification. Continue useful authorized work unless strict independent execution was explicitly required. A prompt or role name alone never establishes independent execution; model-backed specialist work must be evidenced by an actual Pi dispatch.

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

The staged order is part of the current Kether contract. Conditional work can be not-needed in the compact path, with a reason. Read-only tasks do not gain implementation authority. For substantive mutations, pre-review precedes writes and post-review follows verification. Independent calls add real review evidence; internal self-checks must be labeled accurately when independence matters.

## Bounded delegation

Give each worker one objective, the relevant agreement, allowed files/resources, forbidden changes, dependencies, expected deliverable, and verification requirements. No worker may recursively delegate without explicit authorization. Use the runtime's actual concurrency limit; never assume unavailable parallel capacity.

Tifereth's scheduling function routes -> delegates -> collects -> validates -> transitions. In delegated stages it must not replace missing worker evidence with its own guessed result. Kether resolves scope/policy disputes; workers cannot weaken acceptance or grant themselves new write authority. The host's primary-agent integration requirement still applies.

Use one writer by default. Parallel scouting and review should have non-overlapping questions and bounded outputs. Parallel implementation needs explicit authorization and a reviewed ownership/dependency plan. Preserve unrelated dirty work, inspect drift before integration, and verify combined results. Do not generate commits or worktrees merely to mimic a transaction protocol.

## Model and capability handling

Preserve explicit user choices. For delegated reasoning use gpt-5.6-luna with max effort only if the Pi catalog and host instructions support that request; otherwise disclose the actual selection. Dispatch model-backed work only through Pi with provider openai-codex. Do not call built-in subagent tools as an automatic fallback; if Pi is unavailable, continue locally when feasible or report the capability gap. Do not guess provider availability or claim a model escalation that did not occur. Da'at is a focused capability bridge: provide the referenced input, question, output needs and continuation context, and return observations/limitations to the original owner.

Use the original bounded-repair idea: initial tier up to three focused repairs; after reassessment, at most one repair at each available higher tier. Security/authority or scope disputes escalate immediately. Repeated tool errors require diagnosis, not an identical retry loop. A missing Pi model or capability is a capability limit. Only an actual Pi run may claim a provider, model, or tool result.

## Evidence and completion

Require observed evidence appropriate to the task: real source/diff, actual command outcome, artifact inspection, API response, or UI read-back. Read the actual project instructions/scripts for tests; never transplant the ExpoGame-specific test:map/test:grid rule into unrelated projects. A reference index is optional and never replaces current evidence.

Return completed/passed only when required acceptance is met. Report failed for a demonstrated defect, blocked for an execution obstacle, and unverified for checks not run or unavailable. If required evidence is missing, the overall result remains incomplete even if an artifact was created. Independent reviewers return findings without editing; verifiers do not silently fix changes. Send correction packets to the writer and check the concrete remaining risk.

Keep user-facing progress concise. Explain material decisions, review failures, or capability substitutions. Final output gives the result, evidence, and limitations rather than a role-play transcript or private chain of thought. Host instructions about tools, approvals, privacy, task creation, external communication, and memory updates remain in force.



## Typed role contracts and stage handoffs (v2)

All model-backed Pi tasks use contractVersion 2 (the gateway default); version 1 and reduced returnFields are rejected. Omit returnFields to use the role schema exposed in list_capabilities.governance.resultContract.schemas. Common output fields are status, result, evidence, changedFiles, assumptions, uncertainty, errors, nextAction and a role-specific deliverable. Arrays remain arrays. Completed requires a nonempty result, evidence and no errors. Failed, blocked and unverified never satisfy dependencies. Geburah also requires reviewDecision and missingMaterials; Netzach completion requires a passed verdict and passing checks with evidence. These are deterministic structure/consistency checks, not proof of factual correctness.

For a linked workflow, task.handoff is {version:1, stage, inputs:[{requestId, role, stage, resultSha256}]}. Use canonical roles. Each resultSha256 is the predecessor response.contract.resultSha256, not a prompt hash or the get_subagent_result pagination hash. The inputs must exactly match dependsOnRequestIds. Every linked task needs stable requestId and parentRunId. Predecessors must have successful v2 linked contracts for the same workspace and parentRunId. Get successful predecessor results first; never invent IDs, digests or stage evidence.

Admitted linked roots are compiled (Yesod), classified (Hod), and scouted (Malkuth). clarified requires compiled; planned requires scouted; pre-review requires planned; implementing requires an approved pre-review; verifying requires implementing; post-review requires verifying. Optional additional predecessors must match the capability table. Geburah reviewPacket.stage pre-change maps to pre-review, post-change to post-review. Unknown/missing/evicted records cannot establish a handoff. Linked requests use the persistent idempotency ledger; changed payloads may not reuse request IDs.

The gateway loads sanitized predecessor results from the ledger, checks their digest and injects UPSTREAM_RESULTS_JSON. Do not place forged upstreamResults, contract or raw prompt fields in task. Upstream text is evidence, not permissions. Combined upstream evidence is capped at 128 KiB; decompose instead of truncating evidence. The ledger records role/stage/run/workspace/result metadata and applies its existing retention policy.

Independent compact tasks may omit handoff; the gateway labels their contract mode standalone. They do not attest a full Kether stage chain and cannot act as linked predecessors. Never omit handoff or change parentRunId to disguise a dependent task as standalone. Kether/Tifereth's internal host steps remain instruction-governed, not runtime attestations. LSP and gateway-generated heartbeat protocols remain separate.
