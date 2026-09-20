# Coordinator-only primary execution

The user's selected primary model (Astra on this host) owns reasoning, requirements, architecture, decomposition, scheduling, evidence review, integration decisions and final acceptance. Actual implementation is delegated to Pi subagents, normally `openai-codex / gpt-5.6-luna / max` as Chesed. This rule takes precedence over older instructions to keep simple coding local, fix worker output directly, or implement locally when Pi is unavailable. It does not change higher-priority host permissions or reviewer role bindings.

## Ownership

- The primary may inspect sources, use deterministic LSP, run existing verification commands, write plans/policy and review documents, and mechanically apply an accepted worker patch after checking its scope and base. Applying a patch is integration, not primary authorship.
- Source changes, tests, implementation scripts, generated-code generators, refactors, bug fixes and conflict resolutions that require new code must be authored by workers. A small edit is still implementation. Do not implement through an inline shell/Python/JavaScript script to disguise primary authorship.
- A tightly coupled change goes to one bounded worker rather than back to the primary. Parallel workers require disjoint ownership and independent acceptance; default to one writer. No recursive delegation or built-in-agent fallback unless explicitly authorized.
- General questions, analysis, policy decisions and deterministic checks need no model subagent merely for ceremony. Normal approval requirements still apply to external actions and credential handling.

## Dispatch and acceptance

1. Read current Pi capabilities. Compile a small packet with one deliverable, explicit file scopes, exclusions, dependency boundaries, verification and a stable request/run ID. Preserve the live Luna/max binding; do not substitute a provider or role to evade a failure.
2. Perform host planning and pre-review. If no independent review was performed, label that fact. A standalone implementation packet records local host pre-review and cannot claim a runtime-attested linked chain; real linked predecessors retain all typed handoff requirements.
3. Choose a supported resource profile that fits current admission. Start with a small file scope and bounded output rather than a repository-wide investigation. Inspect queue versus execution timing before revising the budget. Do not reduce host reserve or other safety limits.
4. Submit asynchronously. Do useful independent coordination while waiting. Astra must not repeatedly poll, including sleep/query loops or script-wrapped polling. Follow [async results](pi-results.md): actual completion waits or query-free waiting until a genuine event, predeclared deadline or user request. Retrieve the full terminal result once, with required pagination/digest checks; a pending response does not authorize another polling loop.
5. Require successful execution, correct provider/model, valid role output, successful cleanup and a real in-scope patch. Inspect the patch and workspace base before mechanical application. Run existing focused checks; test failures or substantive patch corrections return to a worker. The primary retains semantic acceptance.
   For a small change with complete, authorized source material, a worker may use access:none to deliver an explicit patch or exact replacements in its structured result. This still requires real worker authorship and successful artifact delivery. It does not modify host files or prove tests passed; report changedFiles and unverified checks accordingly. Never use this mode to evade a rejected data disclosure or conceal a failed/uncertain write.
6. Record request ID, role/model, outcome, patch/files, checks and review independence. Count a queued cancellation, blocked dispatch, heartbeat or deterministic probe separately from completed implementation. Never count a tool result read as another model execution.

## Failures

If a worker is unavailable, blocked, times out or returns no usable patch, coding remains blocked; the primary continues diagnosis/planning but does not take over implementation. Reconcile a possibly executed write through its original request ID and actual patch/workspace state before any new attempt. A confirmed queued cancellation with zero execution may be replanned with a fitting resource profile and a new documented ID. Bound focused repairs; do not repeat the same unsuccessful packet indefinitely. A primary-coding exception requires an explicit subsequent user instruction.

Independent reviewers retain their separately pinned role/provider and access:none. Do not send private review materials after an approval rejection, relabel a worker as reviewer, or treat host self-review as independent approval. Report unavailable independence accurately without silently changing the implementation owner.

## Enforcement boundary

This is a host instruction and audit policy. Pi can validate its own invocation and sandbox writes; it cannot disable every arbitrary editor or shell in Codex, Claude or another host. A metadata field or successful heartbeat is not proof of compliance. Verify worker provenance and accepted patches for each actual implementation task. Updating this policy does not itself authorize service restarts, releases or Git pushes.
