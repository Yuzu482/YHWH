## Current Pi routing policy

Query list_capabilities.governance.roleModels and roleProviders before model dispatch. Model-backed workers/researchers and Yesod/Binah/Malkuth/Hod/Chochmah/Chesed/Netzach use openai-codex / gpt-5.6-luna with task-proportional thinking. worker maps to Chesed; researcher maps to Malkuth.

## Task-proportional native worker thinking (2026-09-22)

This policy supersedes fixed Luna/max wording in older references and skills. Preserve provider/model bindings, primary coordination, review independence and no-polling rules. The primary selects and explicitly sends `thinking`: low for exact low-risk changes, medium for ordinary bounded implementation (default), high for cross-file design or uncertain diagnosis, max only for justified difficult reasoning. Record the choice and reason; do not automatically fall back to off/minimal, another model or provider.

Use one behavior per task packet and concise required output. Plan approximately 20 percent of runtime for final delivery and verification handoff. Prompt deadlines are soft guidance, not reasoning-token caps or completion guarantees. Queue admission and execution remain separately bounded; execution includes authentication, startup, generation/tools, output and cleanup. A failed or partial result is not accepted work. Reassess scope before bounded repairs.

Reviewer Sonnet/max and optional controlled API transport policies below remain unchanged. This adjustment applies to the native openai-codex worker route. Explicit selections work on compatible existing services; changed advertised defaults and execution-budget behavior require a service upgrade. Validate quality and elapsed time before claiming savings.

Geburah/reviewer uses anthropic / claude-sonnet-5 / max, access none, with no file scope, shell or tools. This is the explicit reviewer exception to the default openai-codex route. Supply actual material in task.reviewPacket. Kether/Tifereth remain in the host. Da'at is unavailable until a capable route is explicitly configured. Never change roles or providers to evade bindings. probe_model alone may test another approved tuple. Credentials never belong in portable packages. PI_AUTH_MISSING/INVALID/EXPIRED/INELIGIBLE requires host login repair; do not retry ordinary tasks until a Tifereth-directed recovery probe succeeds.


## Optional controlled API transports (0.7)

The default bindings above remain unchanged. A host operator may explicitly configure fixed `~/.local/state/pi-kether/provider-config.json` and select `yhwh-worker-api` for worker roles or `yhwh-reviewer-api` for Geburah. These are transport alternatives only: semantic models remain gpt-5.6-luna / claude-sonnet-5 with max, reviewer access remains none, editor authorization is unavailable for these routes. Query list_capabilities first; unconfigured routes and changed configuration digests fail closed. Never auto-switch, lower thinking, supply endpoints/secrets through task input, or treat capability declarations as live verification. Keys come only from the separate host provider-credentials.json store via FD3. Direct provider auth tools do not validate aggregator keys. Platform account, model, endpoint and max support require an authorized live probe. Follow stricter host policy if it does not admit these optional transports.
