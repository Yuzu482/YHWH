## Claude Code CLI reviewer and optional API credentials

The reviewer route is `claude-code-cli / claude-sonnet-5`, with complexity-selected medium/high/xhigh thinking (medium default) for T1/T2 reviews. The gateway invokes the official Claude Code CLI in no-tools mode on the Windows host, outside WSL. The CLI owns its subscription login; the gateway does not read, forward, renew or store its credentials. Login and recovery are manual. Before use, clear `ANTHROPIC_API_KEY` in PowerShell and confirm `claude -p "reply OK" --output-format json --model sonnet` works; if login has expired, run `claude` and `/login` yourself. The gateway strips Anthropic credential environment variables and `CLAUDE_CODE_*` overrides from the child process.

The separate native Pi `anthropic / claude-sonnet-5` API route remains available by explicit selection or host-owned reviewer-transport preference. It uses user-owned API billing. Configure its key through `Configure-Claude-API.cmd`, or run `install/Set-ClaudeApiKey.ps1 -TargetHome <Windows user home>`. Only `.local/state/pi-kether/anthropic-api-key.json` is used for this API route. API keys are never borrowed from the CLI, and the CLI route never falls back to this route.

`check_claude_auth` validates only the API-key route's local configuration. It makes no network/model call, does not validate CLI login, quota or model availability, and does not clear an open circuit. After repairing either route, Tifereth explicitly runs `probe_model` with `recovery:true` for that exact tuple. Only a successful probe permits resuming ordinary work. API keys enter trusted Pi memory through FD3, never prompts, logs, CLI arguments, environment variables or portable packages. Both reviewer routes retain `access:none` and no tools.


## Optional controlled API transports (0.7)

Before selecting an optional controlled route, read pi-routing and query live capabilities. The legacy 0.7 routes remain max-only and cannot satisfy current medium/high/xhigh reviewer policy; do not substitute them or silently raise effort. Host configuration and credential handling remain unchanged: fixed provider-config.json and separate provider-credentials.json via FD3, no task endpoints/secrets or automatic fallback. Changed configuration digests fail closed; direct auth checks do not validate aggregator keys, and live account/model/endpoint support requires an authorized probe. Reviewer access remains none and editor authorization is unavailable.


## API key encryption (0.8)

YHWH-managed Anthropic and aggregator API key files require api_key_dpapi envelopes using Windows DPAPI CurrentUser. Decrypt only in the fixed Windows helper, capture into private pipes, validate the route/config digest in WSL, and pass through kernel pipe FD3. API routes must never use plaintext credential files, argv, environment, prompt or log fallback. Legacy plaintext raises PI_AUTH_MIGRATION_REQUIRED; the operator upgrades the gateway and WSL files, then explicitly runs Migrate-API-Keys.cmd or install/Migrate-ApiCredentials.ps1. No plaintext backup is created. Migration does not erase old backups or freed disk blocks. Existing Pi OpenAI OAuth storage is outside this API-key change. Runtime memory and same-user/OS compromise remain outside the encryption guarantee.
