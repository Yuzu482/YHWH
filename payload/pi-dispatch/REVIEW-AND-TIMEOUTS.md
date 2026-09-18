# Queue budgets and review evidence

The gateway keeps queue admission separate from execution. `queueTimeoutSeconds`
defaults to 120 and accepts 1..900. `timeoutSeconds` starts at admission and is
still capped by the selected resource profile. Prefer `submit_subagent` for long
work; synchronous callers need a transport deadline covering both budgets plus
cleanup. The OS resource caps and host memory reserve are unchanged.

Status/card fields include `waitReasons`, `queueDeadlineAt`, `queueWaitMs`, and
`executionMs`. Reasons are `concurrency`, `provider_capacity`, `memory_capacity`,
`cpu_capacity`, `host_memory`, `dependency`, and `write_lock`. A reported resource
or dependency block precedes lock acquisition, so the reason list is not an
exhaustive prediction of later blockers. The audit stores the two durations.

## Review request

Geburah/reviewer remains Claude Sonnet 5 with `access: none`. Main-agent supplied
material belongs in `task.reviewPacket`, not solely in unstructured `context`:

```json
{
  "version": 1,
  "stage": "post-change",
  "requirements": {"status": "provided", "content": ["Requirement and acceptance criteria"]},
  "changes": {"status": "provided", "content": ["Actual diff or the concrete proposed plan"]},
  "context": {"status": "provided", "content": ["Relevant surrounding source and interfaces"]},
  "verification": {"status": "provided", "content": ["Actual checks, outputs, failures and unverified items"]}
}
```

Use `pre-change` for a design/pre-mutation review; verification then contains the
planned checks and explicitly says they have not run. Do not present plans as
post-change test evidence. Mark unavailable material `missing`. Only changes and
verification may be `not-applicable`, with a nonempty `reason`; requirements and
context cannot be waived. The reviewer must assess whether any waiver is valid.
Content is bounded (32 entries of 8,000 characters per section, 128 KiB total).
Include actual excerpts, not just inaccessible paths or claims that files exist.

Missing required sections or empty provided sections return `status: blocked`,
`code: REVIEW_MATERIALS_MISSING`, and `missingMaterials` before model execution.
Legacy reviewer requests using only `context` must migrate. Other worker roles
and gateway-generated heartbeats do not require this packet.

Reviewer outputs retain normal Kether fields and add `reviewDecision` and
`missingMaterials`. `approve` and `request-changes` use `status: completed` and an
empty missing list; `insufficient-materials` requires `status: blocked` and a
nonempty list. Only an internally consistent `approve` with evidence yields
gateway `ok: true` and a successful dependency outcome. Review rejection does not
trip the Provider circuit. Deterministic checks validate structure and consistency,
not the truth or semantic completeness of evidence; the reviewer and primary
agent retain responsibility for that judgment.

Audit records contain packet digest, byte count, and stage, never raw review
material. Reusing a request ID with different packet/budget fields is a conflict;
do not issue replacement write IDs to evade indeterminate or conflict records.

After deployment, refresh the Pi connection in ChatGPT Plugins and use a fresh
conversation to load the new schemas and card resource.
