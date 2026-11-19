# Install and maintain the portable Pi gateway

[简体中文](pi-portable-installation.md)

## Install and preview

Prepare Windows 11 x64, Git, WSL2, hardware virtualization, and network access. The installer prepares pinned PowerShell and Node versions and a dedicated YHWH Ubuntu environment. Choose workspaces the current user is authorized to access. First-time WSL setup may require administrator approval and a restart. If the installer returns `3010`, restart and run it again.

Download `YHWH-OneClick-*.zip` or the matching standalone installer from the [release page](https://github.com/Yuzu482/YHWH/releases/latest). Verify the download against its published SHA-256. Extract the ZIP and run `Install-YHWH.cmd`. The examples use 0.15.3. Match the filename to the version you download.

```powershell
Get-FileHash .\YHWH-OneClick-0.15.3.zip -Algorithm SHA256
powershell.exe -NoProfile -File .\Install-YHWH-0.15.3.ps1 -PlanOnly
powershell.exe -NoProfile -File .\Install-YHWH-0.15.3.ps1
```

| Need | Option |
| --- | --- |
| Install unattended with fixed workspaces | `-NonInteractive -WorkspaceRoots D:\Projects\MyProject`. Prepare WSL first and sign in separately for the selected route. |
| Verify and extract the embedded files | `-ExtractOnly -Destination D:\YHWH-Inspect`. Use a new absolute path. This step verifies the embedded contents. |
| Use a clean local Git checkout | `-SourceRepository D:\path\to\checkout`. The installer checks the pushed commit and its main-branch provenance against that checkout's `origin`. |
| Select host integrations | `-Hosts "codex,claude-code,opencode"`. The default exports generic MCP configuration. Include `codex` to use the installer's Codex integration. |

Installation verifies source provenance, embedded files, and pinned download hashes. Existing plugins, dependencies, or governance files that differ from the release may stop setup. Complete active work and confirm the relevant runtime has exited before using `-UpgradeExisting` for the verified scope. A partial install retains diagnostics and backups. See [upgrades and change impact](workflow-operations.md#english).

## Connect a host and model route

Import the generated MCP configuration into the target host and load `PRIMARY-AGENT.md`. The 0.15.3 Codex integration manages the `PI-KETHER` block. It writes `[features].multi_agent = false` when creating a new configuration and stops if it would have to change existing settings. The native kit uses the subagent capabilities available on your current host. [Multi-host integration](host-integration.en.md) · [Native Codex workflow](native-codex-workflow.en.md)

- For Pi workers, open Pi with `%LOCALAPPDATA%\YHWH\Open-Pi.cmd` and sign in to the selected account with `/login`.
- The default Claude Code CLI review route uses the user's official CLI login. An authorized `probe_model` verifies model connectivity on this route.
- To use the Anthropic API review route, configure your key with `Configure-Claude-API.cmd`. `check_claude_auth` checks the API configuration. Verify model access with an authorized probe. Route selection and tool scope follow the gateway's current capabilities. [Provider configuration](provider-configuration.en.md) · [Pi roles](pi-role-presets.en.md)

## Configure from source

Source installation requires PowerShell 7 and Node.js 22 or later on Windows. For WSL sandboxing, prepare a dedicated Ubuntu 24.04 distribution and authorize the installer to harden it. Run `Init` in the source checkout, set `workspaceRoots` in `install.config.json` to existing authorized directories, then run `Plan`. Use the corresponding actions to install, verify, and build.

```powershell
pwsh -NoProfile -File .\Workflow.ps1 -Action Init
pwsh -NoProfile -File .\Workflow.ps1 -Action Plan
pwsh -NoProfile -File .\Workflow.ps1 -Action Install
pwsh -NoProfile -File .\Workflow.ps1 -Action Verify
pwsh -NoProfile -File .\Workflow.ps1 -Action Build
```

You can also run `.\Install.cmd -ConfigFile .\install.config.json`. This entry supports `-PlanOnly` for a read-only preview and `-SkipWsl` to skip WSL setup. For a Tunnel, provide the settings for an existing connection as shown below.

## Secure MCP Tunnel

Prepare an active Tunnel and a runtime key file protected for the current user. Configuration refers to the file path, and the key stays on the host.

```json
{
  "installTunnel": true,
  "tunnelId": "YOUR_TUNNEL_ID",
  "tunnelRuntimeKeyFile": "C:\\Path\\To\\runtime-key.txt",
  "tunnelClientPath": "C:\\Path\\To\\tunnel-client.exe"
}
```

The Tunnel connects to the authenticated local `127.0.0.1:17331/mcp` endpoint. Remote sessions also require the relevant workspace permissions. Confirm active tasks and related processes have ended before replacing an older transport. [Remote connection details](host-integration.en.md)

## Verify, build, and remove

```powershell
pwsh .\install\Test-PiKether.ps1 -Installed
pwsh .\install\Uninstall-PiKether.ps1
```

The installed check verifies files, components, and selected configuration. Verify model routing, remote connectivity, and the target user environment separately. Uninstalling archives managed files and preserves the WSL distribution and `/opt/pi-kether`.

Maintain releases by running `pwsh -NoProfile -File .\Build-Release.ps1 -PublicRelease` from a clean, pushed source checkout on `origin/main`. A public build requires the runtime and memory regressions. Use `install/Test-OneClick.ps1` to verify the generated installer. See the [pinned manifest](../portable.manifest.json). [Verification](../VERIFICATION.md) · [Security boundaries](../SECURITY-HARDENING.md) · [LSP component](lsp-component.en.md)
