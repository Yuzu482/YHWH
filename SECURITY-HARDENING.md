# Security hardening verification — 2026-09-05

The dated evidence below describes the 0.6.0 API-key reviewer route. The current default reviewer route uses the official Claude Code CLI on the Windows host with `access:none`, an empty temporary directory, no-tools arguments, a sanitized child environment and a bounded Job Object. This route is **not inside the WSL sandbox**. The gateway does not inspect or renew Claude Code login state, and it never switches automatically to the retained native Anthropic API-key route. OpenAI refresh remains host-owned. See VERIFICATION.md for current checks.


Implemented in the source plugin, installed Gateway, WSL runtime and portable payload:

- Disabled automatic repository `.pi-lsp.json` executable configuration and Lombok Java-agent discovery.
- Restricted Gateway and envelope providers to openai-codex.
- Replaced whole-workspace copying with an explicit read/write-scope snapshot. Rejected sensitive configuration, links and special files; bounded snapshot scanning, bytes and file counts.
- Passed only the selected provider credential to trusted Pi bootstrap through a one-use descriptor. Closed it before model tools run; no auth file, credential environment variable or procfs is exposed to tools.
- Protected the write manifest with a read-only mount and an independent root-owned verification copy. Verified actual final file changes as well as rejecting binary/non-unified patch records.
- Bounded task temporary storage with a 512 MiB tmpfs and 30,000-inode limit. Snapshot/final regular-file budget is 128 MiB and 10,000 files. Existing CPU, process, time and output controls remain active.
- Restricted Windows Pi authentication/state ACLs to the current user, SYSTEM and Administrators.
- Redacted JSON credential fields and ledger object keys; preserved newlines and full length when caching redacted patches.
- Reduced unauthenticated readiness output to service identity and readiness. MCP remains authenticated.

Observed verification:

- 74 Node tests passed, including authentication, minimal readiness, scope checks, binary patch rejection, redaction and persistent replay.
- Four Linux snapshot security tests passed, covering scoped copying, sensitive/traversal scope rejection, binary out-of-scope changes and oversized files.
- Real Pi no-tools request and multi-turn read/write/read request succeeded through openai-codex. Host input remained unchanged; returned patch covered only the authorized file.
- Restarted the idle installed HTTP Gateway. Its authenticated capabilities list only openai-codex. A fresh real model heartbeat and Python `lsp_diagnostics` both succeeded with confirmed cleanup.
- No task cgroups remained after these checks. Portable self-test, plugin validation and payload Node suite passed.

Limits: this is targeted hardening and smoke verification, not a proof against OS, trusted dependency or language-server compromise. Network egress remains enabled and is not domain-allowlisted. OAuth refresh is in task memory only; persistent host login still needs maintenance. Redaction recognizes known patterns and field names; it cannot identify every arbitrary sensitive sentence. Other language servers and 50–100-task endurance behavior were not retested in this change.
