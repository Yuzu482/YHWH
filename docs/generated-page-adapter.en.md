# OpenDesign / Generated-page adaptation

[简体中文](generated-page-adapter.md) | [English](generated-page-adapter.en.md)

This guide is for inspecting or changing generated page source. It does not grant access to a browser, developer tools, or a local service.

## Reading large single-line HTML

When the task makes it available, a worker can use the controlled `yhwh_source_window` tool to read a bounded source window from a UTF-8 regular file under its working directory. Paths must be relative; symlinks and paths escaping the working directory are rejected. Select a position with an exact `query` (optionally selecting its 1-based `occurrence`) or a zero-based `offset`; the two modes cannot be combined. Offsets, returned boundaries, and lengths use UTF-16 code units. Each call returns at most 8,000 UTF-16 units (4,000 by default); the file limit is 8 MiB. The result includes the SHA-256 of the complete file bytes, total UTF-16 length, window boundaries, and truncation flags. The hash identifies the complete source file; it does not establish a runtime page result.

The tool is available only in controlled WSL2 worker execution, and file access remains constrained by task `readScope`, the sandbox, and the access level. `read` is not write permission; writing also requires authorized `workspace-write` and task `writeScope`. Do not infer or bypass scope restrictions using this window tool.

## Stage task packets and acceptance

- Bound worker tasks to delivery within a specified source scope and request verifiable static evidence; state paths, expected artifacts, and acceptance criteria.
- Browser interaction, rendering, responsive layout, or local-service acceptance belongs in a later stage with the corresponding authorization and capabilities. Do not imply that a source worker ran those checks.
- If browser acceptance is required acceptance for the current stage, the task cannot be marked complete without browser evidence. Report it as unverified/blocked and identify the missing evidence.
- Real tool errors cause gateway rejection. A final claim of success cannot override or erase them.

Browser capability is never authorized automatically. Browser acceptance requires the host to explicitly provide the relevant tools, permission, and acceptance stage.

## Post-install self-check and local service

After installation, `install/Test-PiKether.ps1` can use `-Installed` to check plugin dependencies, the Pi entry, workflow directory, selected host profiles, and MCP workspace configuration. By default it also checks WSL role-presets and source-window extensions, extension syntax, sandbox/resource limits, and LSP components. `-SkipWsl` skips WSL checks. The script checks installed files and components; it does not launch a page or prove browser acceptance. Credential-file presence likewise does not establish valid model access.

Source-tree implementation is distinct from an installed or running local service. Editing source does not update an installed plugin or WSL service automatically; deploy through the installation process and then self-check the actual target. Do not present a passing self-check, protocol connectivity, or static source evidence as proof that a page passed browser acceptance.
