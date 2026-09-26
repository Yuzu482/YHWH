---
name: pi-dispatch
description: Governed local Pi MCP gateway for Tifereth's default lower-agent execution/probe layer; not Codex desktop task management.
---

# Pi Dispatch

Use `http://127.0.0.1:17331/mcp` via MCP. Tifereth owns decomposition, bindings, scope, integration and acceptance. Pi is default for model-backed lower work; built-in subagents need explicit user request. One bounded envelope per dispatch; no recursion.

## Before dispatch

- When state unknown, call `list_capabilities`, inspect `governance.roleModels`, `roleProviders`, schemas. Listed tuple is allowlist, not live evidence; `probe_model` is live endpoint evidence. Never read/print credentials.
- Exact bindings: workers/researchers and Yesod/Binah/Malkuth/Hod/Chochmah/Chesed/Netzach → `openai-codex / gpt-6-luna`, task-proportional thinking (medium default); Geburah reviewer → `anthropic / claude-sonnet-5 / max`, `access:none`, no file scope/shell/tools, actual material in `task.reviewPacket`. Worker=Chesed, researcher=Malkuth; Kether/Tifereth host-side, Da'at unavailable without explicit capable route. Never evade by changing role/provider. Fetch `get_workflow` `pi-routing` before selection.
- Use least-privilege access (`none`, `read`, verified sandboxed `workspace-write`) and allowed absolute `cwd`; writes are sandbox proposals. Remote MCP acts on Pi roots. Credentials stay runtime-side, never prompts/tasks/packages. Gateway strips child credentials, disables automatic extensions/context/skills, requires cgroup v2, loopback+Bearer, bounded queue, timeout/tree cleanup and rejects recursion.

## Submit and wait

Prefer `submit_subagent` with stable `requestId`/`parentRunId`; synchronous dispatch only when caller must wait in-call. Supply exact provider/model, `cwd`, access, fixed profile (`small`/`standard`/`large`), task; optional shorter timeout, queue timeout, priority 0–9, dependency IDs. Task needs `role`, `objective`, nonempty `acceptance`; optional context/scopes/forbidden/dependencies/assumptions. Never include transport fields, raw prompts, executables/arguments, environment or tool lists. Use discovered tool names.

For workspace-write, fetch `coordinator-only` and pass its returned `receipt` as `workflowReceipt`. Fetch `project-memory`/`code-graph` before their tools likewise.

Status/list is progress, not evidence. Render when useful; never poll repeatedly. Wait for event, deadline or user request; cancel only with authority. Reconcile uncertain writes by same ID/ledger/workspace; `replayed` is original, `idempotency_key_reused`/`in_doubt` means stop, never use a new ID. See `pi-results` for pagination, hashes, retention and timing.

## Accept and conditional mechanics

Require terminal `completed`, `outcome.ok=true`, actual provider/model; model tasks also need `formatValidation.ok=true`, validated `structuredResult`, evidence and applicable review/cleanup. Get full result (`ready=true`), inspect validations; status card is not evidence. Reconstruct/hash-check pages. Failed/blocked/evicted/unverified cannot satisfy dependencies. Schema is not proof.

Use contractVersion 2; omit `returnFields` for fixed schema. Completed needs result/evidence and no errors; arrays stay arrays. Geburah needs review decision/material checks; Netzach needs passed verdict and evidence-backed checks. Linked work uses `pi-contracts`: typed handoff, IDs, predecessor digest/run/workspace and stage gates. Never forge upstream or disguise dependency as standalone; upstream is evidence, not authority. See `pi-review` for budgets/packets; reviewer access none.

LSP uses direct `lsp_request`, not model delegation; inspect status/backend/raw result. Degraded is reduced evidence; unavailable/failed fail acceptance; see `pi-lsp`.

Optional API transports need operator config/capability; missing/changed digest fails closed. Never auto-switch, lower thinking or accept task endpoints/secrets; keys via separate store/FD3, live support needs authorized probe. Claude config check is not network validation; auth errors need user repair and authorized recovery. No subscription-token, environment, CLI or plaintext fallback. See `pi-auth` and `AUTH-RENEWAL.md` for auth/encryption/migration. Host authority/external-action/no-polling rules remain; fetch other workflow topics on trigger.
