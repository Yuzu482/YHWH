---
name: pi-lsp
description: Execute deterministic read-only LSP and structural operations directly through the governed Pi gateway, without a model.
---

# Pi LSP

Call `lsp_request` directly. Supply absolute allowed `cwd`, one existing `file` inside it, `method`, and optional `resourceProfile`, `queueTimeoutSeconds`, `timeoutSeconds`, `requestId`. No model, provider, thinking or Kether model envelope is needed. Do not delegate deterministic operations to a lower agent.

Methods: diagnostics, hover, definition, references, symbols, completions, code_actions, overview, search. Positioned methods need positive 1-based `line` and `character`, or an exact symbol `query`. Search requires a structural pattern in `query` plus `language`. Queries are not natural-language instructions. code_actions returns suggestions only; no edits are applied.

Require `ok=true`, exact requestedTool/toolsUsed and empty unexpectedTools. Read raw `result`; diagnostics may contain errors even when the call succeeded. Check `backend`: tree-sitter is reduced syntax/structure evidence, not full LSP type checking. Diagnostics from LSP must have diagnosticsPublished=true; missing publication cannot prove a clean file.

The tool uses an isolated read-only single-file snapshot, no provider credentials, no external network, fixed resource profiles, independent queue/execution budgets and awaited cgroup cleanup. Cross-file results are limited by that snapshot. Language servers start per request. Python, Java, JS/TS, C/C++, C# configured servers remain available subject to installed runtime and budgets. New tool fields may require refreshing the ChatGPT connector and starting a new conversation.

Result status: success / no-match / degraded / unavailable / failed. unavailable and failed have ok=false. degraded is usable only as explicitly reduced evidence. No-match does not establish an unavailable service.
