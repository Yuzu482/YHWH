# Pi single-shot process tail

`processTailMs` measures the host interval from the last normalized Pi
`agent_end` to the WSL child closing. It excludes the separately measured
root job cleanup. It is not model generation time or a token metric.

An isolated observation on Pi 0.84.4 / Node 22.23.1 / openai-codex Luna
recorded `session_shutdown` and awaited `main()` returning 1.824 ms after
the child's own `agent_end`, while the host tail remained 3,262 ms.
Earlier strace recorded an approximately 2.83-second socket epoll wait.
The passive WebSocket close observer did **not** see a close marker in the
tested route. Residual process/socket lifetime is observed; attributing it
to a specific WebSocket implementation or handshake remains unconfirmed.

The original CLI calls async `main()` without awaiting its promise. The
secure bootstrap now awaits the pinned main entry for admitted single-shot
OpenAI jobs. The optimization only applies when nine SDK file hashes match
and the complete argv passes a strict allowlist: print JSON, no session,
offline settings, known model/tools/extensions and no additional arguments.
Changed/missing SDK files, other providers and noncanonical arguments use
the original CLI unchanged. The transport fence and in-memory credential
preparation precede this selection. No new task or environment selector exists.

A private extension observes official lifecycle/tool hooks. Forced exit
requires main to resolve, agent end/settled/shutdown to be seen, balanced
tool IDs and no active agent/tool. Incomplete or inconsistent events use
natural exit. Main already awaits runtime disposal and shutdown handlers.
Stdout and stderr must then drain, each within two seconds; failure exits
nonzero. Numeric Pi exit codes are preserved. A fatal main rejection also
exits nonzero. This does not terminate active successful work at agent_end.

The tradeoff is abrupt teardown of residual sockets after completed requests,
without waiting for a clean WebSocket close handshake. Detached descendants
remain the launcher's responsibility: root cgroup cleanup, signed check
terminal, patch validation and required host verification are still mandatory.
Child exit alone never establishes task acceptance.

Fixed-enum, monotonic child timings use a reserved stderr line prefix.
The bounded, chunk-safe collector strips that namespace before interpreting
terminal patch errors, even for malformed or forged frames. All diagnostic
bytes still consume the output budget. This metadata is diagnostic only,
never trusted verification. Old results without it keep their previous shape.
Child deltas and host `processTailMs` use different clock origins.

Three isolated paired T0 write tasks used identical frozen task packages,
with order baseline/optimized, optimized/baseline, baseline/optimized.
Only the source-fixed exit-policy constant differed between candidate hashes.
All six passed apply_artifact, actual host checks and task_accepted.

| Pair | Natural tail (ms) | Bounded-exit tail (ms) | Difference (ms) |
| --- | ---: | ---: | ---: |
| 1 | 3275 | 222 | -3053 |
| 2 | 3275 | 234 | -3041 |
| 3 | 3258 | 233 | -3025 |

Median natural tail was 3275 ms, optimized 233 ms, paired difference -3041 ms.
The separate observation run is excluded. One preliminary loopback connection
failure occurred before dispatch/model launch and remains recorded. This is
a small local Luna sample, not production, other-provider or token evidence.
No production deployment was performed.
