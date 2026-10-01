# Cooperative small task packets

YHWH can compile one goal into 2–4 independent Pi subtasks. A group shares a `parentRunId` and goal digest; each worker receives only its own objective, acceptance criteria, context, and file scopes. Write scopes must not overlap. The gateway still enforces resource budgets, concurrency, and write locks. Planning calls no model and submits no task.

Prepare a JSON file at the repository root, for example:

```json
{
  "cwd": "E:\\Projects\\Example",
  "parentRunId": "feature-20260925-01",
  "runGoal": "Complete two independent internal modules",
  "runAcceptance": ["Both modules pass their separate checks"],
  "writeTier": "T1",
  "tierDeclaration": {"files":["src/engine.mjs","src/view.mjs"],"estimatedLines":40,"isTestOrConfigChange":false,"publicApiOrProtocol":false,"dependencyOrLockfile":false,"securityAuthOrCredentials":false,"migration":false,"irreversibleOrNoRollback":false,"uncertainFileScope":false},
  "units": [
    {"id":"engine","objective":"Implement the internal calculation module","acceptance":["Module checks pass"],"context":[],"readScope":["src/shared.mjs"],"writeScope":["src/engine.mjs"]},
    {"id":"view","objective":"Implement the internal view module","acceptance":["Module checks pass"],"context":[],"readScope":["src/shared.mjs"],"writeScope":["src/view.mjs"]}
  ]
}
```

`cwd` must be an absolute directory allowed by the gateway; file scopes are exact paths relative to that directory. A cooperative run with writes must declare `writeTier: T1` and one `tierDeclaration` for the whole group. Its `files` must exactly cover all unit write files; the compiler preserves T1 on each emitted write and narrows its declared file list. T2 risks such as public interfaces, dependencies, security or migrations are rejected here and require a linked handoff with pre-review. Omit both fields for a read-only run. T1 still needs an independent post-review before acceptance. You may set an optional run-level `thinking` value: `low` or `medium`; the default is `medium`. This planner is intended for small runs with a fixed 120-second limit and does not accept `high` or `max`. Reserve `low` for exact, low-risk microtasks; prior comparisons are suggestive only and do not prove that `medium` will prevent output-format failures. Choosing a different `thinking` value results in different stable request IDs. Inspect the plan, then submit from a terminal authorized to access the local gateway:

```powershell
node payload/pi-dispatch/scripts/gateway-client.mjs cooperative-plan .\spec.json
$env:PI_GATEWAY_CONFIG = Join-Path $HOME '.local\state\pi-kether\gateway-silent.json'
node payload/pi-dispatch/scripts/gateway-client.mjs cooperative-submit .\spec.json
```

Submission returns stable request IDs, not final outcomes. Use the existing `list_subagents` / `get_subagent_result` tools for completion status and full results. If a receipt fails or is uncertain, reconcile its original request ID with the gateway before retrying; do not mint a replacement ID automatically. Repeating the same specification reuses stable IDs.

The compiler bounds unit objectives, context, acceptance items, owned files (at most two per unit), and request size. It does not automatically decompose vague work, share the full conversation, merge patches, or replace primary-agent acceptance; it does not attest a full v2 stage handoff chain. For stage dependencies, the primary still uses typed handoffs. Parallel coding requires independent file ownership. The source CLI has passed a live two-worker read-only concurrency check; the corresponding CLI in an installed plugin needs separate synchronization, and complex write groups remain unverified in live service.
