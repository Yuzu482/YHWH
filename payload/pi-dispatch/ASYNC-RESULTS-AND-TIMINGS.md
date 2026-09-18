# Async results and review timing


## Async result acceptance and review timing

Use submit_subagent for review and other delegated work. get_subagent_status reports progress, not the full evidence. When terminal, call get_subagent_result with requestId. Require ready=true; then check state, result.ok, formatValidation and structuredResult/reviewValidation. For large responses concatenate resultJsonChunk pages by nextOffset and verify the SHA-256 of the reconstructed UTF-8 JSON before parsing. Offsets are JavaScript UTF-16 units. Redaction precedes pagination. Results are retained only in this gateway instance and may be evicted with old terminal monitor entries; RESULT_NOT_FOUND does not authorize repeating a write task. Reconcile writes through the existing ledger.

For nontrivial reviews, Tifereth should prefer standard resources with up to 300 seconds when admission permits, keep the pinned model/thinking, and submit one independently reviewable change per material packet. Tiny format probes can use small. Never omit required review evidence to fit the budget. Inspect authenticationMs, startupMs, timeToFirstResponseMs, firstResponseSource, generationMs, processTailMs and cleanupMs. Missing measurements are null, not proof of zero work. Timings are host observations of Pi stream events; timeToFirstResponseMs includes startup and may only observe the completed message when streaming is unavailable. Generation is measured until agent_end, not provider-only GPU time.

Host Claude renewal requires at least max(5 minutes, task timeout + 60 seconds) of validity before dispatch, and verifies the renewed expiry meets that same requirement.
