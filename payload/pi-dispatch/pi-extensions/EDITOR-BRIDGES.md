# Pi Unity and Blender extensions

Two independently configured host Pi packages. Each registers `pi_<editor>_status`, `pi_<editor>_tools`, `pi_<editor>_call` and a `/pi-<editor>` status command. Packages share the internal `editor-common` MCP client and the Pi gateway's existing SDK/ledger dependencies; install them within the pi-dispatch layout, not as isolated copied index files.

## Configuration

Default files are `~/.pi/agent/editors/unity.json` and `blender.json`. Override independently using `PI_UNITY_CONFIG` or `PI_BLENDER_CONFIG` (absolute paths). A missing or disabled configuration reports that state; extension loading never starts an editor or connects automatically. `tools` is an exact operation-to-access map, `enabled` toggles a connector, and `allowWrites` enables configured mutation operations. Endpoints/executables cannot be overridden by a tool call.

Use `scripts/Install-PiEditorExtensions.ps1` with absolute `UnityProject`, `UnityRelay`, `BlenderScripts`, and `BlenderAssetRoot` paths. `-EnableWrites` enables edits in newly created configurations; existing configurations are preserved. The default Blender port is 17431. Credentials are generated on the host and never included in the package. After installing, reload Pi (`/reload`) or start a new Pi session.

## Unity

Reuses the existing native Unity MCP Relay over hidden stdio. No second Unity package is installed. `transport.cwd` and `--project-path` should name the same project; every generated scene/asset command additionally checks the running Editor's project path.

Operations: `unity_scene_info`, `unity_get_logs`, `unity_create_object`, `unity_set_transform`, `unity_delete_object`, `unity_create_material`, `unity_save_prefab`. Use `pi_unity_tools` for exact schemas. IDs are **decimal strings**, preserving Unity 6000.5's 64-bit EntityId precision. IDs are session-local; query again after Editor restarts. Only active-scene objects can be modified. Play Mode and compilation block mutations. Materials and Prefabs are new files under `assetRoot` (default `Assets/PiGenerated`); simple filenames only, no overwrite, and reparse-point ancestors are rejected. Transform rotation is in degrees.

The adapter generates fixed C# templates internally. It does not expose raw `Unity_RunCommand`, arbitrary C#, asset-generation APIs, project/package management or shell execution. Unity's dynamic compiler does not necessarily provide Unity version preprocessor symbols, so object ID compatibility is resolved by fixed reflection calls.

Example `pi_unity_call`: `{"tool":"unity_create_object","args":{"name":"PiCube","primitive":"Cube"},"requestId":"scene-cube-001"}`. Only use this when the user has requested that scene edit.

## Blender

The included `blender/addon/pi_blender_bridge.py` addon is installed in the supplied Blender scripts/addons directory. Enable **Pi Blender Bridge** in Preferences > Add-ons, then **Edit > Start Pi Blender Bridge** (also available through F3). Stop with **Edit > Stop Pi Blender Bridge**. After an addon update, disable and re-enable this addon in Preferences to load its updated menu without closing the current scene. Loading another .blend stops the bridge; start it again for the new scene. The addon does not auto-start on load.

Its separate `~/.pi/agent/editors/blender-server.json` contains `version:1`, `port`, absolute `tokenFile`, absolute existing `assetRoot`, and `allowWrites`. Override the path using `PI_BLENDER_SERVER_CONFIG` before starting Blender. Client and server must use the same port/token and both must allow writes.

Operations: `blender_scene_info`, `blender_create_object`, `blender_set_transform`, `blender_delete_object`, `blender_set_material`, `blender_save_copy`, `blender_export_glb`. No Python evaluation. Transform rotation is in degrees; work in Object Mode. Saving produces a new `.blend` **copy**, not an overwrite of the currently open file. GLB export writes one new file. Paths are resolved under the server's configured asset root, including symlink resolution. Scene changes are real editor changes; save important work before requesting edits.

The daemon binds only 127.0.0.1, authenticates every POST, rejects Origin-bearing browser requests, limits request size/connections/queue, and dispatches all bpy operations on the main thread. A queued expired operation is skipped; a running operation may finish after the caller times out.

## Results and governance boundary

`status:connected` proves MCP initialization and tool discovery only. A successful `*_scene_info` proves an Editor round trip. Inspect outer `ok` AND the returned tool content for semantic failures. Errors never authorize a new request ID.

Every write requires a stable `requestId`. A per-editor persistent ledger returns the same completed result on replay and rejects a different payload under that ID. Unknown outcomes block automatic re-execution. Records live under `~/.local/state/pi-editors/<editor>/requests`; metadata-only audit lives beside it and rotates at 1 MiB. Ledger retention follows the gateway's existing policy. Reconcile the actual scene after timeout/disconnect; never retry an uncertain write with a new ID.

These packages remain **host Pi tools** and are not loaded into WSL workers. Tifereth can now explicitly attach `editorAuthorization` to a Gateway task; a separate controlled `pi_editor_execute` proxy executes only the host-approved operations. Ordinary tasks still exclude editors. See [authorization, audit and uncertainty handling](../EDITOR-AUTHORIZATION.md). Editor changes do not receive WSL file-snapshot rollback guarantees.

## Validation

`node --test tests/editor-bridges.test.mjs` covers configuration boundaries, schemas, MCP stdio, stable write replay/conflicts, cancellation, timeout and oversized output. `PI_BLENDER_EXE=<native path> node tests/blender-bridge.live.mjs` runs an isolated background factory scene and verifies real creation, transform, material, save-copy, GLB export, delete and path/overwrite rejection; it does not attach to the user's open scene.

Blender main-thread design follows the [Blender application-timer documentation](https://docs.blender.org/api/3.3/bpy.app.timers.html); GLB export follows the [Blender export API](https://docs.blender.org/api/main/bpy.ops.export_scene.html).
