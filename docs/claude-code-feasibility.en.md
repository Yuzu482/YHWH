# Claude Code integration and the Anthropic API reviewer

[简体中文](claude-code-feasibility.md) · Updated: 2026-09-19 · Version: 0.6.0

## Current implementation

Claude Code remains a primary-client option through MCP and `CLAUDE.md`, with users signing in directly through the official client. The lower reviewer now uses native Pi `anthropic / claude-sonnet-5 / max` with the user's own Anthropic API key, billed separately for API usage.

Release sources no longer read, renew or forward Claude.ai subscription credentials, run the Claude Code binary, or download Claude Code / pi-claude-code-provider. The old route and `renew_claude_auth` tool are rejected; the replacement tool is `check_claude_auth`. These changes affect repository sources and preview packages and have not been deployed to the running local service.

## Credentials and permissions

Run `Configure-Claude-API.cmd` or `install/Set-ClaudeApiKey.ps1 -TargetHome <user-home>` and enter the API key through hidden input. Configuration is stored at `~/.local/state/pi-kether/anthropic-api-key.json`, accessible only to the current Windows user. Never place it in a project, Git, installation package or task materials.

`claude-api-auth.mjs` validates only the dedicated local file without network access. `anthropic-api-credential.mjs` rejects subscription tokens, command-based keys and incorrect routes. The WSL root launcher reads selected credentials from a read-only host mount and passes them through FD3 into trusted Pi in-memory storage, then closes the descriptor. Keys do not enter CLI arguments, environment variables or persistent sandbox files. Authentication failures do not fall back to environment keys, subscription login, alternate endpoints or models.

The reviewer retains `access:none`, without file scopes, shells or tools. Scheduling, timeout, cancellation, cleanup, role and result contracts remain enforced. Removing Bun lets the reviewer use an empty `/proc` too. A successful `check_claude_auth` means only that local configuration has the expected format, not that balance, permissions or remote model access are valid. After repair, the primary must explicitly authorize a recovery heartbeat before resuming work.

## Basis and verification boundaries

This migration follows official guidance to use API keys or supported cloud credentials for third-party products. Primary Claude Code login remains separate from lower API authentication. [Anthropic terms](https://code.claude.com/docs/en/legal-and-compliance)

Sonnet 5 supports max effort; the pinned Pi 0.84.4 catalog includes the model and its max mapping. [Official effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort)

This work uses fixture keys for offline regression, configuration ACL and packaging checks; actual outcomes are recorded in [VERIFICATION.md](../VERIFICATION.md). No real user keys were read and no paid API calls were made. Real account access, Claude Code UI integration and complete clean-machine installation are not established. Service terms still apply; this implementation does not imply Anthropic endorsement.

The subscription intermediation path identified in the 0.5.1 assessment has been removed from the released implementation. The independent LSP copyright-notice issue remains subject to the public-release gate; see [third-party scope](../THIRD_PARTY.en.md).
