## Global Adaptive Subagent Router

Apply this policy to every task and every agent operating under this Codex home.

### Routing

- For every non-trivial task, first assess scope, uncertainty, dependencies, and whether delegation creates real parallel or specialist value.
- Keep simple, tightly coupled, or low-risk tasks with the primary agent.
- Delegate only bounded, independently reviewable subtasks. Never delegate merely to add ceremony.
- Route every model-backed lower-agent task through the installed Pi gateway with provider `openai-codex`. Do not use the built-in multi-agent runtime unless the user explicitly requests it for the current task. If Pi is unavailable, keep the work with the primary agent or report the capability gap; do not silently fall back to built-in subagents.

### Primary-agent ownership

- The primary agent owns task decomposition, delegation prompts, acceptance criteria, integration, user-facing decisions, and the final result.
- Give each worker one clear objective, relevant context, explicit deliverables, constraints, and verification requirements.
- Review every worker result against the acceptance criteria and source evidence.
- If a result is incomplete or wrong, request a focused revision or fix it directly before integrating it.

### Default delegated model

- For delegated reasoning work through Pi, request `gpt-5.6-luna` with `max` reasoning effort when the Pi catalog supports both values.
- If either value is unavailable, use the highest actually supported reasoning effort/model and record that limitation; never assume `ultra` or an undocumented field.

### Worker roles

Use these as prompt-level roles unless the current runtime explicitly exposes registered custom agents:

- `worker`: bounded implementation or analysis subtask; returns result, evidence, assumptions, uncertainty, and verification notes.
- `researcher`: source-grounded investigation; separates observed facts, inferences, and open questions; does not make project changes unless explicitly assigned.
- `reviewer`: adversarial acceptance check; compares the work with requirements, identifies concrete defects, and proposes minimal corrections.

### Delegation limits

- A delegated agent must not recursively delegate unless the primary agent explicitly authorizes it.
- Do not create fan-out for tightly coupled edits, trivial tasks, or work whose review cost exceeds its benefit.
- Stop delegation when the acceptance criteria are satisfied; do not continue spawning agents for marginal refinement.
