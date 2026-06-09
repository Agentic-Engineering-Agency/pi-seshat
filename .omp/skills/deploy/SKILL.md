---
name: deploy
description: Install the Seshat v2 system globally by symlinking repo .omp capability dirs into ~/.omp/agent so every project gets the orchestrator, Gholas, rules, and skills. Dry-run by default; --i-approve to apply.
---

# deploy skill

Makes Seshat v2 available **globally** (every project) while keeping
**project-local** overrides authoritative. omp discovers user-level
capabilities from `~/.omp/agent/{agents,extensions,tools,skills,rules,commands}`
and `~/.omp/agent/{RULES.md,AGENTS.md}`; this skill symlinks each repo `.omp/<cap>`
to its `~/.omp/agent/<cap>` sibling. Symlinks (not copies) mean repo edits flow
live to the runtime — no drift.

Precedence is preserved: a project's own `.omp/` wins over the global links, so
per-project customization still works.

## Usage

```
bun run .omp/skills/deploy/bin/deploy.ts              # dry-run: show the plan
bun run .omp/skills/deploy/bin/deploy.ts --i-approve  # apply
bun run .omp/skills/deploy/bin/deploy.ts --i-approve --force  # replace real dirs/files
```

## What gets linked

| Source (repo) | Target (global) |
|---------------|-----------------|
| `.omp/agents` | `~/.omp/agent/agents` |
| `.omp/extensions` | `~/.omp/agent/extensions` |
| `.omp/tools` | `~/.omp/agent/tools` |
| `.omp/skills` | `~/.omp/agent/skills` |
| `.omp/rules` | `~/.omp/agent/rules` |
| `.omp/commands` *(if present)* | `~/.omp/agent/commands` |
| `.omp/RULES.md` | `~/.omp/agent/RULES.md` |
| `AGENTS.md` | `~/.omp/agent/AGENTS.md` |

## Actions

- **create** — link is missing → create it.
- **skip** — already the correct symlink → no-op (idempotent).
- **conflict** — a real dir/file exists → refuse unless `--force`.
- **replace** — `--force` removes the existing path and links.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | success / clean dry-run |
| 1 | unresolved conflict or write failure |
| 2 | usage error |
