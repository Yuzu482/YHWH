# Restricted sandbox checks

`yhwh_run_check({commandId})` is a Chesed write-task tool available only through
the WSL Bubblewrap runtime. It is unavailable on host CLI routes and disabled
unless both a task `verify.commands` declaration and a trusted host policy admit
every requested command. Absence or rejection falls back to the existing
implementation → artifact application → mandatory host verification workflow.

## Policy and dependency preparation

The fixed Windows policy is
`C:/Users/asus/.local/state/pi-kether/run-check/check-policy.json`:

```json
{"version":1,"projects":[{"workspace":"E:/Example","commands":[{"argv":["node","--test","tests/example.test.mjs"],"cwd":".","runnerId":"node","cacheId":"example"}]}]}
```

Only the user or a separately authorized host operator maintains this file.
Tasks, models and MCP parameters cannot write it or select another policy.
There are no wildcard commands or shell execution. Exact canonical workspace,
argv and relative cwd must match; command IDs only select an already admitted
tuple. Control characters, shell metacharacters, absolute argument paths and
traversal are rejected. Policy reading holds native Windows handles, validates
NTFS identity, owners and DACLs, and rejects aliases, reparse points and hardlinks.
An unavailable helper or unsafe policy disables the tool without changing ACLs.

The root-owned Linux trust manifest separately pins runner content hashes,
read-only dependency cache file hashes and project dependency manifest hashes.
Only the Node runner is implemented in this phase. Provisioning prepares an
empty cache; project caches require explicit operator preparation and immutable
manifests. No cache population, package installation or network download occurs
during a check. Node projects can prepare a cache from their lockfile outside
the task sandbox, validate its content, copy it to a root-owned immutable cache,
and record all file hashes plus package/lockfile hashes. Python virtualenvs,
Cargo vendor trees, Go module caches, JVM and .NET package caches are future
runner work and are currently rejected rather than silently executed. Windows
dependencies are not treated as Linux-compatible caches.

## Isolation and bounds

Each check receives a bounded, no-follow regular-file snapshot of the task's
already admitted workspace. It cannot modify the model's workspace. Symlinks,
hardlinks, devices and sockets are rejected; executable privilege bits are
removed. A private mount namespace provides a nosuid/nodev snapshot filesystem,
read-only pinned runner/cache, a private PID namespace, no network, no host home
or credentials and a cleared environment. Existing root-owned WSL OS binaries
and shared libraries remain part of the trusted host base, as in the existing
launcher; this feature does not grant the worker write access to them.

The root broker joins a nested cgroup before dropping privileges or executing
the check: 64 processes, at most 512 MiB memory with a model reserve and at least
128 MiB headroom beyond current parent usage (otherwise admission fails), no swap,
120 seconds (or the shorter remaining task budget), and 256 KiB combined output.
Resource setup is verified before execution. Timeout, cancellation, output
overflow and failure kill the complete check cgroup, including detached
descendants. Cleanup failure invalidates the evidence. At most eight calls are
admitted per implementation; a signed terminal record binds the final tally.

## Evidence and acceptance

The root broker signs command, exit code, duration, output digest, bounded
redacted summary and cleanup outcome. The host verifies the per-job HMAC,
request/task/policy/cache identities, sequence, receipt hash chain and terminal
tally. Forged, duplicated, replayed, oversized or incomplete frames fail closed.
Collector frames are separated from model output before ordinary output limits.

Validated records are stored under `sandboxEvidence`; they cannot create host
attestations or make a task accepted. `apply_artifact`, current-artifact host
checks, `record_host_verification`, and the tier's required independent review
remain necessary. Failed check receipts are retained alongside successful ones.

## Deployment and fallback

Source changes alone do not enable production checks. Installation must transfer
the broker, proxy, snapshot helper and Windows policy reader and provision the
root-owned runner trust. Default policy absence keeps the tool off. Candidate
validation uses a distinct root-owned namespace, job/cgroup prefixes and trust
tree; production launcher and runtime hashes are compared before and after.
Rollback disables/removes the project policy entry and returns to mandatory host
verification; installation changes require their own authorized deployment.
