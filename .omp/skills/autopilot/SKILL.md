---
name: autopilot
description: Cross-session autonomous mission control. Set a persistent objective that survives auto-handoff (at the 70% context threshold) and full omp process restarts, re-arming omp's native Goal Mode at each session boundary. Use when a goal must run to completion across many sessions without re-priming context by hand.
---

# autopilot skill

Lets a single objective run to completion **across sessions**. It bridges two
native omp features that, by design, do not span the session boundary on their
own:

- **Goal Mode** (`/goal set`) — autonomous, auto-continuing objective *within* a
  session, with token budget.
- **Auto-handoff** (`compaction.strategy=handoff`, `thresholdPercent=70`,
  `autoContinue`, `handoffSaveToDisk`) — at 70% context, omp writes a handoff
  document and continues in a **new** in-process session.

The gap: `GoalRuntime.onThreadResumed()` deliberately **pauses** an active goal
whenever a session is resumed/switched. So after an auto-handoff or a restart,
the autonomous loop stops. Autopilot closes that gap: it mirrors the objective
to a portable record (`<cwd>/.omp/.autopilot.json`) and, at each boundary,
steers the orchestrator to re-establish its native goal using the injected
`<handoff-context>` + `STATE.md`.

> Run the **orchestrator on a 1M-context model** so the 70% trigger leaves ample
> working room. Autopilot warns at a boundary if the context window is smaller.

## Modes

| Mode | Set with | Behavior at each session boundary |
|------|----------|-----------------------------------|
| **draft** (default, safe) | `autopilot set <objective>` | drafts a resume prompt; you review and submit |
| **auto** (full autonomy) | `autopilot auto <objective>` | re-arms and continues with no human input |

## Subcommands

| Command | Effect |
|---------|--------|
| `autopilot set <objective>` | create a mission in **draft** mode |
| `autopilot auto <objective>` | create a mission in **auto** (full-autonomy) mode |
| `autopilot show [--json]` | show the current mission |
| `autopilot pause` | pause re-arming (mission kept) |
| `autopilot resume` | resume a paused mission |
| `autopilot budget <N\|off>` | set/clear the token budget mirrored onto the goal |
| `autopilot stop` / `done` | drop / complete the mission (terminal) |

The same controls exist as the in-session `/autopilot` slash command.

```
bun run .omp/skills/autopilot/bin/autopilot.ts auto "SPEC-012: migrate billing to the new ledger, all slices green"
bun run .omp/skills/autopilot/bin/autopilot.ts show
bun run .omp/skills/autopilot/bin/autopilot.ts done
```

## Required configuration

Autonomous operation needs these keys (shipped in `.omp/config.yml`; the
`deploy` skill merges them into the global `~/.omp/agent/config.yml`):

```yaml
compaction:
  enabled: true
  strategy: handoff
  thresholdPercent: 70
  autoContinue: true
  handoffSaveToDisk: true
goal:
  enabled: true
  continuationModes: [interactive]
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | success |
| 1 | state error (no mission / illegal transition) |
| 2 | usage error |

## Who uses this

Seshat (orchestrator) sets the mission at the start of a long multi-session
effort and marks it `done` when the acceptance contract is fully green. Pairs
with `state` (current-mission working set) and Honcho (durable cross-project
lessons): autopilot is what keeps the loop *running* across the boundaries the
other two only *record*.
