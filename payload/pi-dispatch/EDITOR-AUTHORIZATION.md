# Tifereth-authorized editor access

Windows keeps the Blender token and Unity relay. WSL workers get a per-task stdin/stdout and Node IPC proxy, not the host extensions, credentials, host mounts or a new network listener. Ordinary tasks are unchanged. This is an instruction-governed Tifereth action authenticated by the existing Gateway MCP credential; it is not a separate identity provider.

`submit_subagent` and `dispatch_subagent` accept an optional top-level `editorAuthorization`. The Gateway capabilities advertise `editors`. A task needs stable `requestId`, `parentRunId`, a persistent parent ledger and the pinned openai-codex route. Canonical Chesed can read/write; Malkuth and Netzach can read. Other roles, including Geburah, cannot receive editor grants. `access` still controls filesystem tools; `access: none` plus a grant exposes only `pi_editor_execute`.

Example additional field (set a fresh UTC expiry no more than 15 minutes ahead):

```json
{
  "editorAuthorization": {
    "version": 1,
    "expiresAt": "<UTC ISO timestamp>",
    "operations": [
      {"id":"inspect-scene","editor":"blender","tool":"blender_scene_info","args":{}}
    ]
  }
}
```

The host adds `EDITOR_AUTHORIZATION_JSON` to the compiled prompt. The worker calls `pi_editor_execute({operationId:"inspect-scene"})`. It cannot choose arguments, tools, endpoints, profiles or new permissions. At most 16 fixed operations, 32 frames and the resource-profile output budget are admitted; each operation executes once per task and repetitions return its stored result. Per-operation output is limited to 256 KiB. Parallel model calls are serialized through a bounded queue; agent_end disconnects IPC so it cannot keep the worker alive. Expiry, cancellation, EOF and task completion revoke the channel. No automatic fallback or retry occurs. Prefer standard resources for multi-editor reasoning tasks; keep the task's existing role/model binding.

Writes additionally require `scene: {name, path}` on each operation. Blender path is `blender_scene_info.file`; Unity path is its active-scene asset path. The check happens inside the editor's mutation operation. Empty path explicitly targets a named unsaved scene. Use the latest Blender addon; older addons reject `_piScene` writes. Reloading the addon needs a user-side disable/re-enable and restart of its bridge. This does not affect the current version's read-only query.

Writes have stable derived operation request IDs and a durable host write fence per editor at `~/.local/state/pi-editors/<editor>/gateway-write-fence.json`. Successful writes clear it. Uncertain/failed dispatched writes and host crashes retain it and block subsequent Gateway writes, even with a different request ID. Read-only inspection remains available. Reconcile the actual scene, operation ledger and audit before an administrator removes that exact fence. Never clear it just to retry. Existing interactive host Pi sessions and human UI actions are outside the Gateway fence, so do not run them concurrently with governed writes.

Grant/configuration changes fail closed. The audit stores request/run IDs, operation ID, editor/tool, outcome and duration, not raw arguments or editor credentials. Parent task replay never dispatches another model or edit. IPC messages carry only operation IDs and sanitized results. Credentials continue to enter only the existing trusted model bootstrap, separately from the editor channel.

Editor effects occur on Windows and have no WSL snapshot rollback. Authorization applies to the named active scene in the configured editor/project; it is not a claim that another open instance is selected. A failed or cancelled task may already have made a permitted edit. Verify `editorExecution.operations`, the returned tool results and the real scene before accepting the task.

Verification: `node --test tests/editor-authorization.test.mjs tests/editor-bridges.test.mjs tests/gateway.test.mjs tests/wsl-sandbox.test.mjs`. Real WSL/editor evidence is recorded separately from mocks and isolated tests.
