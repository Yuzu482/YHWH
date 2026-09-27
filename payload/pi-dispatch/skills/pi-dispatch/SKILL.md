---
name: pi-dispatch
description: Governed local Pi MCP gateway for Tifereth's default lower-agent execution/probe layer; not Codex desktop task management.
---

# Pi Dispatch

Use `http://127.0.0.1:17331/mcp` via MCP. Tifereth owns decomposition, bindings, scope, integration and acceptance. Pi is default for model-backed lower work; built-in subagents need explicit user request. One bounded envelope per dispatch; no recursion.

## Before dispatch

- If state is unknown, call `list_capabilities`; inspect role/provider schemas and fetch `get_workflow` `pi-routing` before model selection. Listed tuples are allowlists, not live evidence; only `probe_model` is live. Never expose credentials.
- Bind workers/researchers and Yesod/Binah/Malkuth/Hod/Chochmah/Chesed/Netzach to `openai-codex / gpt-6-luna`; Geburah reviewer to `anthropic / claude-sonnet-5 / max`, `access:none`, no file/shell/tools, actual materials in `task.reviewPacket`. Worker=Chesed, researcher=Malkuth; Kether/Tifereth host-side, Da'at unavailable without capable route. No role/provider substitution.
- Grant least privilege (`none`, `read`, verified sandboxed `workspace-write`) and allowed absolute `cwd`; writes are proposals. Pi roots only; credentials runtime-side, never prompts/tasks/packages. See `pi-routing` for conditional gateway mechanics.

## Submit and wait

Default to `submit_subagent` with stable `requestId`/`parentRunId`. Supply exact provider/model, `cwd`, access, profile, and task role/objective/acceptance. Never send raw prompts, commands, environment or tool lists; task schemas: `pi-contracts`.

Workspace-write requires the coordinator-only receipt; memory/graph tools require their receipts. Status is not evidence: don't poll repeatedly; wait for event, deadline or user request. For timing and recovery see `pi-results`. Reconcile uncertain writes using the same ID; stop on `idempotency_key_reused` or `in_doubt`.

## Accept and conditional mechanics

Accept only terminal `completed` with `outcome.ok=true`, actual provider/model, valid format/role, full result/evidence and applicable cleanup. Status cards aren't evidence; failures or unverified work aren't accepted. See `pi-results` for retrieval and validation.

Use v2 typed linked handoffs; never forge upstream or disguise dependency as standalone. Require reviewer decision/materials and verifier evidence. See `pi-contracts` for schemas/gates and `pi-review` for review rules.

LSP uses direct `lsp_request`, not model delegation; inspect status/backend/raw result. Degraded is reduced evidence; unavailable/failed fail acceptance; see `pi-lsp`.

Optional API transport requires operator config; changed digest fails closed. No auto-switch, lowered thinking, task secrets, subscription-token, environment, CLI or plaintext credential fallback; live probe requires authorization. See `pi-auth`.
