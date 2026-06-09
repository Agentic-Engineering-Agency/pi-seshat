---
name: state
description: Durable cross-session mission context (STATE.md / .omp/.state.json). Use to record the current mission, phase, scale level, and decision notes so heavy facts survive compaction and session restarts. O_EXCL-locked.
---

# state skill

Context-rot defense (GSD pattern). The mission's load-bearing facts live on
disk, not in the conversation: machine state in `<cwd>/.omp/.state.json`, a
human-readable `STATE.md` mirror rendered on every write for commit + instant
resume. All mutations take an O_EXCL lock (`.omp/.state.lock`).

## Subcommands

| Command | Effect |
|---------|--------|
| `state init <mission>` | start a fresh state for a mission (phase=classify) |
| `state set phase <name>` | record the current lifecycle phase |
| `state set scaleLevel <0..4>` | record the BMAD-style scale level |
| `state set mission <text>` | rename the mission |
| `state note "<text>"` | append a timestamped decision/breadcrumb |
| `state show [--json]` | print the current state |
| `state render` | rewrite `STATE.md` from JSON |

```
bun run .omp/skills/state/bin/state.ts init "SPEC-...-team-invitations"
bun run .omp/skills/state/bin/state.ts set scaleLevel 3
bun run .omp/skills/state/bin/state.ts note "architect chose token_hash CAS over subquery"
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | success |
| 1 | lock contention or state error |
| 2 | usage error |

## Who uses this

Seshat updates `phase`/`scaleLevel` as the mission advances and appends a
`note` after every consequential decision, so a restarted session resumes from
`STATE.md` instead of re-deriving context. Pairs with Honcho: Honcho holds the
durable cross-project lessons; STATE.md holds the *current* mission's working set.
