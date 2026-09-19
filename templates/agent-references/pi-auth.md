## Host Claude API credentials

The released reviewer uses the native Pi `anthropic / claude-sonnet-5 / max` route with user-owned API billing. Configure the key through `Configure-Claude-API.cmd`, or run `install/Set-ClaudeApiKey.ps1 -TargetHome <Windows user home>`. Only `.local/state/pi-kether/anthropic-api-key.json` is used. Never read, renew or forward Claude subscription credentials; environment keys, custom endpoints and CLI-token fallbacks are not accepted.

`check_claude_auth` validates local configuration only and makes no network/model call. It does not establish key validity, quota or model availability and does not clear an open circuit. After the user repairs configuration, Tifereth must explicitly authorize `probe_model` with `recovery:true` for the pinned route. Only a successful probe permits resuming ordinary work. Keys enter trusted Pi memory through FD3, never prompts, logs, CLI arguments, environment variables or portable packages. The reviewer retains `access:none` and no tools.


## Optional controlled API transports (0.7)

The default bindings above remain unchanged. A host operator may explicitly configure fixed `~/.local/state/pi-kether/provider-config.json` and select `yhwh-worker-api` for worker roles or `yhwh-reviewer-api` for Geburah. These are transport alternatives only: semantic models remain gpt-5.6-luna / claude-sonnet-5 with max, reviewer access remains none, editor authorization is unavailable for these routes. Query list_capabilities first; unconfigured routes and changed configuration digests fail closed. Never auto-switch, lower thinking, supply endpoints/secrets through task input, or treat capability declarations as live verification. Keys come only from the separate host provider-credentials.json store via FD3. Direct provider auth tools do not validate aggregator keys. Platform account, model, endpoint and max support require an authorized live probe. Follow stricter host policy if it does not admit these optional transports.


## API key encryption (0.8)

YHWH-managed Anthropic and aggregator API key files require api_key_dpapi envelopes using Windows DPAPI CurrentUser. Decrypt only in the fixed Windows helper, capture into private pipes, validate the route/config digest in WSL, and pass through kernel pipe FD3. API routes must never use plaintext credential files, argv, environment, prompt or log fallback. Legacy plaintext raises PI_AUTH_MIGRATION_REQUIRED; the operator upgrades the gateway and WSL files, then explicitly runs Migrate-API-Keys.cmd or install/Migrate-ApiCredentials.ps1. No plaintext backup is created. Migration does not erase old backups or freed disk blocks. Existing Pi OpenAI OAuth storage is outside this API-key change. Runtime memory and same-user/OS compromise remain outside the encryption guarantee.
