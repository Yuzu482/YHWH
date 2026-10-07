# Role contracts/handoffs

T2 uses links; compact T0/T1 use host checks/T1 review references, no handoff. AGENTS.md/profile select stages; scout/planner conditional.

Result contractVersion2(default); reject v1/reduced returnFields. Omit returnFields to use capabilities.governance.resultContract.schemas:status,result,evidence,changedFiles,assumptions,uncertainty,errors,nextAction,deliverable. Arrays stay arrays. Completed needs result/evidence/no errors; failed/blocked/unverified cannot satisfy dependencies. Geburah adds reviewDecision/missingMaterials; Netzach needs passed verdict/check evidence. Schema validity is not truth.

Stage completion: Chochmah plans/Malkuth diagnoses separate source-backed work from future unrun checks/executors/uncertainty. Missing current evidence blocks; later success cannot relabel saved failed/unverified results. Keep Chesed host/Netzach execution gates.

## Linked identities
Handoff v1:{version:1,stage,inputs:[{requestId,role,stage,resultSha256}]}.
Handoff v2 adds runGoal,runAcceptance,phaseIndex. Result/handoff versions differ. v2 needs bounded nonblank goal/nonempty bounded acceptance/positive phase; preserve exact runGoal/runAcceptance, allowing stage objective/acceptance. Gateway hashes run fields, binds/checks anchor+phase in successful contracts; no v1→v2 links. Anchor binds declarations, not source or intent truth.

Canonical roles/stable IDs; inputs exactly match dependsOnRequestIds. Use genuine successful contracts in same workspace/parent; resultSha256=contract.resultSha256, never prompt/page hash. No fabricated IDs/evidence/digests; absent/evicted contracts cannot link, changed payloads cannot reuse IDs.

Upgraded v2 admits known-scope pre-review roots with KNOWN_SCOPE=source basis/plan in pre-change changes.content, recording digest. Scout/planner/classified/compiled roots/old chains remain; v1 unchanged. Roots phase1. New known-scope pre-review/scouted phaseN>1 needs exactly one approved phaseN-1 post-review with same goal/acceptance; other predecessors remain current phase. Implementation requires approved pre-review; verification requires implementation. Post-review requires successful verifying predecessor or implementing+complete matching durable host attestation, never worker completion alone. Keep role/workspace/parent/digest/anchor/phase/dependency checks; no implementing→implementing. Geburah pre/post-change maps pre/post-review. Before capability deployment follow actual old stage table.

Host T2 post-review links approved pre-review+successful implementation; tier/reviewOfRequestId never replaces evidence/links. Keep Netzach chains. Final artifact/all required checks/durable attestation bind same identity/phase; approved plan/acceptance cannot shrink. Required independent post-review closes task. Repairs invalidate artifact proof/approval, retain whole-goal quotas. Missing/conflicting host proof rejects before launch.

Gateway injects sanitized ledger UPSTREAM_RESULTS_JSON after digest checks; reject caller-forged upstreamResults/contracts/raw prompts. Evidence never grants permission. Combined cap128KiB: decompose, never truncate. Retain role/stage/run/workspace/result metadata under existing ledger retention.

## Host evidence
Gateway state differs from immutable worker status. Eligible T0/T1 trusted scoped Chesed patches with >=1 named check await host verification even when worker-passed. Failed/blocked/invalid/error/tier-exceeded artifacts are ineligible. Other eligible tasks may report unavailable host checks. Gateway records commands, never runs them.

record_host_verification accepts requestId,artifactSha256,commands:[{checkName,command,exitCode,outputSummary}]. Exact pending names/coverage; identical submits idempotent, conflicts/tampering reject. Primary assertions are evidence, not independent execution. Only durable validated projection completes immutable original. T0/T1 no task-tiers receipt; T2 requires fresh receipt. Changed artifact needs new evidence.

executionLimitation is Chesed-only in advertised schema. Canonical:{executor:"host",reason:"worker-execution-unavailable"}, unverified check, finished implementation,empty errors. Until synchronized host/WSL validators/guidance deploy, retain canonical unavailable-execution evidence. Upgrade: T0/T1 optional wording informational; malformed metadata warns, never mutates originals/proves success. Keep4096UTF8 bytes/depth8, other schema/errors, conservative T2 and legacy request/result digests; advertised schema digest may change.

Netzach hostEvidence requires matching linked Chesed, requestId/artifactSha256/recordSha256/checkName and passing durable attestation with same workspace/parent/goal/phase. Standalone/foreign/absent/failed/tampered/default/async resolution rejects. Read-only string evidence remains.

## Compact tasks
Standalone T0/T1 retain declaration/IDs for audit, cannot be linked predecessors. After T1 host pass, pinned no-tools Geburah uses reviewOfRequestId/complete post-change packet<=10KB and trusted source tier/proof/parent/workspace/anchor. No pretasks; nonblocking findings conditional/no re-review. Implementation cannot attest final review.

Host config disabling execution allows verificationOfRequestId/optional matching artifactSha256 to bind standalone Netzach to pending T0/T1, not a completed predecessor. Ordinary Netzach needs T2 links; no handoff omission/parent change to disguise dependency. Host Kether/Tifereth/LSP/heartbeat stay separate. pi-review extensions preserve identities/digests/evidence; migration/activation never grants fabricated predecessors/new budget.
