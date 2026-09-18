# Global agent instructions

These user-level rules apply to tasks operating under this Codex home. They remain subordinate to system/developer instructions, actual tool permissions, and the user's current request. References below are part of this policy; load them when their trigger applies, not all at task start.

## Core rules

- The primary agent owns intent, scope, authorization, decomposition, integration, and evidence-based final acceptance. Inspect current sources before changes and preserve unrelated work.
- Keep simple, tightly coupled, or low-risk work on the compact primary-agent path. For non-trivial work, assess uncertainty, dependencies, and the value of independent work; read the governance reference and load the available kether-governance skill.
- Honor Plan/Execute mode and existing authorization. Resolve only material ambiguity. Do not invent a new confirmation gate for already-authorized reversible work; an answer to clarification does not authorize a separate action.
- Delegate only bounded, independently reviewable work with real value. Model-backed lower agents use Pi; built-in subagents require an explicit user request for that route. No recursive delegation without primary-agent authorization. If Pi is unavailable, continue locally when feasible and disclose missing independence; strict independent execution remains blocked.
- Query Pi capabilities before model dispatch. The current role bindings are OpenAI Luna/max for workers and Claude Sonnet/max for reviewers, with reviewer access none. Read the routing reference for exact identifiers. Its explicit bindings and reviewer exception govern older default-route or fallback wording in references and skills; never substitute a provider/model to evade them.
- For substantive changes, follow the governance stages with pre-review before mutation and post-review after verification. Default to one writer. Reviewers do not edit; verifiers do not silently repair. Never claim an unperformed stage or check passed.
- Accept completion only with the required evidence. Distinguish completed, failed, blocked, and unverified; keep user-facing explanations concise. Bound repair loops and stop delegation when acceptance is satisfied.
- Do not create tasks, automations, external messages, commits, pushes, deployments, memories, or permission changes merely because a workflow mentions them. The user's request and host rules must authorize them.
- Execute deterministic LSP through the direct tool, without a model. For raster-image generation/editing or image-prompt optimization, use the image-prompt-review default; read its reference and installed skill before proceeding. Only an explicit user exception changes that workflow, subject to higher-priority instructions.

## Read references when needed

Resolve these links relative to the installed AGENTS.md (in the Codex home directory), not the workspace. Read applicable references before the corresponding action. Links do not automatically load their contents. If a required reference is unavailable, report that gap and continue only unaffected authorized work.

| Trigger | Reference |
| --- | --- |
| Non-trivial work; stage selection, scope changes, repair or acceptance decisions | [Kether governance](agent-references/governance.md) |
| Considering or preparing model-backed delegation | [Delegation and primary ownership](agent-references/delegation.md) |
| Before selecting or dispatching a Pi model/role | [Current Pi routing](agent-references/pi-routing.md) |
| Before any model-backed Pi task; linking stage predecessors | [Typed contracts and handoffs](agent-references/pi-contracts.md) |
| Submitting or accepting asynchronous Pi work; inspecting timing or paginated results | [Async results and timing](agent-references/pi-results.md) |
| Setting Pi queue/execution budgets; preparing or accepting a reviewer task | [Budgets and review materials](agent-references/pi-review.md) |
| Before Claude dispatch; authentication errors or renewal/recovery | [Host Claude authentication](agent-references/pi-auth.md); also read [result timing](agent-references/pi-results.md) for the task-dependent credential-validity threshold |
| Before direct LSP/structural operations or interpreting their results | [Direct deterministic LSP](agent-references/pi-lsp.md) |
| Generating/editing raster images or optimizing an image prompt | [Default image workflow](agent-references/image-workflow.md) |

Keep protocol details in their references. Moving an instruction out of this entry file does not remove it or relax an existing contract, approval boundary, role binding, or evidence requirement.
