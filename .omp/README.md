# `.omp/` — pi-seshat-on-Oh-My-Pi project-scoped extensions

Source-of-truth for the migration landed in `specs/SPEC-20260426-008-oh-my-pi-migration.md`.

## Layout

| Subdir | Purpose | Maps to |
|---|---|---|
| `hooks/` | Hook factories registered via `pi.on(...)` | `~/.omp/agent/hooks/` (auto-discovered) |
| `tools/` | Custom tools (`<name>/index.ts` per tool) | `~/.omp/agent/tools/` (auto-discovered) |
| `agents/` | Ghola persona definitions | `~/.omp/agent/agents/` |
| `skills/` | External-surface skills (`<name>/SKILL.md` + `bin/`) | `~/.omp/agent/skills/` (also reads `~/.claude/skills/`) |
| `test/` | Migration-specific tests | run via `bun test .omp/test/` |

## Deployment

Symlink each `.omp/<subdir>` to its sibling under `~/.omp/agent/` so edits in the repo flow live to the runtime:

```bash
ln -s "$PWD/.omp/hooks"  ~/.omp/agent/hooks
ln -s "$PWD/.omp/tools"  ~/.omp/agent/tools
ln -s "$PWD/.omp/agents" ~/.omp/agent/agents
ln -s "$PWD/.omp/skills" ~/.omp/agent/skills
```

Symlink (not copy) is intentional: it eliminates a "did the ported code drift from repo" failure mode.

## Coexistence

Vanilla Pi's `.pi/` directory in this repo is **untouched** during the migration. Both runtimes coexist on this machine until slice-009 decommissions Meridian + pi-scrub + `~/.pi/agent/`. Rollback from `omp` to `pi` is one config edit in `AGENTS.md`.
