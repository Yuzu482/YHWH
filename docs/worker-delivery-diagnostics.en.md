# Worker delivery diagnostics

[简体中文](worker-delivery-diagnostics.md) | [English](worker-delivery-diagnostics.en.md)

The gateway exposes stream event counts and recent activity in `phaseTimings.stream` to help distinguish extended reasoning, text generation, tool execution and process tail. The field travels with execution progress, terminal results and audit records. Existing services must upgrade the corresponding module before exposing it. Source changes do not establish a local deployment or a new release.

| Field | Meaning |
| --- | --- |
| `thinkingDeltas` / `textDeltas` | Observed thinking / text delta event counts, not token counts |
| `toolStarts` / `toolEnds` / `toolErrors` | Tool start / end / explicitly failed end event counts |
| `firstTextMs` | Milliseconds from sandbox execution start to the first text event; null if unobserved |
| `lastEventMs` | Milliseconds from the same start to the latest recognized event; null if none |
| `lastEventType` | A fixed event type without tool names or content |

Only an explicit text delta or an assistant message ending with nonempty text establishes `firstTextMs`. Without `agent_end`, `generationMs` remains null. Recent activity does not establish current remote-model health, and thinking events do not establish delivery of code. Event counts are not model call counts; retries and multiple turns require separate evidence.

Only counts, timings and allowed event types are retained. Prompts, raw reasoning, text, tool arguments, tool results and credentials are excluded. Unknown events are ignored and snapshots copy the counters. Existing bounded parsing of split JSON remains in place; no timers or model requests are added.

The total execution deadline still includes authentication, startup, model and tool activity, process exit and cleanup. This change neither extends budgets nor changes success criteria. Scheduler timeouts may replace execution results, while recent phase metadata remains available for diagnosis. Missing statistics in old records mean unknown: old audit tool total:0/errors:0 values may be defaults and do not establish zero calls or errors.

The primary retains the strict prohibition on repeated polling. These fields are not a completion-wait interface and do not automatically wake the primary, cancel or retry work, switch models, or transfer coding to the primary. Completion waits and controlled delivery templates require separate implementation and acceptance.

Deterministic tests cover thinking versus text, tool outcomes, unknown events, exclusion of raw content, snapshot isolation, split input, retention through close/cleanup and missing completion events. They do not fully establish the cause of real model timeouts or replace bounded testing after deployment.

### Candidate delivery and host acceptance

`get_task_handoff` returns an evidence projection bound to one implementation requestId and artifactSha256; `wait_task_handoff` is a one-shot event-driven wait and never dispatches or cancels work. A completed worker stage is not final acceptance of its artifact: after host checks pass, T1/T2 still require their prescribed independent post-review. Only a durable `task_accepted` receipt bound to the same candidate and proof yields `accepted`. Missing, damaged, or restart-in-doubt evidence is neither a pass nor actual negative evidence. Repairs retain failed history and use a new stable requestId; manual checks and post-review submission remain host actions. This state does not mean an entire multi-phase plan is complete.

`executionLimitation` may mark a host check not run only when implementation is done, overall status is `completed`, `errors: []`, and its `outcome` is `"unverified"`: `{executor: "host", reason: "worker-execution-unavailable"}`. This is not execution evidence; it is invalid with `passed` / `failed` or extra keys. Awaiting host verification (`awaiting-host-verification`) means a candidate was delivered and its check remains unrun—not final success or automatic failure. The primary must run real commands, record exit codes, and bind evidence to the artifact record with `record_host_verification`; T0 then completes, T1 still requires Geburah post-review, and T2 retains its prescribed gates. This marker grants no extra execution or shell permission and cannot fabricate passing checks.
