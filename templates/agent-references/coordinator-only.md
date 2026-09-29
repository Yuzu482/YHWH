# Coordinator-only primary execution

The user's selected primary model (Astra on this host) owns reasoning, requirements, architecture, decomposition, scheduling, evidence review, integration decisions and final acceptance. Actual implementation is delegated to Pi subagents, normally `openai-codex / gpt-6-luna` as Chesed with task-proportional thinking (medium by default; see pi-routing). This rule takes precedence over older instructions to keep simple coding local, fix worker output directly, or implement locally when Pi is unavailable. It does not change higher-priority host permissions or reviewer role bindings.

## Ownership

- The primary may inspect sources, use deterministic LSP, run existing verification commands, write plans/policy and review documents, and mechanically apply an accepted worker patch after checking its scope and base. Applying a patch is integration, not primary authorship.
- Source changes, tests, implementation scripts, generated-code generators, refactors, bug fixes and conflict resolutions that require new code must be authored by workers. A small edit is still implementation. Do not implement through an inline shell/Python/JavaScript script to disguise primary authorship.
- A tightly coupled change goes to one bounded worker rather than back to the primary. Parallel workers require disjoint ownership and independent acceptance; default to one writer. No recursive delegation or built-in-agent fallback unless explicitly authorized.
- General questions, analysis, policy decisions and deterministic checks need no model subagent merely for ceremony. Normal approval requirements still apply to external actions and credential handling.

## Dispatch and acceptance

1. Read current Pi capabilities. Compile a small packet with one deliverable, explicit file scopes, exclusions, dependency boundaries, verification and a stable request/run ID. Preserve the live Luna provider/model binding and select thinking under pi-routing; do not substitute a provider or role to evade a failure.
2. Classify the whole write under `task-tiers` and perform host planning. T2 requires approved independent pre-review before writes; T0/T1 record why pre-review is not needed. If an independent review could not run, label that fact and do not claim its stage passed. Standalone T0/T1 packets cannot claim a runtime-attested linked chain; real linked predecessors retain all typed handoff requirements.
3. Choose a supported resource profile that fits current admission. Start with a small file scope and bounded output rather than a repository-wide investigation. Inspect queue versus execution timing before revising the budget. Do not reduce host reserve or other safety limits.
4. T0 may use one synchronous dispatch. Submit T1/T2 asynchronously. Do useful independent coordination while waiting. Astra must not repeatedly poll, including sleep/query loops or script-wrapped polling. Use actual completion waits or query-free waiting until a genuine event, predeclared deadline or user request. Retrieve the full terminal result once, with required pagination/digest checks; a pending response does not authorize another polling loop.
5. Require successful execution, correct provider/model, valid role output, successful cleanup and a real in-scope patch. Inspect the patch and workspace base before mechanical application. Run existing focused checks; test failures or substantive patch corrections return to a worker. The primary retains semantic acceptance.
   For a small change with complete, authorized source material, a worker may use access:none to deliver an explicit patch or exact replacements in its structured result. This still requires real worker authorship and successful artifact delivery. It does not modify host files or prove tests passed; report changedFiles and unverified checks accordingly. Never use this mode to evade a rejected data disclosure or conceal a failed/uncertain write.
6. Record tier and declaration, request ID, role/model, outcome, patch/files, checks and review independence. A T1/T2 result is not finally accepted until required post-review approves. Count a queued cancellation, blocked dispatch, heartbeat or deterministic probe separately from completed implementation. Never count a tool result read as another model execution.

A worker result marked unverified or blocked solely because no test or command tool was available is not, by itself, an unusable patch. The primary checks `changedFiles` against the declared `writeScope` and current workspace base, then mechanically applies an in-scope patch and runs the applicable acceptance tests, typecheck and build. Save the actual commands and outputs as host verification evidence. Passing host checks may establish host verification without implying that independent review ran. If checks fail, return the failing outputs verbatim to the same worker for a bounded repair, then rerun the host checks; do not treat the worker's repair as verified until they pass.

Do not retry the same objective by changing access mode. Allow at most two dispatches for that objective; before deciding on any further dispatch, the primary must execute a validation. A retry after confirmed zero execution still counts toward this limit.

For `access:none`, include the necessary real source material in the task context and omit `readScope` and `writeScope`. If the worker needs to read files or write in the workspace, use an appropriate read or workspace-write access mode instead; do not use access-mode changes to evade a restriction or failed disclosure.

Use only canonical roles, such as Chesed, Malkuth, Geburah and Netzach, with their established bindings. Before dispatch, call `list_capabilities` and verify that the working directory is within the roots it reports; if it is not, do not dispatch.

## Failures

If a worker is unavailable, blocked, times out or returns no usable patch, coding remains blocked; the primary continues diagnosis/planning but does not take over implementation. Reconcile a possibly executed write through its original request ID and actual patch/workspace state before any new attempt. A confirmed queued cancellation with zero execution may be replanned with a fitting resource profile and a new documented ID. Bound focused repairs; do not repeat the same unsuccessful packet indefinitely. A primary-coding exception requires an explicit subsequent user instruction.

Independent reviewers retain their separately pinned role/provider and access:none. Do not send private review materials after an approval rejection, relabel a worker as reviewer, or treat host self-review as independent approval. Report unavailable independence accurately without silently changing the implementation owner.

## Enforcement boundary

This is a host instruction and audit policy. Pi can validate its own invocation and sandbox writes; it cannot disable every arbitrary editor or shell in Codex, Claude or another host. A metadata field or successful heartbeat is not proof of compliance. Verify worker provenance and accepted patches for each actual implementation task. Updating this policy does not itself authorize service restarts, releases or Git pushes.
