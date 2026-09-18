# Strict DSH dispatch reference

Use only with an actually available compatible DSH Tifereth workflow. This is not a Codex configuration file, and the native portable path must not pass this schema to unrelated tools.

The current user-profile preset declares contractVersion 1.0, contractId matching exe- plus a lowercase slug of at least eight characters, issuer Kether, entryPoint kether-gui, workflowRequired true, coordinatorDirectExecution false, bypassAllowed false, governanceLevel strict, destructiveOperationPolicy review-required, escalationPolicy monotonic, and scope containing taskId and exact allowedFiles.

Required stages in canonical order:
compiled, clarified, admitted, classified, scouted, planned, pre-review, implementing, verifying, post-review.

Generate real per-task identifiers and scope from observed task evidence. allowedExecutionModes is ["plan"] for a read-only plan contract. After the required execution approval, issue a new contract with allowedExecutionModes ["execute"]. A clarification response alone never authorizes that transition.

Dispatch with contractMode: "strict" and args.executionContract containing the authoritative object. Do not substitute args.contract or keys named protocol, stages, or gates. A disputed/invalid contract returns ESCALATE_TO_KETHER; backend agents may not rewrite it.

The original preset requires Kether not to read/write files directly; its filesystem observation tool is fs-search, with exact-content observation delegated to workflow agents. This tool restriction belongs to the DSH preset. It is not a claim that the host has disabled file tools.

Runtime composition: @deepseek-ai/dsh-workflow-worker-thread (provider spawn), @deepseek-ai/dsh-tool-workflow and dsh-tifereth-adapter share an isolated workflowEngine. Validate that actual dispatcher/runtime before declaring strict execution active. Fail visibly if the required runtime or contract validator is absent.

Desktop Tifereth additionally validates contractId against ^exe-[a-z0-9-]{8,64}$, rejects unknown fields and mode mismatch, and requires dsh.agent-message.v1 child messages with messageId, contractId, contractVersion, stageId, sender, recipient, requiresStructuredReply:true plus a matching dsh.agent-result.v1 acknowledgement. Preserve contractId through all child prompts; implementation replies echo executionContractId. Read the live adapter schema before serializing a real invocation.
