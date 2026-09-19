# Upstream LSP license remediation record

[简体中文](lsp-license-remediation.md)

## Current conclusion

Checked on 2026-09-19: package metadata and the README for `pi-lsp-extension@1.3.0` declare MIT, but a complete copyright and permission notice was not located. This record adds provenance evidence; it does not grant rights on behalf of upstream or certify product-wide compliance. The public-release check remains blocked.

## Evidence checked

- [Pinned package.json](https://github.com/samfoy/pi-lsp-extension/blob/5edc932d325b630483f84f7d7f038e88ceba1eba/package.json) and [README](https://github.com/samfoy/pi-lsp-extension/blob/5edc932d325b630483f84f7d7f038e88ceba1eba/README.md): MIT declarations.
- Downloaded the original 1.3.0 archive again from the official npm registry: 53 files, no license/copyright notice filenames, and SHA-256 matching the saved evidence. The archive was inspected in memory without installing or executing its contents.
- Current main is pinned at `f2433d19c3bb1300dfdc5f4505b062f9c9c0a1a6`, with 65 reachable commits; all fetched branches and tags contain 66 reachable commits. Historical paths have no case-insensitive matches for `license|licence|copying|copyright|notice`. Deleted or unfetched refs are outside this scope.
- Content at the pinned version and current main has no matches for `copyright|permission is hereby granted|MIT License`, excluding the lockfile. This is a targeted search, not a line-by-line audit of all historical contents.
- The 13 open/closed issue and PR titles returned by the GitHub API contain no apparent license request; all comments were not exhaustively checked.

See the [machine-readable evidence](../licenses/pi-lsp-extension-evidence.json) for hashes, archive paths, immutable links and scope. Repository account names, commit authors and the standard MIT template are not used to infer copyright ownership.

## What upstream needs to provide

1. Have the project owners confirm copyright holders and years, and commit the complete MIT permission and copyright notice.
2. Clarify whether it covers the already published 1.3.0 and its pinned source commit. If it covers only a later release, YHWH must update the dependency and revalidate its patches.
3. Include the license in the next npm release and check the actual archive.

The [English request record](upstream-lsp-license-request.md) was submitted with user authorization as [upstream issue #14](https://github.com/samfoy/pi-lsp-extension/issues/14); its body was read back and verified. It contains only public upstream facts. The notice and version coverage still await upstream confirmation.

## Integration after upstream confirmation

1. Preserve the notice verbatim under `licenses/`, record an immutable commit URL and SHA-256, and retain explicit version-coverage evidence. A LICENSE added after 1.3.0 does not by itself establish coverage of the old release.
2. Update `licenses/sources.json` and the evidence's `upstreamNotice` (`file`, `source`, `sha256`). Set `upstream-notice-verified` only after manually checking provenance and version coverage. The standard template cannot serve as this material.
3. Update both third-party documents, the LSP NOTICE and the install patch's generated `YHWH-PATCH-NOTICE.txt`. Retain modification notices and remove resolved pending-attribution statements.
4. Add the new notice to the standalone notice list in `install/license-inventory.mjs`, regenerate `THIRD_PARTY_NOTICES.txt`, and verify inclusion in source, portable and one-click archives. The current generator does not include the text merely because an `upstreamNotice` field was added.
5. Run `node install/license-inventory.mjs --check --public` and packaging checks. Hash and status checks do not replace legal or provenance review; changing only the status must not be used to bypass the hold.
6. Publish a new version for the updated materials. Preserve existing v0.8.0 assets rather than silently replacing files under the same tag.

The [standard MIT terms](https://opensource.org/license/mit) require preservation of copyright and permission notices. This repository's standard text is supplied only as a reference.
