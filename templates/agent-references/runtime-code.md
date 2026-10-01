# Runtime-code quality reference

## PRIMARY PACKET RULES

- Require task.context section `接口约定` (Interface contract), with a complete function signature/result or CLI invocation (for example, `--input FILE --output FILE`) and named arguments, never positional `argv` indices. Process success = status 0, no launch error, signal, or timeout; stderr alone is not failure.
- Name each full relative output path including parents, overwrite policy, and failure cleanup. Keep caller, callee, and tests with one worker. Split large work into data/validation, pure logic/memory tests, then I/O wrappers; security-sensitive I/O is T2.
- Require a real interpreter and small real fixture, usable output, and no failure residuals; mocks alone do not qualify.
- Platform checks: in `finally`, close all file/process handles; failed output must be deletable/renameable; use standard-library path APIs; UTF-8 without BOM; never assume PATH.
- Write temp then atomic rename with explicit overwrite policy and failure cleanup. Check dependencies by actual version query and successful status, not catch-all or stderr heuristics.
- Every script needs real end-to-end smoke plus argument-error, missing-dependency, and corrupt-input tests asserting exit and no residuals.
- Workers without an executor list checks unverified; primary runs real host checks. A completed worker naming unrun checks awaits host verification; do not claim gateway always does it (only eligible patches). Do not open shell/install permissions.

## WORKER CODE CONVENTIONS

Use one process helper returning `{status, signal, stdout, stderr, error, timedOut}` and one `ok(result)` predicate that includes `!timedOut`. Normalize an existing helper to this contract instead of inventing another. Parse CLI with standard-library `util.parseArgs`/`argparse`; unknown or missing required arguments produce usage and exit 2. Write to a temporary file, then atomic-rename with explicit overwrite policy; clean up on failure. Check dependencies using their actual version query and successful status, not catch-all handling or stderr heuristics. Every script needs real end-to-end smoke coverage plus argument-error, missing-dependency, and corrupt-input tests asserting exit status and no residuals. State capability limits: a worker without an executor lists checks as unverified; primary runs real host checks. Do not open shell/install permissions.
