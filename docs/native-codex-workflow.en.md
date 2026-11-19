# Native Codex workflow

[简体中文](native-codex-workflow.md)

Use this kit on a Codex host with native subagents available. The primary can work directly or delegate independent tasks. Use the authorized gateway workflow when a task needs Pi routing, write locks, ledgers, or formal review.

## Set up the kit

1. Check that the current Codex host supports native subagents and has them enabled. Back up the global `AGENTS.md`, review and merge the [rules fragment](../templates/codex-native/AGENTS.fragment.md), and preserve existing project instructions and managed blocks.
2. From the repository source, generate the role you need with Python 3.11 or later. Inspect the output first. If the host supports named roles, save the output as `agents/native_researcher.toml` under the active Codex configuration directory and verify it with `--check`. Check differences before replacing a role with the same name.
3. Use your active Codex configuration directory in place of the example check path. In a new conversation, check that the role is available. On a host that takes a task message, include the output of `--instructions` in the assignment.

```powershell
python templates/codex-native/agent-presets/scripts/compose.py native_researcher
python templates/codex-native/agent-presets/scripts/compose.py native_researcher --instructions
python templates/codex-native/agent-presets/scripts/compose.py native_researcher --check 'C:\Path\To\CodexHome\agents\native_researcher.toml'
```

The [template catalog](../templates/codex-native/agent-presets/templates.toml) defines trait membership and order. The [skill instructions](../templates/codex-native/agent-presets/SKILL.md) explain how to check a role. Enable the native kit from source as needed. Pi portable installation and host settings follow their existing workflows.

## Choose a role

| Role | Use it for | Ordered traits |
| --- | --- | --- |
| `native_researcher` | Read-only research and diagnosis | Malkuth |
| `native_planner` | Defining objectives, scope, risks, and an implementation plan | Yesod → Binah → Hod → Chochmah |
| `native_implementer` | Making and checking changes in an assigned write scope | Malkuth → Chesed → Netzach |
| `native_verifier` | Checking results against acceptance criteria | Netzach |
| `native_reviewer` | Independently reviewing changes and evidence | Geburah |

## Example entries in the main conversation

- **Assignment**. The `native_implementer` may use `apply_patch` to edit `docs/` and run `rg -n --fixed-strings "Setup" docs/` from the repository root to check the heading. The primary owns `tests/`. The read-only `native_verifier` may use only `Get-Content -LiteralPath docs/setup.md` to inspect acceptance evidence and has no writable directories.
- **Handoff**. The implementer hands `docs/` to the primary. Confirm completion and process exit. Record the stop evidence before transferring write ownership. Hold the handoff while the stop status is uncertain.

The assignment's tool list is a collaboration rule. Technical restrictions come from the tool configuration, approvals, and sandbox verified on the host.
