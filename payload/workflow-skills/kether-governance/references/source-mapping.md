# Source mapping and portability

Inspected 2026-09-04. Primary source: ~/.dsh/.agent-presets/kether/preset.yml and agent.cordis.yml. Desktop comparison source: ~/AppData/Roaming/dsh-desktop/harness/.agent-presets/kether/. Role details: ~/.agents/skills/{yesod-prompt-compiler,binah-clarifier,hod-complexity-classifier,malkuth-scout,chochmah-planner,geburah-reviewer,chesed-implementer,netzach-verifier,daat-bridge,tifereth-coordinator}/SKILL.md. These are user profile assets, not Kether files in the upstream DSH source checkout.

## Preserved concepts

Kether owns user intent, governance, ExecutionContract and escalation. Tifereth owns scheduling, never contract override. Yesod/Binah/Hod/Malkuth/Chochmah handle normalization, clarification, classification, observation and planning. Geburah judges pre/post changes. Chesed implements. Netzach verifies. Da'at bridges missing modalities. Preserve bounded scope, actual evidence, review-before-write, final review, one writer by default, bounded repairs and visible capability limits.

## Deliberate host adaptations

- DSH strict coding mode forbids direct Kether/Tifereth implementation and requires specialist stages. Portable mode separates these responsibilities within the host's actual primary/worker model and preserves primary integration ownership. Simple tasks use the existing adaptive router. A local check is not independent agent evidence.
- DSH's interactive Plan lifecycle requires an explicit approved plan before an execute contract. The portable adapter obeys the host's actual mode and existing user authorization; it does not add a universal plan-confirmation gate to already-authorized work.
- DSH uses Cordis plugins, isolated workflowEngine, worker-thread execution and a Tifereth adapter. No equivalent plugins or hard guards are installed by a Markdown skill.
- DSH's prescribed Safe Luna / Euclid Kimi K2.7 Code / Keter DeepSeek V4 Pro, Kimi K3 diagnosis, Claude Opus and GPT Sol ladder and Claude Sonnet evidence judge require those actual providers. Portable mode preserves the user's Codex delegated-model preference and reports unavailable capabilities instead of impersonating providers.
- DSH 1-8 scout shards, 2-8 proposal packets, one-commit-per-packet transaction proofs, scoped indexing, fixed DSH_HOME roots, and exact hash/lock protocols remain DSH-only runtime contracts. Indexing remains off unless explicitly requested and supported. Never invent matching commits, locks, hashes or evidence.
- Tifereth's test:map/test:grid and declared device-path rules are project-specific. Other tasks use the current project's actual test scripts and acceptance requirements.
- For non-code Work tasks, scope uses document IDs, ranges, sources and artifacts as appropriate, rather than fake commit identities.

## Installation boundaries

Codex documents user-level instructions at ~/.codex/AGENTS.md and user-level skills at ~/.agents/skills. This import appends global guidance and adds kether-governance without replacing existing role skills or provider settings. Those local files do not establish cloud/account synchronization. ChatGPT Work custom instructions must be installed or verified separately where they are stored; CHATGPT-WORK-INSTRUCTIONS.md is self-contained when the skill is unavailable.

Official references, fetched 2026-09-04:
- https://learn.chatgpt.com/docs/agent-configuration/agents-md
- https://learn.chatgpt.com/docs/build-skills
- https://learn.chatgpt.com/docs/personalize

Saving files proves installation only. Fresh-task instruction loading and actual workflow execution are separate verification levels.

## Source copy comparison

The two Kether personas and Plan text are semantically equivalent. The user-profile preset includes the isolated worker-thread/Tifereth adapter group; the Desktop copy instead exposes workflow-dispatch at top level and has richer display/governance metadata. This difference is not evidence that either preset is active in a running session.
