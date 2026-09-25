# Cooperative small task packets

YHWH can compile one goal into 2–4 independent Pi subtasks. A group shares a `parentRunId` and goal digest; each worker receives only its own objective, acceptance criteria, context, and file scopes. Write scopes must not overlap. The gateway still enforces resource budgets, concurrency, and write locks. Planning calls no model and submits no task.

Prepare a JSON file at the repository root, for example:

```json
{
  "cwd": "E:\\Projects\\Example",
  "parentRunId": "feature-20260925-01",
  "runGoal": "Complete two independent modules",
  "runAcceptance": ["Both modules pass their separate checks"],
  "units": [
    {"id":"api","objective":"Implement the API module","acceptance":["API checks pass"],"context":[],"readScope":["src/shared.mjs"],"writeScope":["src/api.mjs"]},
    {"id":"ui","objective":"Implement the UI module","acceptance":["UI checks pass"],"context":[],"readScope":["src/shared.mjs"],"writeScope":["src/ui.mjs"]}
  ]
}
```

`cwd` must be an absolute directory allowed by the gateway; file scopes are exact paths relative to that directory. You may set an optional run-level `thinking` value: `low` or `medium`; the default is `medium`. This planner is intended for small runs with a fixed 120-second limit and does not accept `high` or `max`. Reserve `low` for exact, low-risk microtasks; prior comparisons are suggestive only and do not prove that `medium` will prevent output-format failures. Choosing a different `thinking` value results in different stable request IDs. Inspect the plan, then submit from a terminal authorized to access the local gateway:

```powershell
node payload/pi-dispatch/scripts/gateway-client.mjs cooperative-plan .\spec.json
$env:PI_GATEWAY_CONFIG = Join-Path $HOME '.local\state\pi-kether\gateway-silent.json'
node payload/pi-dispatch/scripts/gateway-client.mjs cooperative-submit .\spec.json
```

Submission returns stable request IDs, not final outcomes. Use the existing `list_subagents` / `get_subagent_result` tools for completion status and full results. If a receipt fails or is uncertain, reconcile its original request ID with the gateway before retrying; do not mint a replacement ID automatically. Repeating the same specification reuses stable IDs.

The compiler bounds unit objectives, context, acceptance items, owned files (at most two per unit), and request size. It does not automatically decompose vague work, share the full conversation, merge patches, or replace primary-agent acceptance; it does not attest a full v2 stage handoff chain. For stage dependencies, the primary still uses typed handoffs. Parallel coding requires independent file ownership. The source CLI has passed a live two-worker read-only concurrency check; the corresponding CLI in an installed plugin needs separate synchronization, and complex write groups remain unverified in live service.
