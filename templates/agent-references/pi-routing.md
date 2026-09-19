## Current Pi routing policy

Query list_capabilities.governance.roleModels and roleProviders before model dispatch. Model-backed workers/researchers and Yesod/Binah/Malkuth/Hod/Chochmah/Chesed/Netzach use openai-codex / gpt-5.6-luna / max. worker maps to Chesed; researcher maps to Malkuth.

Geburah/reviewer uses anthropic / claude-sonnet-5 / max, access none, with no file scope, shell or tools. This is the explicit reviewer exception to the default openai-codex route. Supply actual material in task.reviewPacket. Kether/Tifereth remain in the host. Da'at is unavailable until a capable route is explicitly configured. Never change roles or providers to evade bindings. probe_model alone may test another approved tuple. Credentials never belong in portable packages. PI_AUTH_MISSING/INVALID/EXPIRED/INELIGIBLE requires host login repair; do not retry ordinary tasks until a Tifereth-directed recovery probe succeeds.


## Optional controlled API transports (0.7)

The default bindings above remain unchanged. A host operator may explicitly configure fixed `~/.local/state/pi-kether/provider-config.json` and select `yhwh-worker-api` for worker roles or `yhwh-reviewer-api` for Geburah. These are transport alternatives only: semantic models remain gpt-5.6-luna / claude-sonnet-5 with max, reviewer access remains none, editor authorization is unavailable for these routes. Query list_capabilities first; unconfigured routes and changed configuration digests fail closed. Never auto-switch, lower thinking, supply endpoints/secrets through task input, or treat capability declarations as live verification. Keys come only from the separate host provider-credentials.json store via FD3. Direct provider auth tools do not validate aggregator keys. Platform account, model, endpoint and max support require an authorized live probe. Follow stricter host policy if it does not admit these optional transports.
