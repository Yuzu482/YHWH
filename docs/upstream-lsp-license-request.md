# Submitted upstream license request

Target: https://github.com/samfoy/pi-lsp-extension/issues
Status: submitted with user authorization on 2026-09-19T05:27:00Z; open when verified.
Issue: https://github.com/samfoy/pi-lsp-extension/issues/14

The title and body below match the submitted issue, verified by reading it back from GitHub. They contain public upstream facts and do not identify the private downstream repository or its implementation.

## Title

Include the complete MIT license and copyright notice in the repository and npm package

## Body

The [package.json for pi-lsp-extension 1.3.0](https://github.com/samfoy/pi-lsp-extension/blob/5edc932d325b630483f84f7d7f038e88ceba1eba/package.json) and its README declare MIT, but I could not locate a complete license and copyright notice.

Checked on 2026-09-19:

- The [published 1.3.0 tarball](https://registry.npmjs.org/pi-lsp-extension/-/pi-lsp-extension-1.3.0.tgz) contains 53 files, with no LICENSE, LICENCE, COPYING, COPYRIGHT or NOTICE file. Its SHA-256 is `45247f8c3d0e3624a46501428d8370ddc79b89189feda93f84e890b5756061a5`.
- npm identifies the source as commit `5edc932d325b630483f84f7d7f038e88ceba1eba`.
- I also checked the [current tree at f2433d1](https://github.com/samfoy/pi-lsp-extension/tree/f2433d19c3bb1300dfdc5f4505b062f9c9c0a1a6) and license-like filenames in the fetched branch/tag history; I did not find a standalone notice.

Could you please:

1. Add the complete MIT license text with the appropriate copyright holder(s) and year(s), as confirmed by the project owners.
2. Confirm whether that notice applies to the already published version 1.3.0 at the commit above, or identify the first release it covers.
3. Include the notice in the next npm package, verifying its presence with `npm pack --dry-run` and in the actual tarball.

This would allow downstream users to preserve the original notice without guessing attribution. A commit adding the notice and clarification of version coverage would be helpful even before the next npm release.

Thank you.
