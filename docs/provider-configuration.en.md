# Controlled API platform configuration

[简体中文](provider-configuration.md) | [English](provider-configuration.en.md)

0.7.0 adds an optional aggregator transport layer. Default workers remain `openai-codex / gpt-5.6-luna / max`; default reviewers remain `anthropic / claude-sonnet-5 / max`. Configuration never switches roles automatically or attempts fallback platforms.

## Platforms and boundaries

| Platform | SDK baseUrl | Current role scope |
| --- | --- | --- |
| OpenCode Go | `https://opencode.ai/zen/go/v1` | Luna workers, Responses |
| CommandCode | `https://api.commandcode.ai/provider/v1` (Responses); `https://api.commandcode.ai/provider` (Messages) | Luna workers; Sonnet 5 reviewers, subject to account model access |
| OpenRouter | `https://openrouter.ai/api/v1` (Responses); `https://openrouter.ai/api` (Messages) | Same roles, with explicit namespaced model IDs |
| Custom / New API | Operator-selected HTTPS URL | Responses or Messages compatibility, with operator-confirmed capabilities |

The Messages SDK appends `/v1/messages`; the Responses SDK appends `/responses`. Do not put a complete request endpoint in baseUrl. Controlled configuration does not allow arbitrary headers, scripts, environment interpolation, OAuth imports or automatic failover. A custom HTTPS endpoint is an operator trust decision to send task content and the selected key to that service; runtime rejects redirects and other request URLs.

These are service APIs. The OpenCode and CommandCode clients, installation and plans are separate. OpenCode Go documents model-specific endpoints and its current public catalog includes `gpt-5.6-luna`. CommandCode says its Go plan excludes API access and Claude uses Messages only; check its model catalog for current account model and endpoint support. The adapter does not impersonate clients to bypass platform restrictions.

This layer preserves model governance: only Luna / Sonnet 5 exact names or `namespace/<exact-name>` mappings are accepted. Other Go models and Chat Completions-only platforms do not become available workers. Changing role models or reducing reasoning requires a separate governance change; aliases cannot silently substitute a different model.

## Setup

1. Copy `templates/provider-config.example.json` to a working file. Remove unused routes. The example intentionally fails validation with `maxThinking:false`; confirm full max support for the service/account/model before changing it to true. Capability flags are operator declarations, not live probe results.
2. Set platform, baseUrl, model, semanticModel, credentialRef, contextWindow, maxTokens and capabilities. semanticModel must be `gpt-5.6-luna` for workers or `claude-sonnet-5` for reviewers. Context/output limits are explicit local limits, not automatic platform discovery; examples use conservative limits. Workers require tools and streaming; reviewers remain runtime-enforced `access:none` with no tools.
3. After one-click installation run `%LOCALAPPDATA%/YHWH/Configure-Providers.cmd`, enter the JSON path, then enter each API key using hidden input. A source/portable directory also supports:

```powershell
node .\install\provider-config.mjs .\my-provider-config.json
powershell.exe -NoProfile -File .\install\Set-ProviderConfig.ps1 -TargetHome $HOME -ConfigPath .\my-provider-config.json
powershell.exe -NoProfile -File .\install\Set-ProviderApiKey.ps1 -TargetHome $HOME -CredentialRef opencode-go
powershell.exe -NoProfile -File .\install\Set-ProviderApiKey.ps1 -TargetHome $HOME -CredentialRef commandcode
```

4. Install/upgrade the gateway and WSL files from this version, then call `list_capabilities`. Configuration does not upgrade an old service; do not upgrade during active tasks. Inspect `controlledApi.configured`, explicitly select `yhwh-worker-api` or `yhwh-reviewer-api`, use the configured actual model ID, and set thinking to max. Defaults remain unchanged.
5. Use existing `probe_model` for an authorized no-tools heartbeat of the configured provider/model, followed by a bounded task to verify tools. A heartbeat sends content and consumes platform quota; installation/configuration makes no model call. Actual server execution of max still requires provider support and live evidence; the client can guarantee only the transmitted value.

Only the fixed host path `~/.local/state/pi-kether/provider-config.json` is read. Task JSON cannot supply configuration paths, baseUrl, secrets or capability overrides. `provider-credentials.json` in the same directory holds entries referenced by credentialRef; its ACL admits only the current Windows user. Task snapshots, source control and release packages exclude both local files. Never put personal configuration or keys in the repository.

Each task pins the configuration SHA256. The root launcher outside the sandbox rereads the fixed host configuration and rejects changes before sending the task to a new platform. Only the selected key enters memory through FD3, never sandbox files, arguments or environment variables. Returned opaque keys receive additional redaction. API-route costs are marked unknown instead of presenting the SDK's placeholder zero as free usage. Provider-side routing, retention and plan overflow billing remain account settings; YHWH cannot guarantee or replace them.

Remove a route to disable it; `{"version":1,"routes":{}}` disables all optional routes. Changes block pending tasks pinned to the previous configuration but do not recall already-sent requests. Existing direct API/OpenAI login settings remain independent.

## Verification and sources

Local checks cover invalid configuration, role/access regression, PS5.1 fixture-key ACL/rotation/failed-update preservation, and pinned Pi 0.84.4 SDK requests with intercepted networking: Responses/Messages URL, Bearer authentication, model and max payload. No real platform credentials, paid heartbeat, real tool execution, clean-machine installation or live-service migration were used. Adapter implementation does not establish access for every platform account. The example CommandCode Sonnet 5 model still needs account-catalog confirmation and is not claimed as live verified.

Official sources checked 2026-09-19: [OpenCode Go](https://opencode.ai/v2/docs/console/go), [Go model catalog](https://opencode.ai/zen/go/v1/models), [CommandCode Provider API](https://commandcode.ai/docs/provider), [OpenRouter Messages](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages).

[OpenRouter Responses API](https://openrouter.ai/docs/api/api-reference/responses/create-responses)


## 0.8 API key encryption at rest

Anthropic and controlled aggregator API keys now use Windows DPAPI `CurrentUser` encryption, retaining current-user-only file permissions. Input remains hidden; files contain only `api_key_dpapi` encrypted envelopes, additionally bound to the credential category and reference. Moving to another Windows user or machine usually requires re-entering keys; installers do not migrate credentials.

Call path: trusted Windows helper decrypts in memory → private process pipe → WSL validates route/config digest → kernel pipe FD3 → Pi memory. API routes no longer create plaintext temporary credential files. Legacy plaintext returns `PI_AUTH_MIGRATION_REQUIRED`; damaged or undecryptable ciphertext fails without plaintext, environment-variable or account fallback.

After stopping old tasks and installing matching gateway/WSL files, run **`Migrate-API-Keys.cmd`** in the installation directory. From a source or portable package:

```powershell
powershell.exe -NoProfile -File .\install\Migrate-ApiCredentials.ps1 -TargetHome $HOME
```

Migration operates separately per credential file: validate old values, encrypt, verify decryption, then atomically replace. No plaintext backup is created, repeated runs leave encrypted files unchanged, and validation failures preserve the original file. Upgrade code and credential format together; old versions cannot read ciphertext. Migration cannot erase historical backups, freed disk blocks or external copies and does not promise secure erasure.

This covers YHWH-managed Anthropic/aggregator API keys. Existing Pi SDK storage still manages OpenAI OAuth login and refresh. Runtime requires temporary plaintext memory; DPAPI does not defend against attackers controlling the current user, trusted Pi process or OS. No real local credentials or running service were changed by this implementation.

Checks include actual DPAPI fixture roundtrips, tamper/reference-substitution rejection, rotation, failure preservation, idempotent migration and an offline WSL/Bubblewrap FD3 probe. Cross-user/machine rejection was not tested with a second account. Paid model calls and a complete live upgrade remain unverified. Reference: [Microsoft DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata).
