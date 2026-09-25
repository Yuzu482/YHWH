# Worker thinking and delivery budgets

[简体中文](worker-budgets.md) · [English](worker-budgets.en.md)

On 2026-09-22 the user authorized replacing fixed Luna/max thinking for native OpenAI Codex workers. The current native model is `gpt-6-luna`; the primary chooses effort, decomposes tasks and accepts results, while Pi authors code and tests. Reviewer policy, aggregator API routes, file permissions and resource caps remain unchanged.

| Task | Explicit thinking | Conditions |
| --- | --- | --- |
| Exact, low-risk changes | low | Location, behavior and acceptance are already clear |
| Ordinary bounded implementation | medium | Default; one behavior per task |
| Cross-file design or uncertain diagnosis | high | A specific analysis objective and stopping condition |
| Difficult reasoning | max | The primary records why maximum effort is needed |

The primary selects effort; this is not an automatic complexity classifier. Send `thinking` explicitly and record the reason in task context. Older services may still advertise max as their default; explicit parameters take precedence, and source defaults are not evidence of deployed behavior. Existing API transport capability restrictions do not automatically change with this native-route adjustment.

Each packet delivers one behavior with precise read/write scopes, acceptance and necessary material. Plan roughly 20% of runtime for final output and verification handoff. Prompt timing targets are soft guidance, not hidden reasoning-token limits or completion guarantees. Do not evade failures by disabling thinking, switching models, repeating an unchanged request or widening permissions.

Queue admission and execution have independent deadlines. Total execution includes authentication, startup, model/tools, output and cleanup. Shorter inner execution must not extend the outer deadline. Outputs must still satisfy the existing structure and acceptance rules; partial patches, fragments and timed-out tasks are not automatically successful.

The source computes inner sandbox seconds as `floor(total seconds - elapsed milliseconds/1000 - min(15, total seconds×10%))`. Monotonic elapsed time includes authentication and dispatch preparation; up to 15 seconds are reserved for return and cleanup. If fewer than one whole sandbox second remains, dispatch returns `PI_EXECUTION_BUDGET_EXHAUSTED` before launch. For a 180-second total with 20 seconds consumed, the inner budget is 145 seconds with a 15-second reserve. Result `executionBudget` exposes the calculation while original `resourceLimits` remain unchanged. The prompt's early-delivery target is distinct from this cleanup reserve; cleanup exceeding the reserve may still hit the outer deadline.

Record requested effort, accepted deliveries, quality, execution time and available usage separately. Compare the same task across effort levels before drawing performance conclusions; a short echo or one code delivery cannot establish overall speed or token savings. The medium heartbeat on 2026-09-22 passed, proving only that this explicit effort can complete a short echo on the current native route.

Release source, the running local service and global host rules are separate states. Source edits do not prove deployment or publication; deployment/restarts, Git pushes and releases remain separately authorized actions.
