# Pi Subagent Role Presets

[简体中文](pi-role-presets.md)

YHWH provides fixed Pi presets for eight Kether subagent roles. The gateway validates the role, model, access level, and tool ceiling before explicitly loading the controlled Pi extension and passing the role ID. The extension adds only a concise, actionable card for the selected canonical role to the system prompt; it injects no other role cards and grants no permissions. Dispatch uses `--no-skills` to disable automatic skill discovery and does not read arbitrary project or user `SKILL.md` files. Project or user `.pi/presets.json` files are not used on this dispatch path.

WSL read and workspace-write tasks submit one structured result through the controlled `yhwh_submit_result` tool; the gateway deterministically validates the canonical JSON. No-access tasks, including the reviewer, retain the single-line `KETHER_RESULT_JSON=` final envelope. Role-card instructions alone do not guarantee compliance; malformed results are rejected.

| Role | Function | Permitted file access |
| --- | --- | --- |
| Yesod | Normalize the goal and task constraints | None |
| Binah | Resolve material ambiguity | None |
| Hod | Assess complexity and risk | None |
| Malkuth | Inspect the workspace and record evidence | None or read-only |
| Chochmah | Prepare a bounded execution plan | None or read-only |
| Chesed | Code and modify files within authorization | None, read-only, or scoped write |
| Netzach | Verify read-only evidence and record acceptance | None or read-only |
| Geburah | Review supplied materials | None |

The aliases `worker`, `researcher`, and `reviewer` resolve to Chesed, Malkuth, and Geburah respectively. Kether and Tifereth remain in the primary host; Da'at is not currently a dispatchable Pi preset. Existing model bindings remain: the seven non-review roles use Luna, and Geburah uses Claude Sonnet. Tasks with no access get no file tools; read-only tasks may use bounded reading and LSP tools according to their role. Chesed's read-only and scoped-write presets expose core file tools plus the `yhwh_submit_result` submission tool, leaving deterministic LSP probes to the primary host through `lsp_request`. Only Chesed may write when separately authorized with an explicit `writeScope` and an available OS sandbox.

A preset is a role and tool-selection entry point, not an independent security boundary. The gateway rejects unknown roles, excessive access, and mismatched model routes; launch arguments restrict tools to the role ceiling. Task scopes, the WSL sandbox, and post-run patch validation also constrain file access. Editor bridging is separately authorized and remains controlled by its operation catalog and host validation. Reviewers cannot read the workspace themselves and must receive actual review materials.

The installer places `role-presets.js` in `/opt/pi-kether/extensions/`, and the installed self-test checks for that file. Run `npm test --prefix payload/pi-dispatch` in the repository to verify the role table, per-role-only card injection and size bound, launch arguments, and rejection rules. These static tests do not prove that a local service has been upgraded, that a live model call succeeded, or that a model followed its role card.
