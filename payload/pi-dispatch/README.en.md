# Pi Kether Gateway

[![简体中文](.readme-assets/zh.svg)](README.md) [![English](.readme-assets/en.svg)](README.en.md)

New optional primary CLI runner: `scripts/headless-host.mjs` supports Codex, Claude Code and Antigravity with `doctor/run/fingerprint`. Use `workflow/headless.example.json`; all clients default to disabled. Authentication remains with the official CLI; this is not a Pi provider. See [configuration and limits](../../docs/headless-cli.md#english).

New development feature `code_graph` reads a project's JS/TS/Python relationship index at `.yhwh/code-graph/index.json` through `status/search/neighbors/impact`. The host runs `node scripts/code-graph.mjs '<JSON>'` with `action:refresh` and an absolute Git-root `cwd` for hash-based incremental updates; optional `watch` defaults to a 5-second interval and 300-second duration, installing no background service. Only tracked, ordinary, non-ignored sources are indexed. Calls and base types are syntax mentions; relative imports resolve file edges. Stale indexes are refused by default. Read `get_workflow(topic="code-graph")` for limits, Git review, locking and recovery. MCP exposes no writer; existing LSP isolation is unchanged. Existing services still need an upgrade.

New project knowledge tool `project_memory` reads `.yhwh/memory/<id>.md` in Git projects via `list/search/read/review/snapshot`. Default search includes only accepted knowledge with matching source fingerprints. `review` separates staged, unstaged and untracked changes. The tool is read-only and model-free; it never edits or commits files. The primary edits entries using existing permissions. Git must be installed on the runtime machine and `cwd` must be an allowed Git worktree root. Read `get_workflow(topic="project-memory")` for the format, boundaries and review process. Existing services need an upgrade; this is separate from host conversation memory and resident LSP caches.

The primary can run in any host with MCP tool calling and persistent instruction loading. `get_workflow` serves the primary contract, role skills and governance references by topic. `scripts/host-profiles.mjs` exports profiles for Cherry Studio, OpenCode v1/v2, Claude Code/Desktop, DeepSeek Harness, Codex and generic clients. `scripts/common-client-profiles.mjs` additionally exports Cursor, VS Code/Copilot, Windsurf Cascade, Cline, Roo Code, Gemini CLI, Kiro, Zed, Continue and LM Studio profiles, for 18 host IDs in total; new adapter metadata includes official sources and scope. Connection/configuration checks do not establish a complete model-backed governance run in every host. Default stdio owns one runtime per connection; concurrent hosts need `PI_GATEWAY_CONFIG` to share one HTTP gateway. The backend still requires Windows + WSL2.

Pi is the lower-agent execution, model-probe and LSP layer controlled by Tifereth. The default installation uses stdio; an optional shared runtime uses the local Streamable HTTP MCP endpoint `http://127.0.0.1:17331/mcp`. Model tasks first pass through a Kether execution envelope, then route through an exact allowlist to:

- `openai-codex` (workers: `gpt-5.6-luna` / `max`).
- `anthropic` (Geburah/reviewer: `claude-sonnet-5` / `max`, restricted to `access:none`).

The gateway provides synchronous execution, asynchronous monitoring, model probes and LSP tools. Monitoring uses `submit_subagent`, `get_subagent_status`, `get_subagent_result`, `list_subagents`, `cancel_subagent` and `render_subagent_monitor`. The last tool returns an MCP Apps conversation card that refreshes the task tree by `parentRunId`. Callers cannot supply raw Pi arguments, environment variables or arbitrary tool lists. Pi starts with automatic extension discovery disabled and loads only controlled provider and LSP extensions for the task. Actual provider, model and `toolsUsed` are returned for Tifereth's acceptance checks.

`result-format-validator` deterministically validates ordinary model subagent output without another model call. A lower agent must return only `KETHER_RESULT_JSON=<JSON object>`. JSON keys must match the v2 role result schema; requests normally omit `returnFields` so the gateway selects the complete role schema. `status` is restricted to `completed / failed / blocked / unverified`. Extra prose, Markdown fences, missing or additional fields, invalid JSON, output over 512 KiB, or structures exceeding 12 levels or 4096 nodes produce `result_format_invalid`. Validated objects appear in `structuredResult`, with a summary in `formatValidation`. A format failure is a Netzach result-quality failure and does not open the provider circuit. Model heartbeats continue to use exact plain-text tokens rather than this format.

For each admitted call, the audit extension appends a JSONL record containing `requestId`, task-envelope SHA-256 and structural counts, requested and actual provider/model, tool-call counts, duration, token usage, patch hash/size/file/line summaries, and redacted failure reasons. Audit records exclude raw tasks, model replies, diagnostic text and patch bodies. Bearer credentials, API keys, tokens, passwords, private keys, JWTs and URL credentials are removed before writing. When permitted to omit `requestId`, the caller receives a gateway-generated ID in the response.

Tifereth must supply a stable, unique `requestId` for `workspace-write` calls. The persistent request ledger atomically reserves that ID before queue admission and stores a SHA-256 digest without the raw request. A completed request with the same ID and content replays its cached result without another model call; the same ID with different content is rejected. If a process interruption leaves only a start record, the gateway returns `idempotency_in_doubt` and blocks automatic reruns until Tifereth reconciles the original task. To recover responses after Tunnel timeouts, the ledger caches tool results in a restricted local state directory and redacts Bearer credentials, API keys, passwords, JWTs, private keys and URL credentials before persistence. Its purpose differs from the audit log, which does not retain raw task or patch text.

`provider-circuit-state` appends infrastructure outcomes from probes and actual calls to a separate JSONL state cache and exposes each provider/model route as `closed / open / half-open`. It does not create agents, schedule probes, select fallback models, rewrite envelopes, automatically retry or run background heartbeats. Authentication failures immediately enter `open` without timed expiry; after login repair, Tifereth must explicitly submit a recovery probe with `recovery: true`. HTTP 429 follows the provider's retry-after interval. Three consecutive network, timeout, route-mismatch or provider failures trigger a five-minute cooldown. After cooldown, `half-open` permits a single two-minute recovery-probe lease. Model refusals, poor answers, invalid arguments, scope violations and tool/LSP failures do not count as provider infrastructure failures.

Optional `yhwh-worker-api` / `yhwh-reviewer-api` routes support OpenCode Go, CommandCode, OpenRouter and custom HTTPS platforms. Fixed host configuration, separate credential storage, launch digest checks, max and role/access restrictions remain enforced. Defaults are unchanged with no automatic fallback. See [platform configuration](../../docs/provider-configuration.en.md). Live platform calls are unverified.

Since 0.8 API keys are encrypted with Windows DPAPI CurrentUser. Windows decrypts into private pipes / FD3 without plaintext API temporary files. After upgrading code, migrate legacy plaintext using `Migrate-API-Keys.cmd` or `install/Migrate-ApiCredentials.ps1`; plaintext fallback is rejected.

## Runtime boundaries

- Listens on loopback only. `/mcp` requires a Bearer token; the default request limit is 100 KiB.
- Concurrency remains capped at four, with admission constrained by a shared 6 GiB / 2 CPU pool: at most four `small`, two `standard` or one `large` task. Admission also preserves a host-memory reserve of at least `max(2 GiB, 10% of host RAM)`. The default queue holds 16 tasks. Queue and execution deadlines are separate; cancellation terminates the Pi process tree.
- Active provider pools are `openai-codex=2` and `anthropic=1`. Other provider capacity entries retained by the scheduler do not authorize those routes. Scheduling uses `priority` (0..9), waiting-time aging and FIFO, skipping entries blocked by dependencies, resource limits or write locks to run other eligible tasks.
- Each task selects a hardcoded `small`, `standard` or `large` resource profile; the default is `standard`. Callers may only shorten its deadline through `timeoutSeconds`, not specify arbitrary memory, CPU, process or output limits.
- `cwd` must resolve within a configured real-path root; LSP files must also be within the selected `cwd`.
- Gateway credentials are not passed to Pi child processes. Recursive Pi dispatch is rejected.
- `dispatch.mjs run/task` requires the same WSL2 resource sandbox and cannot fall back to unrestricted host execution.
- `PI_DISPATCH_SANDBOX=wsl2-bwrap` enables Ubuntu 24.04 WSL2 + Bubblewrap. Windows-drive automount and interoperability are disabled. Each task copies its workspace into a Linux temporary directory and unmounts host drives before Pi starts.
- `none` copies no workspace; `read` uses a read-only snapshot; `workspace-write` modifies only the sandbox copy and returns a unified patch of at most 4 MiB for Tifereth's review, without directly writing back to the host workspace.
- `workspace-write` always loads the scope-enforcement extension. Ordinary entries authorize exact files; directory trees require explicit `path/**` entries. Absolute paths, traversal, prefix confusion, repository metadata, symlink or hardlink escapes, shell writes, out-of-scope tool calls and invalid or out-of-scope patches fail closed.
- Write tasks with different `requestId` values also acquire scope locks shared across HTTP/stdio processes. Overlapping files, parent directory trees and child paths permit only one task at a time; disjoint scopes may run concurrently. Locks are released after execution and can be reclaimed after process exit or the maximum runtime.
- Write tools are limited to `write`, `edit` and scoped `code_rewrite`. Patches are checked again against the original `writeScope` before returning to Tifereth; binary or unreliably parsed patches are rejected.
- Long-lived refresh credentials remain on the host. The sandbox receives only a temporary access token for one route. Temporary credentials and task resources are cleaned up according to the execution path; acceptance must check `cleanup.ok`, and cleanup failure must not be treated as success.
- The sandbox retains network access for model APIs but cannot see Windows host drives or launch Windows programs. Capability probes create a real cgroup and verify process membership. If kernel resource isolation is unavailable, every Pi subagent, LSP and probe task fails closed before model startup.

Profiles are defined in [`extensions/resource-limits.js`](./extensions/resource-limits.js) and checked against matching constants in the WSL launcher:

| Profile | Memory | CPU | Processes | Combined output | Maximum runtime |
| --- | ---: | ---: | ---: | ---: | ---: |
| `small` | 1 GiB | 0.5 core | 64 | 1 MiB | 120 seconds |
| `standard` | 3 GiB | 1 core | 128 | 4 MiB | 300 seconds |
| `large` | 6 GiB | 2 cores | 256 | 8 MiB | 900 seconds |

WSL cgroup v2 enforces memory, CPU and process limits, with swap disabled for tasks. The Windows gateway caps combined stdout/stderr bytes and terminates the process tree on overflow. Gateway deadlines, Windows child-process timers and Linux `timeout` jointly enforce runtime limits.

## Tifereth invocation contract

Tifereth is the sole task-decomposition and dispatch decision layer. Each `dispatch_subagent` call submits a complete Kether `task`, optionally with `requestId`, `parentRunId`, `priority` and `dependsOnRequestIds`. Dependencies refer to predecessor request IDs and must complete successfully before successors execute. Pi does not construct the dependency graph, recursively create agents or rewrite provider/model selections. It enforces the submitted graph, priorities and resource constraints.

Standalone read-only example, which does not attest a complete stage chain. For linked tasks and real predecessor handoffs, see [ROLE-CONTRACTS-V2.md](ROLE-CONTRACTS-V2.md):

```json
{
  "requestId": "req-42",
  "parentRunId": "tifereth-run-7",
  "priority": 5,
  "cwd": "D:\\Projects\\Example",
  "provider": "openai-codex",
  "model": "gpt-5.6-luna",
  "thinking": "max",
  "access": "read",
  "resourceProfile": "standard",
  "timeoutSeconds": 180,
  "task": {
    "role": "Malkuth",
    "objective": "Inspect the model gateway implementation.",
    "readScope": ["payload/pi-dispatch"],
    "forbidden": ["Do not modify files", "Do not dispatch further agents"],
    "acceptance": ["Return file evidence, actual provider/model and uncertainties"]
  }
}
```

## Startup and inspection

`PI_GATEWAY_CONFIG` points to a JSON configuration. Its `tokenFile` points to a file containing only the Bearer token, `auditFile` to the append-only audit log, `providerCircuitFile` to the provider-circuit cache, and `requestLedgerDir` to the persistent write-request ledger. Then run `npm run gateway`. Health is checked through `GET /healthz`, readiness through `GET /readyz`, and detailed capabilities through `list_capabilities`. The stdio tunnel entry point uses `PI_GATEWAY_AUDIT_FILE`, `PI_GATEWAY_PROVIDER_CIRCUIT_FILE` and `PI_GATEWAY_REQUEST_LEDGER_DIR` for the same persistent state. See `gateway.example.json`.

The local debugging client supports `gateway-client.mjs dispatch <request.json>` to exercise envelope, resource-profile and result-format validation through the MCP gateway.

The plugin also registers a stdio MCP entry point under the same policy, so new local Codex tasks can discover the current gateway tools. It authorizes only the current workspace. ChatGPT Work cannot directly access localhost; use OpenAI Secure MCP Tunnel to expose the HTTP endpoint securely to the workspace.

## Verification

`npm test` covers envelopes, exact routing, result formats, credential scrubbing, process lifecycle, authentication preconditions, ordinary and chunked request limits, tool surfaces, path boundaries, sandbox capability gates, fail-closed behavior, concurrency caps, queue cancellation and timeouts. Live provider heartbeats, sandbox write patches and LSP checks consume the corresponding account's resources and should be run separately after configuration.

See [REVIEW-AND-TIMEOUTS.md](REVIEW-AND-TIMEOUTS.md) for independent queue deadlines, wait reasons and mandatory review-material packets. Legacy reviewer requests must migrate to `task.reviewPacket`; structural validity does not establish that the evidence is true.

## Direct deterministic LSP

`lsp_request` executes without a model and requires neither model-service login nor provider/model fields. It retains read-only single-file snapshots, WSL isolation, resource limits, auditing and cleanup. Positions use 1-based line/character values; `query` is a symbol name, and `search` takes a structural pattern plus `language`. Responses include the raw tool result and backend. See [Pi LSP](skills/pi-lsp/SKILL.md).

The current model-task protocol is v2, with role-specific deliverables, strict field types, failure-state rejection and ledger-backed stage handoffs. See [ROLE-CONTRACTS-V2.md](ROLE-CONTRACTS-V2.md). Reduced legacy `returnFields` are rejected; standalone tasks do not attest completion of the full governance chain.

## License

Original YHWH code, documentation and configuration are licensed under [Apache-2.0](LICENSE); see [NOTICE](NOTICE). Third-party components retain their own licenses. [Third-party notices](THIRD_PARTY_NOTICES.txt).

Since 0.6.0 the reviewer uses the native Anthropic API with a user-owned API key. Subscription credential reading/renewal and the Claude Code bridge are removed. Service terms still apply; live API access has not been verified.

## Go / Rust probes

`yhwh-pi-lsp` 1.6.0 adds Go/gopls and Rust/rust-analyzer, with task-local reuse and edit invalidation across all seven tools. Go uses completed pull diagnostics; Rust uses a fixed edition-2024 single-file library and bounded rustc metadata checks to avoid treating initial empty diagnostics as a clean result. Probes remain read-only, offline and credential-free; Cargo build scripts, procedural macros and user programs are not executed. The full installer's `install/provision-go-rust.sh` provisions pinned dependencies; copying the plugin alone does not include toolchains. See [configuration and limits](../../docs/pi-lsp-adapter.en.md) and [dependency materials](../../licenses/go-rust-runtime.json).
