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
