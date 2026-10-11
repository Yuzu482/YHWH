# Installation main-history gate

Workflow Install defaults to a pushed, clean Git source whose HEAD is an ancestor of the freshly advertised origin/main commit. An older ancestor is allowed. A stale tracking ref is insufficient. Missing main, a missing local main object, failed remote reads, or unknown ancestry reject before any target-home write. Fetch remote history explicitly and retry; admission does not fetch, push or change refs.

A known non-main commit requires both -PreMergeDeploy and a nonempty -Reason. The reason is one line, at most 512 characters / 2048 UTF-8 bytes, with control characters rejected. A reason without the flag rejects. This exception only relaxes main membership. HEAD must still be pushed; a dirty source separately requires -AllowDirty -DirtyReason. Neither flag grants agent permission to commit, push or deploy. Detached sources are recorded as (detached).

Example (requires the user's independent deployment authorization):

    ./Workflow.ps1 -Action Install -PreMergeDeploy -Reason 'Explicitly approved pre-merge trial'

Installation records retain all existing admission fields and add mainPolicy schemaVersion=1: relation, exact advertised mainCommit, verifiedAt, branch/detached, preMergeDeploy, reason, and CI evidence for an explicit exception. CI collection uses the configured GitHub origin and exact source SHA, through existing gh authentication; no credential files or endpoint overrides are changed. All exact-HEAD PR matches are retained. Queries are read-only; CI is descriptive evidence, never additional installation authority.

CI status none means successful complete queries found no PR/check/status. unavailable means absent tooling, unsupported origin, network/auth failure, malformed or incomplete results. A full 100-result page or a mismatched total_count is incomplete. observed retains PR and check/status details with conclusion success / failure / pending / unknown / none. Missing evidence is never promoted to success. Local bare Git fixtures report unavailable because they have no supported GitHub origin.

Each Git/gh subprocess has closed stdin, shell-free arguments, hidden windows, 15-second execution/pipe-drain bound and a combined 512 KiB output cap, with bounded process-tree termination/reap. Inherited GIT_* variables and GH host/repository/pager overrides are scrubbed; only HTTPS, SSH and local-file Git transports are allowed. Launch failure, timeout, output overflow and uncertain cleanup are unsuccessful. Identity, dirty state and branch/detached state are checked again after evidence collection.

Test-PiKether -Installed reads the installed provenance SHA and independently checks fresh main ancestry against its source repository. DEPLOYMENT_NOT_IN_MAIN warns about a known unmerged deployment. DEPLOYMENT_MAIN_UNKNOWN warns about offline, packaged/missing Git source or unavailable coverage. These warnings do not increment failures. Integrity/parity failures still fail. The non-Installed portable check stays offline.

This is a source-controlled host deployment policy, not an OS security boundary. It does not prevent a user from running another installer or altering trusted source/configuration. Installed ancestry adds a bounded network read; no source or production configuration is mutated. New helper files must be committed before release packaging, which stages Git-tracked files.

Plain HTTP and git:// origins are rejected by the transport allow-list. With shallow Git history, a negative ancestry result can be incomplete: use a full clone or explicitly complete its history before deployment. Installed-warning integration has focused helper coverage; a full clean-candidate Installed run remains a release verification step.

