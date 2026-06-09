---
name: verify
description: Universal verification contract runner. Use to machine-check a mission's acceptance criteria (check_command + severity) for ANY change — code, docs, or config. Replaces the old "skip tests for markdown/config" carve-out. Run before declaring any slice done.
---

# verify skill

Runs the **universal verification contract**: every mission carries
machine-checked `acceptance_criteria`, each with a `check_command` and a
`severity` (`block` or `warn`). Code missions gate on RED→GREEN tests;
docs/config missions gate on a non-test command (lint, build, link-check).
Nothing ships unverified.

## Criteria file

```json
{
  "scaleLevel": 2,
  "criteria": [
    { "id": "AC-TYPES", "description": "Type checker passes", "check_command": "bun run typecheck", "severity": "block" },
    { "id": "AC-TESTS", "description": "Tests green",         "check_command": "bun test",          "severity": "block" },
    { "id": "AC-LINT",  "description": "Lint clean",          "check_command": "bun run lint",      "severity": "warn"  }
  ]
}
```

- `severity: block` — a failure fails the whole verification (exit 1).
- `severity: warn` — a failure is reported but does not fail the run.

## Subcommands

### run \<criteria.json\> [--json]

Run every criterion and print a verdict. Exit 0 only when all `block`
criteria pass.

```
bun run .omp/skills/verify/bin/verify.ts run specs/active/SPEC-...-acceptance.json
```

### scaffold \<0..4\>

Emit a starter criteria set for a BMAD-style **scale level**:

| Level | Name | Default criteria |
|------|------|------------------|
| 0 | trivial | lint (warn) |
| 1 | small | typecheck + lint |
| 2 | standard | typecheck + tests + lint |
| 3 | complex | + dependency audit |
| 4 | enterprise | + audit (block) + release build (block) |

```
bun run .omp/skills/verify/bin/verify.ts scaffold 2 > specs/active/SPEC-...-acceptance.json
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | all block-severity criteria passed |
| 1 | at least one block-severity criterion failed |
| 2 | usage / parse error |

## Who runs this

The `validator` Ghola runs `verify run` as its primary gate and reports the
binary verdict back to Seshat. The orchestrator picks the scale level at
`classify` time and scaffolds the criteria alongside the spec.
