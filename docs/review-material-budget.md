# Active T1 review material budgets

Activated by the user's explicit request on 2026-10-11; historical proposal docs remain provenance.

- Non-diff: 8192 bytes. Complete reviewPacket: 24576 bytes. Both use normalized JSON UTF-8 bytes.
- Designated diff is the complete unified patch in changes.content, joined without separators (chunk boundaries are serialization only). Its strings become empty strings for non-diff accounting; structure and all other fields remain. Put explanations in context.
- Review material must match the ledger's redacted patch projection exactly, including its headers and whitespace. Secret-like text uses the redacted form; it does not grant access to the private raw apply artifact.
- Structural validation alone is preliminary. Before model admission the gateway requires the exact complete redacted patch from the trusted host-verified ledger artifact, binding its parent, canonical workspace, anchor and artifact fingerprint. It never accepts caller-provided hashes as proof.
- Over budget: organize complete review material by actual commits, preserving the whole goal's tier, identity, review count/time and unresolved blockers. Each range needs complete diff, current evidence and cross-commit context. Existing gateway reviews still bind one complete implementation artifact: there is no partial-artifact acceptance or automatic quota increase. Stop for the user if a commit cannot fit or required ranges cannot be reviewed within quota.
- All required ranges and final combined-artifact host verification must pass. Nonblocking findings remain conditional approval. T2, maintenance-channel reviewer safety limits, model routing, isolation and final acceptance requirements are unchanged.
