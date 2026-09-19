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

The released reviewer uses the native Pi `anthropic / claude-sonnet-5 / max` route with user-owned API billing. Configure the key through `Configure-Claude-API.cmd`, or run `install/Set-ClaudeApiKey.ps1 -TargetHome <Windows user home>`. Only `.local/state/pi-kether/anthropic-api-key.json` is used. Never read, renew or forward Claude subscription credentials; environment keys, custom endpoints and CLI-token fallbacks are not accepted.

`check_claude_auth` validates local configuration only and makes no network/model call. It does not establish key validity, quota or model availability and does not clear an open circuit. After the user repairs configuration, Tifereth must explicitly authorize `probe_model` with `recovery:true` for the pinned route. Only a successful probe permits resuming ordinary work. Keys enter trusted Pi memory through FD3, never prompts, logs, CLI arguments, environment variables or portable packages. The reviewer retains `access:none` and no tools.


## API key encryption (0.8)

YHWH-managed Anthropic and aggregator API key files require api_key_dpapi envelopes using Windows DPAPI CurrentUser. Decrypt only in the fixed Windows helper, capture into private pipes, validate the route/config digest in WSL, and pass through kernel pipe FD3. API routes must never use plaintext credential files, argv, environment, prompt or log fallback. Legacy plaintext raises PI_AUTH_MIGRATION_REQUIRED; the operator upgrades the gateway and WSL files, then explicitly runs Migrate-API-Keys.cmd or install/Migrate-ApiCredentials.ps1. No plaintext backup is created. Migration does not erase old backups or freed disk blocks. Existing Pi OpenAI OAuth storage is outside this API-key change. Runtime memory and same-user/OS compromise remain outside the encryption guarantee.
