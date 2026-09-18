# Publication verification

Verified on Windows on 2026-09-18 before the initial private GitHub publication.

- Clean dependency installation with lifecycle scripts disabled succeeded.
- Gateway automated suite: 181 passed, 0 failed, 0 skipped (`node --test --test-concurrency=1 tests/*.test.mjs`).
- Portable manifest, plugin metadata, policy reference targets and distribution-content checks passed.
- Installer configuration validation and no-write planning passed.
- The actual installer reference-copy block was exercised against an isolated temporary home: all nine references matched, the previous rule was backed up, and an unrelated reference was preserved.
- Source preparation excluded credentials, live configuration, runtime state, diagnostics, backups, dependency directories and Python caches. Credential-pattern findings were limited to synthetic redaction-test fixtures.
- The installed lifecycle gateway previously passed health/readiness and Luna/max and Sonnet/max no-tool heartbeats, including cleanup. These checks cover that host and those routes at that time.

This publication was checked by the primary agent locally. A fresh machine installation, a complete write-task governance chain, and the separately installed image workflow plugin were not validated by these packaging checks. Model access and authentication must be configured on the destination host.

The canonical distributable source in this repository is `payload/pi-dispatch`. Local machine source trees and an installed runtime are not automatically synchronized with it.

## One-click package 0.3.0

The primary agent performed local pre-change and post-change review; no independent model reviewer is claimed for this installer change.

- Windows PowerShell 5.1 executes the bootstrap and its test harness without requiring PowerShell 7 first.
- The harness exercises real ZIP extraction (including hidden-name plugin metadata and paths containing spaces), payload checksum rejection, traversal/duplicate/reserved-name rejection before destination creation, and no-write planning.
- Mocked process and WSL boundaries check existing-install protection, active-runtime rejection and distro ownership refusal/reuse. These are safety-branch tests, not real WSL installation evidence.
- Codex configuration checks cover new and existing `[features]` tables, preservation of unrelated tables, legacy root spelling, idempotence and explicit refusal of inline features before mutation.
- Release construction checks the generated self-contained installer, required policy/package files and exclusion of dependency trees and local state. Both README languages and their local navigation assets are distributed.
- The gateway suite passed 181/181 using the established `--test-concurrency=1` release baseline. An initial parallel run failed two HTTP-client fetch tests (179/181); it is not counted as a pass. Gateway implementation code was unchanged by this installer work.
- Both host and WSL Pi now consume the supplied lockfile. WSL provisioning sets its own Node/LSP PATH, creates `/usr/local/libexec` when absent, and verifies each LSP command separately. The Windows MCP configuration explicitly names the newly installed Pi entry point.
- PowerShell, Windows Node and the Ubuntu rootfs URLs and SHA256 values are pinned in `install/bootstrap-dependencies.json`, with publisher metadata links. Runtime download hashes are enforced during installation; a full runtime download/install was not performed during package validation.

Not performed: installation on a clean Windows VM, WSL enablement/reboot/import, UAC interaction, full dependency provisioning in the new distro, interactive OpenAI/Claude login, model heartbeat, or ChatGPT Tunnel setup. The current host's live Pi installation and WSL configuration were not replaced by these checks. Existing live-host heartbeats above do not validate this new installer.

## Multiple primary hosts 0.4.0

Verified locally on 2026-09-18. The primary agent performed local pre-change and post-change review. Automatic approval review rejected sending private design materials to the external Claude reviewer without explicit disclosure authorization, so independent model review was not performed or bypassed.

- The complete serial gateway suite passed 190/190, with no failures or skipped tests. Nine host-integration tests cover all eight profile formats, environment/path restrictions, refusal to overwrite existing exports, the allowlisted policy catalog, real in-memory MCP calls and a real stdio child connection. The HTTP-to-stdio proxy also retrieves the new primary contract.
- The generated Windows PowerShell 5.1 one-click installer passed 52 checks, including extraction of the host contract, catalog, exporter, connection checker and both integration-guide languages. Configuration validation and no-write planning reject invalid host selections. The checked-in catalog matches its canonical policy/skill sources.
- OpenCode 1.18.25 connected to the new gateway using isolated configuration/data/cache/state paths: its actual `mcp list` reported `yhwh connected`. Its `agent list` also reported `yhwh (primary)`. These checks did not call a model or establish prompt compliance.
- The actual Windows-side installer completed in an isolated target home with all seven non-Codex profiles selected, WSL and Tunnel provisioning disabled. Dependencies, host Pi entry, catalog and selected profiles passed installed checks. No `.codex` or `.agents` directory was created in that target home. This is not a clean-machine or fresh-WSL installation test.
- The release build passed plugin validation and distributable-content checks. The scanner now prunes excluded test/dependency/state directories before recursion instead of reading them and filtering afterward.
- Cherry Studio and Claude profiles follow published configuration interfaces. DSH rows follow the local native MCP client and agent-preset persona interfaces. OpenCode v1 and v2 have separate schemas. Generated profiles alone are not evidence of runtime support in every application/version.

Not performed: Cherry Studio, Claude Code/Desktop or DSH end-to-end host activation; OpenCode v2 runtime loading; new-host model heartbeats or a complete write-task governance chain; a clean Windows/WSL installation; or multi-host concurrency/load testing. The current live Pi installation and existing application profiles were not updated. The 0.4.0 source and release artifacts are local and have not been committed or pushed as part of this change.

## Common client profiles 0.5.0

Verified locally on 2026-09-18. Scope: add ten export adapters, primary instruction files, installer selection, bilingual documentation and a release package. Existing settings, running services, model routes and credentials were outside the change scope. The primary performed local pre-change review before edits and post-change review against the tests and documentation; no independent model review or linked Pi stage chain is claimed.

- Added Cursor, VS Code/Copilot, Windsurf Cascade, Cline, Roo Code, Gemini CLI, local Kiro, native Zed Agent, Continue IDE and LM Studio profiles: 18 host IDs including existing adapters. Official interface sources and scope are recorded in adapter metadata and both common-client guides.
- The complete serial gateway suite passed 195/195, with no failures or skipped tests. The expanded host-profile suite passed 14/14. For each of the ten new configuration shapes, the test extracts its actual command/arguments/environment, starts the real gateway through the MCP SDK and checks initialization, tool discovery and primary policy retrieval. This does not exercise the applications' own parsers or UI.
- Tests cover preserved executable argument boundaries and environment, absence of blanket tool approvals, full primary contract in native instruction files, always-on frontmatter where applicable, nested exports, refusal to overwrite existing output, and parity between all three installer host lists and the exporter.
- PowerShell configuration validation and read-only planning accepted all 18 IDs. The generated Windows PowerShell 5.1 installer passed 56 checks, including all ten new selections and inclusion of the new profile module and bilingual guide. Plugin validation, release exclusion checks, changed PowerShell syntax and ten maintained README files' language buttons/local links passed.
- No new-client application profile was written or activated. No model heartbeat, complete write-task governance run, client GUI/rule-loading test, clean Windows/WSL installation or concurrency/load test was performed. The earlier OpenCode evidence belongs to 0.4 and is not proof for the added applications. No commits or pushes were made for this change.
