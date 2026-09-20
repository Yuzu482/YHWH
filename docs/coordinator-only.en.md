# Primary reasoning and orchestration only

[简体中文](coordinator-only.md) | [English](coordinator-only.en.md)

YHWH uses the primary agent for requirements, architecture, decomposition, scheduling and final acceptance. This Codex host currently uses Astra; Pi subagents, normally Luna/max, author source code, tests and implementation scripts. Other hosts may still select their own primary model.

The primary may inspect sources, run deterministic probes and existing checks, write plans and governance documents, and mechanically apply worker patches after checking scope and baseline. Small fixes, test repairs and inline scripts are not exceptions allowing primary coding. Return implementation corrections to workers. Give tightly coupled changes to one worker instead of forcing parallel edits.

WSL model workers use basic file tools and seven `yhwh_lsp_*` tools, adding `edit` and `write` for write tasks. They no longer automatically load `pi-lsp-extension`, avoiding its language-server lifecycle hooks on ordinary file reads/writes. Legacy `lsp_*`, `ast_search`, `code_overview` and `code_rewrite` are absent from this model tool list; deterministic direct LSP/structural paths and host compatibility remain. For small tasks, Luna can also propose a patch from authorized supplied material without filesystem access; the primary verifies and mechanically applies it. This does not establish worker host writes or test execution.

When a worker is unavailable, times out or returns incomplete delivery, the primary continues diagnosis and planning while coding remains blocked. Only a subsequent explicit user instruction allows primary coding. Reconcile executed or uncertain writes using the original requestId before retrying; a new ID must not bypass the ledger. A confirmed queued cancellation with zero execution may be replanned for available resources.

Astra is explicitly prohibited from repeated polling, including sleep/query loops, repeated 50/60-second batches and script-wrapped polling. Earlier timed fallback permission is revoked. The monitor UI and local Pi supervisor heartbeat refresh independently. The primary does independent work or uses an actually available completion-wait tool. When no dedicated completion wait exists, wait for a genuine completion/failure signal, predeclared deadline or explicit user status request before one necessary read; never claim an event subscription exists without support. A pending result does not authorize restarting a loop. Full-result pagination and finite acceptance checks remain allowed; zero waiting tokens are not guaranteed. See the [waiting policy](../templates/agent-references/pi-results.md).

Record each implementation requestId, role/model, outcome, patch scope, verification and review independence. Count heartbeats, deterministic tools and status reads separately. A successful monitor card cannot replace full result, format, cleanup and patch acceptance. Primary local pre/post review is neither independent reviewer approval nor a runtime-attested stage chain.

The primary follows this as an instruction policy. Pi sandbox and contract checks govern Pi calls; they cannot disable every host client's own editing tools. Portable templates, skills and workflow catalog carry the policy; existing hosts need corresponding policy synchronization. Repository changes do not mean the running Pi service has been upgraded and do not authorize publishing or pushing.

See the complete [coordinator-only policy](../templates/agent-references/coordinator-only.md).
