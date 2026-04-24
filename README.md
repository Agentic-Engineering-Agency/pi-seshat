# Pi Specsafe Setup

This directory contains a minimal project-local setup for `pi` tailored to a spec-first coding workflow.

What is included:
- `AGENTS.md`: makes the main agent act as the orchestrator.
- `.pi/extensions/specsafe-subagents/`: registers a `subagent` tool.
- `.pi/agents/`: defines specialized child agents as Markdown files.

How it works:
1. The main agent reads `AGENTS.md` and behaves as the coordinator.
2. The `subagent` extension discovers child agents from `.pi/agents`.
3. Each child agent is a Markdown file with frontmatter:
   - `name`
   - `description`
   - optional `tools`
   - optional `model`
4. The extension spawns fresh `pi` processes in JSON mode and appends the child agent prompt as a system prompt.

Suggested usage in `pi`:
- Ask the main agent to handle a task end-to-end using the specsafe loop.
- Or ask it explicitly to run a chain such as:

```text
Use the specsafe workflow for this task:
- write/update the spec
- write/update the tests
- implement the code
- validate the result
```

Agent file format:

```md
---
name: implementer
description: Implement code changes to satisfy the approved spec and tests.
tools: read,find,grep,ls,write,edit,bash
model: your-model-id
---
System prompt body goes here.
```

Placement:
- Project-local agents live in `.pi/agents/`.
- Project-local extensions live in `.pi/extensions/`.

Notes:
- This scaffold assumes `pi` is installed on your machine.
- I did not run the extension inside `pi` here, because `pi` is not installed in this workspace.
