# Worker thinking and delivery budgets

[简体中文](worker-budgets.md) · [English](worker-budgets.en.md)

On 2026-09-22 the user authorized replacing fixed Luna/max thinking for native OpenAI Codex workers. The current native model is `gpt-6-luna`; the primary chooses effort, decomposes tasks and accepts results, while Pi authors code and tests. Reviewer policy, aggregator API routes, file permissions and resource caps remain unchanged.

| Task | Explicit thinking | Conditions |
| --- | --- | --- |
| Exact, low-risk changes | low | Location, behavior and acceptance are already clear |
| Ordinary bounded implementation | medium | Default; one behavior per task |
| Cross-file design or uncertain diagnosis | high | A specific analysis objective and stopping condition |
| Difficult reasoning | max | The primary records why maximum effort is needed |

The primary assesses the task, then sends explicit `thinking` or uses deterministic adaptive selection for native workers. Explicit effort is always preserved. When omitted, one `TASK_COMPLEXITY_JSON=` entry in `task.context` selects low, medium or high. Missing or invalid assessments conservatively use medium; source excerpts, task length, tier and file count do not infer elevated effort. Reviewers, probes and controlled API routes retain their existing policies. Automatic selection never chooses off, minimal or max. Source behavior is not evidence of deployment.

An assessment must contain exactly four fields: `changeKind` (exact / bounded / design / diagnosis), `uncertainty` (none / localized / unresolved), `coupling` (local / cross-file / concurrent), and `reason` (a concrete explanation of at most 400 characters). Example:

```text
TASK_COMPLEXITY_JSON={"changeKind":"exact","uncertainty":"none","coupling":"local","reason":"Known condition replacement with an unchanged interface and specific regression cases"}
```

Exact, certain, local work selects low only with at most 2 write files and 4 read files, no directory wildcard scope, unresolved dependencies or assumptions, and an observable result for every acceptance criterion. Unresolved uncertainty, concurrent coupling or cross-file design selects high; other cases use medium. This deterministically applies the primary's assessment; it does not prove actual complexity or semantic acceptance. Result `thinkingDecision` records selected effort, its source and fixed reason codes, excluding assessment text.

Before dispatch, run `node scripts/gateway-client.mjs task-plan <request.json>` to check the task locally and obtain explicit effort and preflight advice. It does not connect to the gateway, read gateway credentials, call models, modify the input file or dispatch work. The primary can inspect the returned `request` before using an existing dispatch entrypoint. Successful planning does not prove resource admission, complete authorization or task acceptance.

Scope advice targets one observable behavior per packet, normally at most 3 write files and 8 read files. Keep the implementation, caller and necessary tests together. Larger scopes produce advice to narrow the packet or explain coupling; they do not reject tasks, create subtasks automatically or lower a tier through splitting. Reuse verified facts, bound unknown questions and stopping conditions, and limit repairs to behavior implicated by actual failure evidence.

Each acceptance criterion names its input or trigger, expected result, stable check name, execution method and owner. Code tasks cover the normal path and relevant failure paths; done or return patch alone is insufficient behavioral acceptance. Example: `parser-focused: host runs node --test tests/parser.test.mjs; exit 0; asserts valid input matches expected output and invalid input throws`. Assign checks to the host before dispatch when the worker lacks execution tools. The worker preserves exact names and reports unverified with the actual limitation; the host subsequently records real exit codes and output. Observable-result and owner checks are heuristic advice, not final acceptance.

Each packet delivers one behavior with precise read/write scopes, acceptance and necessary material. Plan roughly 20% of runtime for final output and verification handoff. Prompt timing targets are soft guidance, not hidden reasoning-token limits or completion guarantees. Do not evade failures by disabling thinking, switching models, repeating an unchanged request or widening permissions.

Queue admission and execution have independent deadlines. Total execution includes authentication, startup, model/tools, output and cleanup. Shorter inner execution must not extend the outer deadline. Outputs must still satisfy the existing structure and acceptance rules; partial patches, fragments and timed-out tasks are not automatically successful.

The source computes inner sandbox seconds as `floor(total seconds - elapsed milliseconds/1000 - min(15, total seconds×10%))`. Monotonic elapsed time includes authentication and dispatch preparation; up to 15 seconds are reserved for return and cleanup. If fewer than one whole sandbox second remains, dispatch returns `PI_EXECUTION_BUDGET_EXHAUSTED` before launch. For a 180-second total with 20 seconds consumed, the inner budget is 145 seconds with a 15-second reserve. Result `executionBudget` exposes the calculation while original `resourceLimits` remain unchanged. The prompt's early-delivery target is distinct from this cleanup reserve; cleanup exceeding the reserve may still hit the outer deadline.

Record requested effort, accepted deliveries, quality, execution time and available usage separately. Compare the same task across effort levels before drawing performance conclusions; a short echo or one code delivery cannot establish overall speed or token savings. The medium heartbeat on 2026-09-22 passed, proving only that this explicit effort can complete a short echo on the current native route.

Release source, the running local service and global host rules are separate states. Source edits do not prove deployment or publication; deployment/restarts, Git pushes and releases remain separately authorized actions.
