# Review budgets and materials

Reviewers stay pinned/access:none, medium default; high/xhigh require concrete pi-routing complexity reasons in context. Tier/security scope/packet size alone never forces max; routine max is not admitted. Effort changes neither independence, evidence nor attempts. Queue timeout defaults120s/max900s; execution profiles120/300/900s, explicit small/standard up to global900s. CPU/RAM/PID/output/scheduler remain fixed; never reduce host reserve/change route to evade admission. Prefer submit_subagent; distinguish waitReasons/queueWaitMs/executionMs.

## Material and decision gates
Every Geburah/reviewer task has structured reviewPacket v1, stage pre-change/post-change, requirements/changes/context/verification. Sections use status provided/missing/not-applicable, actual bounded excerpt-string content and optional reason. Only changes/verification can be not-applicable with explicit justification. Missing required material blocks before execution. No inaccessible filenames/test plans presented as run evidence. Reviewer questions incomplete/contradictory material; output includes reviewDecision/missingMaterials.

Approve needs completed/evidence/no missing material. T1 explicitly nonblocking findings mean conditional approval, no re-review; blocking/insufficient material stays incomplete. T2 limits survive repair/relabeling. No recursive reviewer delegation.

Before submission compare actual changed files with complete actual packet. Include concrete hunks for EVERY file, including tests/docs/fixtures, relevant source context and real host output. Filenames/prose alone are not diffs. T1 serialized UTF8 cap10240bytes: if complete material cannot fit, stop and resolve delivery/scope without splitting tier, truncating or exploratory review.

Deterministically chunk complete real material; check file coverage/serialized bytes BEFORE dispatch. Artifact references resolve to trusted implementation/digest/identity, never arbitrary paths. Hydrate/redact then enforce limits; stale/inaccessible/missing/oversized material fails closed. Preserve caller idempotency payload. Generated changes need actual diffs unless complete deterministic equivalence to authoritative inputs is proved. Coverage is deterministic; semantic completeness remains primary/reviewer responsibility.

Request concise schema-complete findings/evidence, never copied diffs. Repair review must close every blocker/missing item and revalidate material. Approved/conditional outcomes stop unnecessary review. Actual-launch malformed/insufficient result consumes quota; proven zero-launch/admission/queue rejection does not. Timeout/uncertain execution never refunded because unusable. Changed artifacts require fresh host evidence and invalidate prior approval, with original limits.

## Elastic quota
Activate only if elasticReviewQuota.version2 or workflowTiers.reviewQuota.version2 is advertised. Until then T1 one post, T2 two/stage; proposed extension never authorizes its own implementation.

|Tier|Base|Maximum|Total execution|
|---|---|---|---|
|T0|none|none|none|
|T1|one post|one evidence-gated extra;total2|600000ms|
|T2|two/stage|one extra SHARED;stage3,total5|1200000ms|

Counts/time span whole goal, repairs, phases, IDs and restart. Canonical workspace+goal anchor bind identity; existing non-null parent cannot change anchor; new parent cannot reset same anchor. Missing parent creates no shared alias; legacy missing parent cannot safely establish one. Tier change never refunds. Queue time separate; measured milliseconds round down to admitted integer seconds. Reject inadequate viable execution budget before launch; over-reservation still charges, remaining clamps0. Missing tokens unavailable.

Extra eligibility needs one bounded typed REVIEW_PROGRESS_JSON= context entry referencing prior failed review and closure evidence for EACH persisted blocking/missing key. Gateway resolves trusted decision/stage/phase/goal/digests/paths. Caller assertions, IDs, duplicate materials or unrelated edits give no credit. Pre-review needs changed complete plan/revised cited sections. Post-review needs a different trusted repaired artifact plus complete current passing bound host evidence. Identity/coverage checks do not prove semantic closure. Timeout/malformed output without actionable blockers is ineligible.

Unchanged stage/phase/material cannot repeat. Different necessary correction invalidates approval and uses only remaining BASE quota after approval, never extension. Legitimate v2 phase continuation preserves aggregate counts/time. Normalize keys by lowercase/collapsed whitespace/severity/cited paths/sections; two consecutive identical/nonshrinking blocker sets without verified progress stop retry. Exhausted count/time, missing trusted progress or ambiguous identity escalates with original outcomes, not new run identity, effort increase or ledger clearing.

Atomically reserve count/worst-case execution and serialize same-goal pending reviews. Proven zero-model execution releases reservation; started timeout/unknown execution consumes. Crashed/pending tickets retain conservative allowance, fail closed with identity for operator reconciliation. Validate/import oldv1 records idempotently on EVERY admission, including later old-runtime writes; unknown old time conservatively charges legacy900s ceiling. Never delete history. Missing validated decision cannot unlock extension, including execution-finished/decision-not-persisted crash.

Compact T1 repairs keep original implementation objective/acceptance anchor, correction details in context. Linked T2 keeps runGoal/runAcceptance/phase. Changing them cannot reset budget. Implementation dispatch budget is separate (initially3 then diagnosis/reassessment, tighter user bound applies). This grants no deployment, identity override, ledger clearing, route substitution or primary-direct authorization. pi-results covers completion waits/pagination/timings; pi-auth covers real credential/probe handling.
