# Pi desktop monitor

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