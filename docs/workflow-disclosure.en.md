# Progressive workflow loading acceptance

The always-visible primary text is `templates/host-primary.md` plus `payload/pi-dispatch/skills/pi-dispatch/SKILL.md`; a test limits their combined UTF-8 size to 8 KB (8000 bytes). Policy topics come from `templates/agent-references/*.md` and `payload/workflow-skills/*/SKILL.md`. `install/Sync-HostWorkflow.ps1` generates the catalog, and CI rejects a stale catalog with `-Check`.

`get_workflow` returns a short-lived `receipt`. Pass the matching topic's receipt as `workflowReceipt` when calling `project_memory`, `code_graph`, or a workspace-write Pi task. The gateway checks the current topic digest, expiry, and its in-process record. A missing read returns `WORKFLOW_TOPIC_REQUIRED` with the topic to fetch. A receipt proves retrieval from that gateway, not comprehension, compliance, or independent host-session identity. Fetch again after a gateway restart.

The `gateway-client.mjs` CLI obtains a `coordinator-only` receipt before workspace-write submissions to preserve batch submission. This is not evidence that a model proactively read the topic.

## Eight live primary-agent scenarios

Use a separate primary-agent trace and audit file for each scenario. A correct read before the first gate error counts as a proactive hit; reading only after the error is recovery. Inspect the host tool trace for ungated topics because gateway logs alone cannot establish that a task should have triggered a topic.

| Scenario | Expected topic | Observation |
| --- | --- | --- |
| Simple non-coding answer | No extra topic | No unnecessary policy load |
| Start a code repair | `coordinator-only` | Read before implementation |
| Select a Pi worker model | `pi-routing` | Read before selection |
| Submit a task with predecessors | `pi-contracts` | Read before submission |
| Search `.yhwh/memory/` | `project-memory` | Read before first `project_memory` call |
| Query code impact | `code-graph` | Read before first `code_graph` call |
| Run a direct LSP probe | `pi-lsp` | Read before interpreting its output |
| Handle Claude authentication failure | `pi-auth` | Read before recovery |

Proactive hit rate is the number of triggered scenarios with the correct pre-use read divided by all triggered scenarios. Report recovery rate, extra topic reads, and gate denials separately. `node payload/pi-dispatch/scripts/workflow-disclosure-report.mjs <audit.jsonl>` summarizes topic reads, admits, denials, and the gate-attempt pass rate. **The gate-attempt pass rate is not model trigger recall.** Without live primary-agent traces, report the latter as unmeasured rather than substituting unit tests.
