# Pi desktop monitor

[![简体中文](.readme-assets/zh.svg)](README.md) [![English](.readme-assets/en.svg)](README.en.md)

Windows Pi extension packaged inside Pi Dispatch. Run `/pi-monitor` in Pi to
open an independent, resizable, draggable, initially topmost window. Uncheck
置顶 to disable topmost. Closing Pi or changing Codex conversations does not own
this window's lifetime. Closing the window stops only its dedicated read-only
feed process. A per-user/session mutex prevents duplicate windows per Gateway.

Install this directory as a local Pi package. It remains under Pi Dispatch so
its feed can reuse the installed MCP SDK and loopback credential reader.
The host Gateway must already be running. Configuration comes from
`PI_GATEWAY_CONFIG`, otherwise `~/.local/state/pi-kether/gateway-silent.json`.
The extension runs only on the Windows host, not inside WSL subagent sandboxes.

The reader invokes only `list_subagents`, displays at most 50 sanitized status
records, and never dispatches models or exposes credentials to the UI.
Refresh is two seconds; connection errors back off to fifteen seconds.
No unauthenticated endpoint, auto-start hook, permission change or telemetry is
added. The UI process starts without a console; only the requested window appears.

Standalone launch (also usable from the host agent):
`node <installed-pi-dispatch>/pi-extensions/desktop-monitor/launcher.mjs`

## Display controls

The light dashboard shows connection health, running/queued counts and Gateway
RSS. Tasks use status-colored cards with readable durations and hover text for
long IDs/models. The active-only filter hides terminal tasks. Compact mode
collapses the task list to a 260-pixel-high overview; expanding restores height.
During reconnects, the last update time and stale-data notice remain visible.
The layout lives in window.xaml and must be shipped beside window.ps1.

## Independent mini pet

Run `/pi-pet` for the 320 x 100 mini companion. `/pi-monitor` still opens the full
panel. Both share one window, one Gateway feed and one singleton mutex. If a
window is already open, use its controls to change mode; commands never create
a duplicate. Reload an existing Pi session after installing this update.

The original vector face and rounded capsule take inspiration from compact
floating controls. This is a Pi companion, not an extension of ChatGPT's native
pet. No image generation, copied app assets, model calls or new credentials are
needed. The pet renders counts and sanitized status only.

- Click the face or status to expand. Click 宠物 or press Escape to collapse.
- Drag the dotted grip to move; positioning stays within the virtual desktop.
- The three-dot/right-click menu offers expand, topmost, animation and exit.
- Running and queued work softly pulses; idle/error stays still. Animation can
  be disabled and respects the Windows client-area animation setting.
- Running counts take priority. Historical failures are explicitly labeled
  近期有失败 / 近期失败; they do not imply an active task is still failing.
- Disconnection shows a question mark, never a false zero or successful state.
- Exit closes the monitor and its feed only. Existing Pi tasks continue.

Ship `pet.ps1` and `window.xaml` with `window.ps1`. Windows PowerShell scripts
are UTF-8 with BOM; the child status stream is explicitly decoded as UTF-8.
Standalone pet command: `node <installed-pi-dispatch>/pi-extensions/desktop-monitor/launcher.mjs --pet`.
The mini companion uses an iOS-inspired light floating surface, soft shadow,
rounded blue avatar, high-contrast state badges and a matching light menu.
This is a WPF appearance treatment, not native iOS material or backdrop blur.

Both pet and expanded panel now use the shared FloatingSurface, avatar fill,
button styles and state brushes in window.xaml. Get-StateTheme is the single
state-color mapping used by pet indicators and task cards. Compact panel height
is 260 pixels to preserve footer space around the shared floating surface.

## Window transitions

Pet, full-panel and compact-panel switches use a 70 ms fade-out followed by
200 ms visual scaling (97.5% to 100%) and a 220 ms fade-in with cubic ease-out.
Window layout changes once while hidden; no per-frame native window resizing.
Rapid requests coalesce to the latest pending state. Dragging or disabling
animation settles the current transition immediately. Closing the window clears
animation clocks and pending work. The existing animation menu and Windows
client-area animation setting control transitions as well as the pet pulse.
Startup and reduced-motion mode switch immediately. Durations are configured
animation times, not a guarantee of frame rate on every host.

Ship transitions.ps1 with the other UI files. Windows UI regression check:
`powershell.exe -NoProfile -STA -File <pi-dispatch>/tests/desktop-monitor-transitions.ps1`.
The check opens a temporary verification window and uses no model or Gateway.

## Optional Electron page

Alongside the existing WPF app, the repository includes an optional Electron YHWH Pi Gateway monitor and configuration page. Electron is a comparatively large runtime dependency; the existing `/pi-monitor` and `/pi-pet` WPF commands are unchanged and remain the default. Electron has no Pi slash command yet; launch the development version manually:

```powershell
cd payload/pi-dispatch/pi-extensions/desktop-monitor/electron
npm ci
npm start
```

### Windows portable build

On Windows x64, run these commands from the repository root to build the portable version:

```powershell
cd payload/pi-dispatch/pi-extensions/desktop-monitor/electron
npm ci
npm run package:win
```

Output is in the repository-root `release/desktop-console/`; launch `YHWH-Pi-Gateway.exe`. This is a portable folder, not a single-file executable: keep the EXE together with the DLLs and `resources` directory beside it. The local Pi Gateway must be running, and the default `~/.local/state/pi-kether/gateway-silent.json` or `PI_GATEWAY_CONFIG` must point to a valid local configuration. Packaging does not deploy to Pi, auto-start Gateway, or include credentials. A Windows build, packaged feed import, and a hidden process remaining responsive for 10 seconds were confirmed; in a one-shot test, the packaged feed authenticated to the current Gateway (Connected=True, Active=0, Queued=0, TaskCount=6), but the Electron window's rendered status and interactive configuration controls remain visually unverified.

The monitor uses Electron `utilityProcess` to run the existing `feed.mjs`, connect to the local Gateway, and display sanitized, read-only task snapshots. Configuration is read from the fixed path determined at startup by `PI_GATEWAY_CONFIG`, falling back to `~/.local/state/pi-kether/gateway-silent.json`. The configuration page allows explicit saving of only three numeric fields: `maxConcurrency` (1–4), `maxQueue` (1–64), and `maxRequestBytes` (1024–1048576), with defaults of 4, 16, and 102400. Saving uses an optimistic revision conflict guard, preserves unknown keys, and writes atomically via a temporary file and rename. The renderer is not given tokens, the configuration path, or raw JSON.

Saving changes the on-disk configuration only; the Gateway must be restarted for changes to take effect. The page does not restart it. The page provides no arbitrary configuration editor, task writes, or task cancellation. Credentials remain host-side; do not expose them in documentation, command lines, or screenshots.

The YHWH page shows Gateway connection status, running and queued task counts, and Gateway RSS. The task list supports search by task/route/ID, filtering by running or queued state, and an active-only view. Selecting a task shows its role, state, request ID, route, and elapsed time. Offline, metrics use placeholders and tasks are not shown; with no tasks, an empty state appears, and filters with no matches are reported separately.

Verification scope: host `node --check` checks passed for `config-store.mjs`, `main.mjs`, `preload.cjs`, and `renderer.js`; the `desktop-monitor.test.mjs` and `gateway-console-config.test.mjs` suites passed, 9 tests total. The current configuration UI's visual content and click actions remain unverified; liveness results from the earlier monitor-only version do not verify the current configuration UI. This does not claim deployment to a local Pi, a published release, or complete visual QA.
