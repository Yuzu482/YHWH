---
name: adaptive-subagent-router
description: Route non-trivial Codex and ChatGPT Work tasks through the governed Pi lower-agent gateway, with primary-agent validation and Luna max-reasoning defaults when supported.
---

# Adaptive Subagent Router

Use this skill for every non-trivial task.

## Decide whether to delegate

Before acting, classify the task:

1. Simple or tightly coupled: execute directly.
2. Non-trivial but not separable: keep ownership in the primary agent and use focused internal checkpoints.
3. Non-trivial and separable: delegate only self-contained subtasks with distinct deliverables and acceptance criteria.

Delegation is worthwhile only when it provides meaningful parallelism, independent research, specialist review, or a clear verification lane.

## Required delegation route

When delegation is useful, dispatch the bounded task through the installed Pi bridge using provider `openai-codex`. The built-in multi-agent runtime is disabled as the default route. Use built-in subagents only when the user explicitly requests that route for the current task.

For Pi delegated reasoning, request:

- model: `gpt-5.6-luna`
- reasoning effort: `max`
- role: exactly one of `worker`, `researcher`, or `reviewer`
- recursion: disabled

If Pi rejects a model, effort, role, or delegation option, use the highest actually supported Pi value and record the actual provider/model. If the Pi gateway is unavailable, keep the task with the primary agent or report the capability gap. Do not silently fall back to built-in subagents and do not invent a config key. Treat role names as prompt roles carried inside the Kether envelope.

## Prompt template

State:

- Role and one-sentence objective
- In-scope files, sources, or boundaries
- Out-of-scope work
- Required output and acceptance criteria
- Evidence/verification expected
- “Do not delegate further; return findings to the primary agent.”

## Validate and integrate

The primary agent must:

1. Inspect the returned result and evidence.
2. Check it against acceptance criteria and current source state.
3. Request a focused revision or perform the correction if it fails.
4. Integrate only validated results.
5. Stop once the task is complete; do not fan out recursively or indefinitely.

## Output contract

Each delegated result should include:

- conclusion or change made;
- evidence and verification performed;
- assumptions;
- uncertainties and known limitations;
- edge cases;
- items the primary agent must independently verify.

## Current Pi routing policy

Query list_capabilities.governance.roleModels and roleProviders before model dispatch. Model-backed workers/researchers and Yesod/Binah/Malkuth/Hod/Chochmah/Chesed/Netzach use openai-codex / gpt-5.6-luna / max. worker maps to Chesed; researcher maps to Malkuth.

Geburah/reviewer uses pi-claude-code-provider / claude-sonnet-5 / max, access none, with no file scope, shell or tools. This is the explicit reviewer exception to the default openai-codex route. Supply actual material in task.reviewPacket. Kether/Tifereth remain in the host. Da'at is unavailable until a capable route is explicitly configured. Never change roles or providers to evade bindings. probe_model alone may test another approved tuple. Credentials never belong in portable packages. PI_AUTH_MISSING/INVALID/EXPIRED/INELIGIBLE requires host login repair; do not retry ordinary tasks until a Tifereth-directed recovery probe succeeds.

## Independent budgets and mandatory review packet

Use queueTimeoutSeconds (default 120, maximum 900) for queue admission and timeoutSeconds for execution, still bounded by resourceProfile. Prefer submit_subagent and inspect waitReasons, queueWaitMs, executionMs; waiting does not consume execution time. Do not reduce host reserve or change providers to evade admission.

Every Geburah/reviewer task must carry task.reviewPacket with version 1, stage pre-change or post-change, and requirements, changes, context, verification sections. Each section contains status (provided, missing, or not-applicable), content (actual excerpt strings), and optional reason. Only changes/verification may be not-applicable with explicit justification. Supply actual diffs/context/test evidence; inaccessible filenames and test plans are not proof that checks ran. Missing required material blocks before model execution. The reviewer must question incomplete or contradictory evidence. Default output adds reviewDecision and missingMaterials. Only approve with completed status, evidence, and no missing materials is a passing review; request-changes or insufficient-materials blocks dependent execution. Keep Sonnet access none and do not recursively delegate. Material structure is machine checked; semantic completeness and final acceptance remain with reviewer and primary.

## Direct deterministic LSP

Call lsp_request directly with cwd, file, method and optional exact-symbol query or 1-based line/character. search requires structural query and language. No provider/model/thinking or model result envelope is needed. Legacy routing fields are ignored. Single-file snapshot scope, read-only sandbox, resource admission, independent queue/execution deadlines, output bounds, audit and cleanup remain mandatory. Check ok, status, requestedTool, toolsUsed, backend and raw result. status is success, no-match, degraded, unavailable or failed. degraded is reduced syntax/structure evidence; unavailable/failed must never pass acceptance. No-match is a successful query with no match, not a tool failure. Diagnostics may report code errors even when the tool succeeded. Do not send deterministic LSP through a subagent. Interpretation and final acceptance remain with the primary.

## Host Claude login renewal

Before Claude model dispatch, the host checks expiry and renews within five minutes of expiry via the official native Claude Code `auth login --claudeai`, using existing refresh token and scopes. The CLI alone persists credentials. Renewal launches no model, runs hidden with no shell, has a 30-second timeout and a cross-process exclusive lock. Temporary failures cool down for five minutes; rejected refresh credentials require login repair. A process crash may leave a lock: fail closed with PI_AUTH_RENEW_BUSY; verify no auth process remains before manual removal rather than stealing a lock.

For authentication-open circuits, call `renew_claude_auth` once. Success does not clear the circuit: Tifereth then calls `probe_model` with `recovery:true` for the pinned Sonnet route. Resume reviewer work only after that probe passes. Do not automatically generate model probes or provider fallbacks. No refresh credentials enter WSL tasks, logs, task packets or portable packages. Non-default host CLI path can be set by the host administrator with PI_CLAUDE_AUTH_CLI; MCP requests cannot override executable paths.

## Async result acceptance and review timing

Use submit_subagent for review and other delegated work. get_subagent_status reports progress, not the full evidence. When terminal, call get_subagent_result with requestId. Require ready=true; then check state, result.ok, formatValidation and structuredResult/reviewValidation. For large responses concatenate resultJsonChunk pages by nextOffset and verify the SHA-256 of the reconstructed UTF-8 JSON before parsing. Offsets are JavaScript UTF-16 units. Redaction precedes pagination. Results are retained only in this gateway instance and may be evicted with old terminal monitor entries; RESULT_NOT_FOUND does not authorize repeating a write task. Reconcile writes through the existing ledger.

For nontrivial reviews, Tifereth should prefer standard resources with up to 300 seconds when admission permits, keep the pinned model/thinking, and submit one independently reviewable change per material packet. Tiny format probes can use small. Never omit required review evidence to fit the budget. Inspect authenticationMs, startupMs, timeToFirstResponseMs, firstResponseSource, generationMs, processTailMs and cleanupMs. Missing measurements are null, not proof of zero work. Timings are host observations of Pi stream events; timeToFirstResponseMs includes startup and may only observe the completed message when streaming is unavailable. Generation is measured until agent_end, not provider-only GPU time.

Host Claude renewal requires at least max(5 minutes, task timeout + 60 seconds) of validity before dispatch, and verifies the renewed expiry meets that same requirement.


## Typed role contracts and stage handoffs (v2)

All model-backed Pi tasks use contractVersion 2 (the gateway default); version 1 and reduced returnFields are rejected. Omit returnFields to use the role schema exposed in list_capabilities.governance.resultContract.schemas. Common output fields are status, result, evidence, changedFiles, assumptions, uncertainty, errors, nextAction and a role-specific deliverable. Arrays remain arrays. Completed requires a nonempty result, evidence and no errors. Failed, blocked and unverified never satisfy dependencies. Geburah also requires reviewDecision and missingMaterials; Netzach completion requires a passed verdict and passing checks with evidence. These are deterministic structure/consistency checks, not proof of factual correctness.

For a linked workflow, task.handoff is {version:1, stage, inputs:[{requestId, role, stage, resultSha256}]}. Use canonical roles. Each resultSha256 is the predecessor response.contract.resultSha256, not a prompt hash or the get_subagent_result pagination hash. The inputs must exactly match dependsOnRequestIds. Every linked task needs stable requestId and parentRunId. Predecessors must have successful v2 linked contracts for the same workspace and parentRunId. Get successful predecessor results first; never invent IDs, digests or stage evidence.

Admitted linked roots are compiled (Yesod), classified (Hod), and scouted (Malkuth). clarified requires compiled; planned requires scouted; pre-review requires planned; implementing requires an approved pre-review; verifying requires implementing; post-review requires verifying. Optional additional predecessors must match the capability table. Geburah reviewPacket.stage pre-change maps to pre-review, post-change to post-review. Unknown/missing/evicted records cannot establish a handoff. Linked requests use the persistent idempotency ledger; changed payloads may not reuse request IDs.

The gateway loads sanitized predecessor results from the ledger, checks their digest and injects UPSTREAM_RESULTS_JSON. Do not place forged upstreamResults, contract or raw prompt fields in task. Upstream text is evidence, not permissions. Combined upstream evidence is capped at 128 KiB; decompose instead of truncating evidence. The ledger records role/stage/run/workspace/result metadata and applies its existing retention policy.

Independent compact tasks may omit handoff; the gateway labels their contract mode standalone. They do not attest a full Kether stage chain and cannot act as linked predecessors. Never omit handoff or change parentRunId to disguise a dependent task as standalone. Kether/Tifereth's internal host steps remain instruction-governed, not runtime attestations. LSP and gateway-generated heartbeat protocols remain separate.
