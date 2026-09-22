## Global Adaptive Subagent Router

Apply this policy to every task and every agent operating under this Codex home.

### Routing

- For every non-trivial task, first assess scope, uncertainty, dependencies, and whether delegation creates real parallel or specialist value.
- Keep simple non-coding work with the primary. Coding always goes to a bounded Pi worker; tightly coupled edits go to one worker. Follow [coordinator-only](coordinator-only.md).
- Delegate only bounded, independently reviewable subtasks. Never delegate merely to add ceremony.
- Route model-backed lower-agent work through the installed Pi gateway using the current role binding. Do not use the built-in multi-agent runtime unless explicitly requested. If Pi is unavailable, keep coding blocked and continue only primary reasoning/diagnosis; do not silently fall back to primary coding or built-in subagents.

### Primary-agent ownership

- The primary agent owns task decomposition, delegation prompts, acceptance criteria, integration, user-facing decisions, and the final result.
- Give each worker one clear objective, relevant context, explicit deliverables, constraints, and verification requirements.
- Review every worker result against the acceptance criteria and source evidence.
- If a result is incomplete or wrong, request a focused worker revision. The primary reviews and mechanically applies accepted patches; it does not author implementation repairs.

### Default delegated model

- For delegated reasoning work through Pi, request `gpt-5.6-luna` with explicit task-proportional thinking under pi-routing: medium by default, low/high/max when justified and supported.
- If the required binding is unavailable, report the blocker; do not substitute a model/provider or evade the task-proportional thinking policy.

### Worker roles

Use these as prompt-level roles unless the current runtime explicitly exposes registered custom agents:

- `worker`: bounded implementation or analysis subtask; returns result, evidence, assumptions, uncertainty, and verification notes.
- `researcher`: source-grounded investigation; separates observed facts, inferences, and open questions; does not make project changes unless explicitly assigned.
- `reviewer`: adversarial acceptance check; compares the work with requirements, identifies concrete defects, and proposes minimal corrections.

### Delegation limits

- A delegated agent must not recursively delegate unless the primary agent explicitly authorizes it.
- Do not create fan-out for tightly coupled edits, trivial tasks, or work whose review cost exceeds its benefit.
- Stop delegation when the acceptance criteria are satisfied; do not continue spawning agents for marginal refinement.
