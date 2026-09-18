# Provider authentication renewal

## Host OpenAI credential persistence

OpenAI model tasks now call the host `ensureOpenAIAuth` before WSL execution.
The minimum remaining lifetime is the execution budget plus six minutes, covering
Pi's five-minute early-refresh window and sandbox startup. A valid credential is
reused without a network request. Renewal uses the installed Pi SDK OAuth module
(verified with host Pi 0.85.1), not Codex CLI or a custom OAuth endpoint.

The host helper runs hidden, without a shell or inherited credential environment.
An exclusive maintenance lock serializes gateway helpers; the SDK-compatible
`proper-lockfile` lock also coordinates with native Pi's `auth.json` writer.
Credentials are re-read under the lock. Refresh intent is journaled before the
request; successful rotation is fsynced and atomically renamed into the host file,
preserving other provider entries and the source file's Windows DACL (POSIX mode
on Linux). The file is re-read before reporting success. A late cancellation does
not discard an already returned rotation; the helper has up to 15 seconds to exit.

Only access token and expiry cross the sandbox credential descriptor. The Pi
credential store remains OAuth-backed for the `openai-codex` subscription route,
but its refresh field is empty and modification is rejected. No refresh token is
exposed to workers and no task-memory refresh can occur.

`openai-auth-renew.json` stores status, timestamps and a credential fingerprint,
never token text. Authentication rejection requires a new host login. An explicit
429 cools down for five minutes. Timeout, network ambiguity, 5xx and incomplete
persistence fail closed; the original refresh credential is never automatically
replayed. Pending state with unchanged credentials requires login repair. A crash
may leave `openai-auth-renew.lock`: verify its owner process has exited before
manual removal. Locks are not stolen based only on age; do not remove the journal
to bypass an uncertain refresh. A new login changes the credential fingerprint.
External writers must honor Pi's auth-file lock; do not share one refresh-token
copy across machines or restore an old credential backup after rotation.

The host API exposes `refreshNow: true` only for a deliberate maintenance check;
MCP tasks cannot select it. Default operation is expiry-driven with no background
heartbeats or automatic provider fallback. Missing SDK support is reported as a
setup error. Credentials and local journals never belong in portable packages.

Verification for this change: synthetic multi-process refresh/restart tests,
failure/late-cancel/crash tests, one real refresh with both tokens rotated and
persisted, a fresh helper reusing the new token, unchanged other provider entries,
and unchanged Windows auth-file DACL. This does not guarantee permanent entitlement
or survival of every power-loss/storage failure; rejected sessions still need login.


## Host Claude login renewal

Before Claude model dispatch, the host checks expiry and renews within five minutes of expiry via the official native Claude Code `auth login --claudeai`, using existing refresh token and scopes. The CLI alone persists credentials. Renewal launches no model, runs hidden with no shell, has a 30-second timeout and a cross-process exclusive lock. Temporary failures cool down for five minutes; rejected refresh credentials require login repair. A process crash may leave a lock: fail closed with PI_AUTH_RENEW_BUSY; verify no auth process remains before manual removal rather than stealing a lock.

For authentication-open circuits, call `renew_claude_auth` once. Success does not clear the circuit: Tifereth then calls `probe_model` with `recovery:true` for the pinned Sonnet route. Resume reviewer work only after that probe passes. Do not automatically generate model probes or provider fallbacks. No refresh credentials enter WSL tasks, logs, task packets or portable packages. Non-default host CLI path can be set by the host administrator with PI_CLAUDE_AUTH_CLI; MCP requests cannot override executable paths.

Official reference: https://code.claude.com/docs/en/env-vars#claude-code-oauth-refresh-token

This extends the credential lifecycle; it does not make login permanent. Revocation, missing refresh scopes or an invalid refresh token still require a host login. No authenticated reviewer success is inferred from a successful renewal alone.
