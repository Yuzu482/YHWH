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


## Licensing and Claude Code assessment 0.5.1

Verified locally on 2026-09-18. Scope: Apache-2.0 for original YHWH work, preserved third-party notices, deterministic npm declaration inventory, bilingual documentation, Claude Code feasibility research, and packaging checks. Local pre-change review confirmed authorization and excluded service/authentication changes. Local post-change review checked source scope and the evidence below; no independent model review or linked Pi stage chain is claimed.

- Root and standalone plugin LICENSE/NOTICE, package metadata, lockfile root and portable manifest declare Apache-2.0 for original work. Upstream Pi/provider MIT texts and the Claude Code proprietary notice retain their original contents; source URLs and SHA256 values are recorded.
- The two pinned npm lockfiles provide 366 package-path entries, including optional/transitive dependencies, with zero missing license declarations. This is not a complete license-text, system-component or file-provenance audit. The LSP extension declares MIT but its complete upstream copyright/license notice was not found; that gap is explicitly recorded rather than fabricated.
- The license gate passed its valid isolated fixture and rejected four cases: changed original license bytes, wrong manifest license, stale inventory and changed standalone notices. All 74 checked local links in the updated README pairs, third-party documents and feasibility reports resolved.
- Release construction passed portable exclusion checks, configuration validation, host-workflow synchronization, plugin validation and license checks. The generated Windows PowerShell 5.1 installer passed 72 checks, including byte-identical licensing materials and feasibility documents after extraction.
- Runtime code and dependency versions did not change. The 195/195 gateway and 14/14 host-profile results above remain the earlier 0.5.0 baseline; this documentation/metadata/build change used Build-Release.ps1 -SkipTests and did not rerun those suites.
- Claude Code research compared official published guidance with credential-renewal, preparation, sandbox bootstrap and provider source. Direct primary-client use is technically feasible but was not exercised. The current subscription credential bridge is not approved by this assessment as a public default; an API/cloud adapter or specific upstream authorization remains outstanding.

No real credentials were read, no model calls or live service changes were made, and no clean-machine installation was performed. No commit, push, repository visibility change or GitHub Release was made for this licensing change. Earlier section statements about local/unpushed work describe their validation-time state, not the current GitHub history. License packaging success is not certification that every integration is ready for public distribution.


## API reviewer migration and LSP provenance 0.6.0

Verified locally on 2026-09-19. The user explicitly selected user-owned Anthropic API-key billing for the reviewer. Scope was repository sources, install artifacts, licensing evidence and documentation; the running host service, installed global policies and real credentials were excluded. Local pre-review established the selected route and fixed Pi capability before edits. Local post-review checked the changes and evidence below; independent model review is not claimed. Automatic approval rejected an initial broad edit; it was not executed. Work then proceeded through small reviewed source changes and fixture tests without bypassing the rejection.

- Reviewer route is now native `anthropic / claude-sonnet-5 / max`, with `access:none` and no tools. Subscription credential reading, CLI renewal, the custom Claude extension and CLI/provider installation dependencies were removed. All retained dependency versions are unchanged. The lockfile inventory now contains 356 package-path entries with no missing license declarations.
- API configuration uses a dedicated host file and hidden input. Windows PowerShell 5.1 tests passed invalid/subscription rejection before writes, exact fixture-key persistence, protected current-user-only ACL, key rotation, preservation after invalid replacement and temporary-file cleanup. An initial redundant ACL update requested an unavailable system privilege; the final script preserves the already restricted file ACL and verifies it after rename, and the tests passed.
- API validation rejects OAuth, subscription tokens, command-based keys, mixed credential payloads, mismatched models/providers, duplicate route arguments, tools and command-line API-key injection. Ambient Anthropic/Claude environment overrides are removed. The pinned Pi AuthStorage accepted the fixture API key in memory; its native Sonnet 5 catalog maps max effort. This is offline compatibility evidence, not remote model success.
- Complete serial gateway suite: 192/192 passed from the plugin working directory. Eight obsolete renewal tests were replaced by five API tests (previous baseline 195). An initial renamed-tool ordering assertion was fixed. A subsequent invocation from the repository root failed two working-directory-dependent editor tests; rerunning from the documented plugin directory passed all tests. No failing run is counted as successful.
- Generated Windows PowerShell 5.1 installer: 77 checks passed, including the new setup helper, API modules, LSP provenance/reference materials and byte-preserved licensing files. Configuration validation, workflow catalog checks, plugin validation and portable exclusions passed. Updated documentation had 82 valid local links.
- Python testing created an excluded bytecode cache containing the local source path; the source scanner now prunes bytecode caches consistently with the existing release exclusions. No credential detection pattern was relaxed.
- Both changed Bash files passed syntax checks with the installed Git Bash; an earlier guessed executable path was unavailable and is not counted as a check. The snapshot deny list now rejects the API credential filename including nested mixed-case paths; that platform-independent Python security test passed on Windows. Full Linux snapshot/runtime behavior was not rerun.
- The original pi-lsp-extension 1.3.0 npm tarball passed its published SHA512 integrity check. Evidence records source gitHead, hashes and all 53 archive entries. The original metadata declares MIT but the package and inspected repository history did not supply a full copyright notice. Standard SPDX MIT text is supplied explicitly as reference text without inventing attribution. Local patches write a distinct YHWH modification notice; applying the patch twice to the verified package was idempotent and preserved package metadata.
- `license-inventory.mjs --check --public` rejects the unresolved upstream notice. Public builds require a traceable upstream notice and matching digest; local preview packaging remains available. The upstream request is an unsent draft unless its own document records a submitted issue. No upstream response or permission is presumed.

Not performed: paid API heartbeat, real account/key/quota validation, new WSL provisioning, clean-machine install, live Claude Code UI integration, deployed service update, commit, push or GitHub Release. The API implementation removes the previous subscription bridge; it does not establish service endorsement or certify all third-party rights. Public release remains held for the LSP upstream notice.


## 0.7.0 controlled API transports — 2026-09-19

Scope: optional host-owned OpenCode Go, CommandCode, OpenRouter and custom HTTPS transports. Defaults stay openai-codex/Luna/max and Anthropic/Sonnet 5/max. No live service, global policy, real credentials, Git commit/push or external issue was changed by this phase.

Governance: primary-local scope compilation, classification, source scouting, plan and pre-review preceded mutations. Material clarification was not needed: the user authorized a controlled layer and the two named platforms. One local writer implemented and verified the change. Local post-review checked role preservation, endpoint/auth separation, config digest handling, FD3 bootstrap, release contents and documentation. No independent model reviewer was used; this is not an independent-review attestation.

Observed checks:
- Full gateway suite: **200/200 passed**, serial execution from payload/pi-dispatch. Includes 8 new controlled-provider cases. Evidence: local `.test/provider-gateway-tests.log` (excluded from release).
- Pinned Pi 0.84.4 SDK registered both providers and emitted the expected Responses and Messages requests into a mocked fetch: exact endpoint, Bearer fixture credential, model and `max`. **Zero external/model calls**. Reproduce with `node install/Test-ProviderSdk.mjs <pinned-pi-node_modules>`.
- Windows PowerShell 5.1 provider setup passed: hidden-input helper parsing, opaque fixture keys, separate references, current-user-only ACL, rotation retaining unrelated keys, invalid replacement retaining prior config/key, temporary-file cleanup.
- Explicit secret/traversal snapshot test passed, including provider-config.json and provider-credentials.json with nested uppercase variants. Full Linux snapshot/WSL integration was not rerun.
- Bash syntax passed for the sandbox and provisioning script. 58 local README/provider-guide links passed. Git diff whitespace check passed (line-ending normalization warnings only).
- Existing license inventory check passed with 356 lock entries and no missing metadata declarations. The separate upstream pi-lsp notice gap still blocks the public-release gate.

A full-suite first pass found one outdated assertion expecting OPENCODE_API_KEY inheritance. It now expects removal, matching host-selected FD3 credentials; the full rerun passed. An initial new child-process test had a newline escaping error in fixture code; corrected and rerun. No permission/capability check was weakened to pass.

The release builder runs provider setup tests and one-click extraction checks for the new configuration helpers, adapter and bilingual guide. Config and credential state files are excluded from snapshots/Git/release trees. API pricing is explicitly unknown, not the SDK placeholder zero. Config templates intentionally require operator confirmation of max capability before activation.

Unverified: real platform account/plan/model/max access, paid heartbeats, live tool calls, clean-machine installation, updated WSL execution, and running-service migration. CommandCode's example Sonnet 5 needs account catalog confirmation. Public docs establish endpoint shapes only. No automatic platform fallback, model substitution, lower-thinking fallback, custom headers, client impersonation or editor authorization was added.


## 0.8.0 API encryption — 2026-09-19

Authorized scope: add encryption for YHWH-managed API keys. Primary-local scouting, design/pre-review, implementation, verification and post-review; no independent model review. Real credentials, installed service/global policy, Git commits/pushes and public release were untouched. Existing OpenAI OAuth storage is outside this API-key change.

Implemented Windows DPAPI CurrentUser with slot-specific entropy; encrypted-only temporary and final files; restricted current-user ACL; atomic file replacement with no plaintext backup; explicit idempotent legacy migration. Runtime decrypts in the Windows helper and transfers selected credentials through private stdin framing and a kernel FD3 pipe. The WSL API branch no longer reads or creates API credential files. Legacy plaintext, mismatched config, corrupt ciphertext and failed decryption fail closed.

Observed verification:
- **202/202** serial gateway tests passed. Local evidence: `.test/encryption-gateway-tests.log` (not distributed).
- Real Windows PowerShell 5.1 DPAPI tests passed for roundtrip, tamper/slot-substitution rejection, migration, repeated migration, rejected replacement preservation, current-user ACL, rotation preserving other keys and temporary/backup cleanup. All keys were synthetic fixtures.
- Worker API test covers actual Windows DPAPI helper -> validated root pipe packet -> bootstrap credentials. Anthropic preflight covers explicit plaintext rejection followed by encrypted migration and successful local decryption. No remote model call occurred.
- Real WSL Ubuntu-24.04 / setpriv / Bubblewrap no-network probe passed: FD3 pipe delivered a fake credential object, stdin preserved the independent prompt, no credential file or service change. Reproduce explicitly with `node install/Test-ApiPipe.mjs <distro>`. This tests pipe isolation, not a paid Pi model execution or complete deployment.
- Bash syntax checks passed for sandbox/provisioner. Full release gate includes the new DPAPI tests and extraction checks for the encryption/migration helpers.

Compatibility fixes during verification: PS5.1 File.Replace requires an actual null string for the no-backup overload; use NullString.Value. Load the built-in Security module from PSHOME to avoid inherited PowerShell 7 module discovery. Source-loaded setup tests now load the shared module at script entry. The inline WSL fixture required --exec to prevent an extra shell expanding variables; production uses a script file.

Limits: no second-account/machine DPAPI test, live account heartbeat, full clean-machine installation or live upgrade. Runtime must briefly hold plaintext in memory; same-user/administrator/OS compromise is not prevented. Migration does not securely erase historic backups, freed disk blocks or third-party copies. Public release still has the separately documented upstream LSP notice hold.
