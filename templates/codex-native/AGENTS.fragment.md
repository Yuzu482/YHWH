# Native Codex workflow

Apply these instructions under the current user's authorization, project rules, and host permissions.

## Choose an execution route

- Use native Codex for ordinary host work. The primary owns the user's objective, decomposition, integration, and final acceptance. Delegate independent work early when parallel execution can materially shorten delivery.
- For programmatic integration, use Codex App Server for interactive sessions and approval handling, and the Codex SDK for scripted or batch work when the interface meets the task's constraints.
- Use Pi when the user specifies it or the task needs its approved model route or enforced controls. Pi tasks follow the gateway's live admission, scope, sandbox, locking, audit, review, and ledger rules. Preserve the task identity and evidence when continuing an admitted task.

## Assign and hand off native work

- Before each assignment, make a brief, visible entry in the main conversation. Record the agent, selected role or preset, permitted tools and operations with their scope, and the exact writable directories and shared outputs owned by each writer, including the primary agent. Mark read-only or no-tool assignments explicitly. Record authorized changes before proceeding under the revised scope.
- Give each subagent a bounded objective and acceptance criteria. Specify permitted nested calls for a tool runner and permitted commands and targets for a shell. Use a verified restricted tool profile when the host supports one. Treat limits stated in an assignment as collaboration rules. Record technical enforcement only after verifying it on the host.
- Assign one writer per overlapping scope. Include ancestor and descendant directories and shared build, test, installation, and other mutable outputs. Use independent copies or sequence the writes when needed.
- Before handing off a writable scope, confirm that the outgoing writer has stopped and that related background processes are unable to write to it. In the main conversation, record the affected scope, outgoing and receiving owners, and the stop check and its result. Keep an uncertain handoff pending while independent work continues.
- Advance independent work before waiting for a native subagent. Use bounded event waits, usually 30–60 seconds, and check progress on new input, a state change, or a real deadline.

## Select a native role

- Use the companion `agent-presets` templates. Select a registered named role when the host supports it and its configuration matches the template. Otherwise include the composed trait instructions in the assignment. Read the selected traits and give the worker the minimum tools that the assignment needs.
- Keep the writer and independent reviewer separate. The primary owns final integration and acceptance.
