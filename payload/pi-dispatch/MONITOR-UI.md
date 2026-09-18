# Pi monitor UI connection

The native Codex plugin must initialize successfully before its render tool can
provide an inline MCP App. A JSON response from the remote Tunnel connector alone
is not evidence that an inline card appeared.

Installed Windows MCP configurations must use an absolute script path in `args`.
On the observed Codex build, `${PLUGIN_ROOT}` was passed literally to Node,
causing `MODULE_NOT_FOUND` before the initialize response. The portable installer
already resolves this path using the selected installation directory; do not
copy the portable template directly into an active installation. The live
verifier now passes the configured arguments unchanged and rejects unresolved
`${PLUGIN_ROOT}` instead of silently expanding it.

For an installation with a running HTTP Gateway, set `PI_GATEWAY_CONFIG` on the
native plugin MCP server to the absolute path of that Gateway's configuration.
`stdio-server.mjs` then uses `stdio-proxy.mjs`: tools, metadata and UI resources
are forwarded to the existing authenticated loopback Gateway. It creates no
second scheduler or task monitor. The token is read locally from the configured
file, never embedded in plugin configuration or UI HTML. Closing the bridge
closes only its own connection. It does not stop Gateway tasks.

Without `PI_GATEWAY_CONFIG`, the original standalone stdio runtime still requires
the full roots/audit/circuit/ledger/sandbox configuration. A native standalone
monitor and a separate HTTP Gateway do not share in-memory task status. The
portable installer selects shared mode when installing the Tunnel runtime.

After changing MCP startup configuration, reload the Pi plugin or restart Codex
so its native MCP tool list is re-established. Use the native plugin's
`render_subagent_monitor` to verify inline display. If the current conversation
only exposes `codex_apps` connector tools, do not claim a native card was shown.
The actual host display must still be checked after reload.

For the observed Codex desktop build, resource metadata includes
`openai/widgetShowCodexWidgetInline: true` and a minimum frame height. Otherwise
the host treats the view as collapsible. The `text/html;profile=mcp-app` resource
always performs `ui/initialize`, including when the host exposes the legacy
`window.openai.callTool` API. Having that API does not complete MCP Apps
initialization. A `widget_running` log alone only proves sandbox execution,
not that the initialization gate passed or the card was visible.

The card handles both `window.openai` and standard MCP Apps initialization and
tool-result notifications. Polling preserves the requested limit, omits an unset
parentRunId, and exposes MCP error results. UI callback tools advertise app
visibility. Upstream requests and task cancellation retain Gateway controls.

The header offers a floating PiP toggle and a return-to-inline action. The view
advertises inline, pip and fullscreen modes and checks the actual mode returned
by the host. It supports both `window.openai.requestDisplayMode` and the standard
`ui/request-display-mode` request. Rejection or missing confirmation is shown
as an error, not reported as a successful switch. PiP is host-managed; keeping it
across conversations or above other Windows applications requires host support
and is not guaranteed by this plugin. A monitor with no parentRunId reads the
shared Gateway's task list rather than being restricted to its origin thread.

Reference: https://developers.openai.com/plugins/build/chatgpt-ui
