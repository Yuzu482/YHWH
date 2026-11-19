---
name: agent-presets
description: Compose and dispatch Codex native subagent presets from reusable traits. Use when selecting or changing a preset for an authorized native delegation.
---

# Agent presets

Use [templates.toml](templates.toml) as the source of truth for preset membership and trait order. Choose a preset by its description and read only its selected traits. The same trait names as Pi describe responsibilities for native agents. Pi dispatch uses the existing gateway contract.

## Trait library

- `Yesod` defines the task, `Binah` clarifies requirements, and `Hod` assesses risk from supplied material.
- `Malkuth` gathers evidence and `Chochmah` plans the work with assigned read-only access.
- `Chesed` implements within the assigned write scope, `Netzach` verifies outcomes, and `Geburah` independently reviews supplied evidence.

Use the names in `templates.toml` and load the corresponding files under `traits/`. `Chochmah` and `Netzach` may use read-only tools when the assignment calls for them. The template's stages inherit the existing host authorization.

Run `python scripts/compose.py <preset> --instructions` from this skill directory when the current host takes a task message. The renderer loads the selected template's trait files and prints its instructions without modifying files. When the host supports named roles, use `python scripts/compose.py <preset> --check "<path to the registered TOML>"` to confirm the preset matches the template. With a matching registration, select the name. Otherwise include the rendered instructions in the assignment. When updating the authorized global registration, render the full TOML with `python scripts/compose.py <preset>`.

For each assignment give the preset, objective, permitted tool calls and operations, read and write scope, acceptance evidence, and any writer handoff. Use supplied evidence directly when no tools are needed. This template organizes the work. Actual sandbox, approvals, providers, and MCP access come from the parent and verified host controls. Treat prompt tool limits as a collaboration rule whenever the host lacks a corresponding technical restriction.

Keep an independent reviewer separate from the writer of the artifact. Assign a single writer to each overlapping scope and complete the existing handoff before another writer starts.
