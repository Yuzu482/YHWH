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


## Host Claude API credentials

The canonical reviewer route, credential handling and recovery policy is the `pi-auth` topic (`get_workflow({"topic":"pi-auth"})`), generated from `templates/agent-references/pi-auth.md`.


## API key encryption (0.8)

YHWH-managed API keys use Windows DPAPI CurrentUser; plaintext fallback is forbidden. The canonical encryption, migration and limitation policy is the `pi-auth` topic (`get_workflow({"topic":"pi-auth"})`), generated from `templates/agent-references/pi-auth.md`.
