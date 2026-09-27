---
name: hindsight-coding-agent
description: How this machine's Hindsight coding-agent memory works. Use for deliberate memory capture, knowledge retrieval or correction, per-repo configuration, and Hindsight troubleshooting.
---

# Hindsight coding-agent memory

Hindsight automatically maintains a repository memory bank. Read only the reference matching the user's question; these files describe the installed third-party plugin and do not grant new write, account, or installation authority. Verify current plugin behavior before claiming runtime results.

| Need | Read |
| --- | --- |
| Automatic memory, deliberate capture, search, or correcting stale knowledge | [Overview](references/overview.md) |
| Installing/updating Hindsight or daemon settings | [Installation](references/installation.md) |
| General configuration and when changes take effect | [Configuration basics](references/configuration-basics.md) |
| Opt-in behavior | [Opt-in configuration](references/configuration-opt-in.md) |
| Full settings reference and per-repo overrides | [Configuration reference](references/configuration-reference.md) |
| Bank selection, provenance, and per-repo belief behavior | [Bank resolution](references/bank-resolution.md) |
| Logs, readiness, reset, or missing memory | [Diagnostics](references/diagnostics.md) |

This YHWH progressive-disclosure wrapper is generated from the installed third-party skill by `install/Apply-HindsightWrapper.ps1`. The unmodified original is kept in a local backup. Reapply the script after updating or reinstalling Hindsight.
