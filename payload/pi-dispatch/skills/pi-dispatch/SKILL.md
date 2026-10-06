---
name: pi-dispatch
description: Governed local Pi MCP gateway for Tifereth's default lower-agent execution/probe layer; not Codex desktop task management.
---

# Pi Dispatch

Use `http://127.0.0.1:17331/mcp`. Tifereth owns scope, routing, integration and acceptance. Use bounded Pi tasks; built-in subagents need explicit user request. No recursion.

## Before dispatch

- Check `list_capabilities` and read `pi-routing` for scope, acceptance and adaptive thinking. Listed tuples are allowlists, not live access; only an authorized `probe_model` tests access.
- Workers use `openai-codex / gpt-6-luna`; Geburah reviewer uses `claude-code-cli / claude-sonnet-5` (medium default; high/xhigh by review complexity), `access:none` and `task.reviewPacket`. The host may explicitly select the separate `anthropic` API route. No automatic route substitution; exact role bindings are in `pi-routing`.
- Grant least privilege (`none`, `read`, verified sandboxed `workspace-write`) and allowed absolute `cwd`; writes are proposals. Pi roots only; credentials runtime-side, never prompts/tasks/packages. See `pi-routing` for conditional gateway mechanics.

## Submit and wait

Use AGENTS.md tiers; task-tiers for boundaries. Send tier/five semantic flags; gateway counts, rejects unclassified writes. T0 may dispatch synchronously; otherwise submit asynchronously with stable request/parent IDs, exact route/cwd/access/profile and role/objective/acceptance. No raw prompts, commands, environment or tool lists; schemas: `pi-contracts`.

Only effective T2 writes require a `task-tiers` receipt; T0/T1 dispatch and host verification do not. Memory/graph tools retain their receipts. Never poll repeatedly; wait for event, deadline or user request under `pi-results`. Reconcile uncertain writes using the same ID; stop on `idempotency_key_reused` or `in_doubt`.

## Accept and conditional mechanics

Accept only terminal `completed` with `outcome.ok=true`, correct route, valid format/role, full evidence and cleanup. See `pi-results` for retrieval and validation.

T2 uses v2 links; never forge upstream or disguise dependencies. Upgraded known-scope: primary plan → approved pre-review → Chesed → bound record_host_verification → post-review. T0/T1/T2 use real host outputs/exit codes; Netzach needs unavailable host execution or a concrete independent check. T1 post-review ≤10KB; approval/conditional stops. Elastic quota/activation: pi-review. Follow actual admitted stages before upgrade; details: `task-tiers`, `pi-contracts`, `pi-review`.

Choose the lowest justified whole-goal tier; explain escalation with TIER_REASON=. Authorized host-diagnosed repairs need no renewed permission and never reset reviews. Validate complete material/bytes before launch; no truncation/path-only review. Corrections need current artifact evidence; label reused coverage.

LSP uses direct `lsp_request`, not model delegation; inspect status/backend/raw result. Degraded is reduced evidence; unavailable/failed fail acceptance; see `pi-lsp`.

Optional transports require operator config; digest changes fail closed. No auto-switch, lowered thinking or credential fallback; authorized probes only. Full credential rules: `pi-auth`.
