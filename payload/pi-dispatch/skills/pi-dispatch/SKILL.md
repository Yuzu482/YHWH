---
name: pi-dispatch
description: Governed local Pi MCP gateway for Tifereth's default lower-agent execution/probe layer; not Codex desktop task management.
---

# Pi Dispatch

Use `http://127.0.0.1:17331/mcp`. Tifereth owns scope, routing, integration and acceptance. Use bounded Pi tasks; built-in subagents need explicit user request. No recursion.

## Before dispatch

- Check `list_capabilities` and read `pi-routing` before model selection. Listed tuples are allowlists, not live access; only an authorized `probe_model` tests access.
- Workers use `openai-codex / gpt-6-luna`; Geburah reviewer defaults to `claude-code-cli / claude-sonnet-5 / max`, `access:none` and `task.reviewPacket`. The host may explicitly select the separate `anthropic` API route. No automatic route substitution; exact role bindings are in `pi-routing`.
- Grant least privilege (`none`, `read`, verified sandboxed `workspace-write`) and allowed absolute `cwd`; writes are proposals. Pi roots only; credentials runtime-side, never prompts/tasks/packages. See `pi-routing` for conditional gateway mechanics.

## Submit and wait

Classify each workspace-write under `task-tiers` and send `tier` with a strict `tierDeclaration`; an unclassified standalone write is rejected. T0 may use one synchronous `dispatch_subagent`; otherwise default to `submit_subagent` with stable `requestId`/`parentRunId`. Supply exact provider/model, `cwd`, access, profile, and task role/objective/acceptance. Never send raw prompts, commands, environment or tool lists; linked task schemas: `pi-contracts`.

Workspace-write requires the `task-tiers` receipt; memory/graph tools require their receipts. Status is not evidence: don't poll repeatedly; wait for event, deadline or user request. For timing and recovery see `pi-results`. Reconcile uncertain writes using the same ID; stop on `idempotency_key_reused` or `in_doubt`.

## Accept and conditional mechanics

Accept only terminal `completed` with `outcome.ok=true`, correct route, valid format/role, full evidence and cleanup. See `pi-results` for retrieval and validation.

Use v2 linked handoffs for T2; never forge upstream or disguise dependency as standalone. T1 post-review must approve before acceptance; T2 also needs approved pre-review before writes. See `task-tiers`, `pi-contracts` and `pi-review` for details.

LSP uses direct `lsp_request`, not model delegation; inspect status/backend/raw result. Degraded is reduced evidence; unavailable/failed fail acceptance; see `pi-lsp`.

Optional API transport requires operator config; changed digest fails closed. No auto-switch, lowered thinking, task secrets, subscription-token, environment, CLI or plaintext credential fallback; live probe requires authorization. See `pi-auth`.
