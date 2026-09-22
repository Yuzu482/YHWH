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
