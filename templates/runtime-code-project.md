# Runtime-code project policy

Copy these rules into project `AGENTS.md` when adopting them:

- Require task.context section `接口约定` (Interface contract), with a complete function signature/result or CLI invocation (for example, `--input FILE --output FILE`); use named arguments, never positional `argv` indices.
- Process success means status 0 with no launch error, signal, or timeout; stderr alone is not failure.
- Name full relative output paths including parents, overwrite policy, and failure cleanup. Keep caller, callee, and tests with one worker.
- Split large work into data/validation, pure logic/memory tests, then I/O wrappers; security-sensitive I/O is T2.
- Require a real interpreter and small real fixture, usable output, and no failure residuals; mocks alone do not qualify.
- In `finally`, close every file/process handle; failed output must be deletable/renameable. Use standard-library path APIs, UTF-8 without BOM, and never assume PATH.
- Use one process helper returning `{status, signal, stdout, stderr, error, timedOut}` and one success predicate including `!timedOut`; normalize existing helpers.
- Parse with standard-library `util.parseArgs`/`argparse`; unknown or missing required args show usage and exit 2.
- Write temp then atomic rename with explicit overwrite policy and failure cleanup. Check dependencies by actual version query and successful status, not catch-all/stderr heuristics.
- Scripts need real end-to-end smoke plus argument-error, missing-dependency, and corrupt-input tests asserting exit and no residuals.
- Workers without execution capability list checks unverified; primary runs real host checks. Do not open shell/install permissions.
