---
name: mission
description: Ultimate-Harness mission-packet shim. Create/update uh.mission.v0 packets (goal, scale level, acceptance criteria, verification verdict, promotion record, audit trail) so omp work is legible to the Ultimate Harness as a runtime-adapter artifact. Used by release-steward at L4.
---

# mission skill

Emits and updates **`uh.mission.v0`** packets — the contract that lets this omp
installation slot into the Ultimate Harness as a runtime adapter. A packet is a
single JSON file under `specs/promotion/` capturing the whole mission record.

## Packet shape

```json
{
  "schema": "uh.mission.v0",
  "id": "MISSION-20260609-001",
  "goal": "team invitations + lifecycle",
  "scaleLevel": 4,
  "runtime": "oh-my-pi",
  "acceptance_criteria": [ { "id": "AC-TESTS", "description": "...", "check_command": "bun test", "severity": "block" } ],
  "verification": { "verdict": "PASS", "ranAt": "2026-06-09T..." },
  "promotion": { "promoted": true, "approver": "luci", "at": "2026-06-09T..." },
  "audit": [ { "ts": "...", "event": "created mission ..." } ],
  "createdAt": "...", "updatedAt": "..."
}
```

## Subcommands

| Command | Effect |
|---------|--------|
| `mission new <id> <goal...> [--scale N]` | print a fresh packet (PENDING) |
| `mission show <packet.json>` | validate + print a packet |
| `mission set-verdict <packet.json> <PASS\|FAIL>` | record the verify verdict |
| `mission promote <packet.json> <approver>` | record promotion (refuses unless verdict is PASS) |

```
bun run .omp/skills/mission/bin/mission.ts new MISSION-20260609-001 "team invitations" --scale 4 > specs/promotion/MISSION-20260609-001.json
bun run .omp/skills/mission/bin/mission.ts set-verdict specs/promotion/MISSION-20260609-001.json PASS
bun run .omp/skills/mission/bin/mission.ts promote specs/promotion/MISSION-20260609-001.json luci
```

## Gate

`promote` **refuses** unless `verification.verdict === "PASS"`. Promotion is a
checklist, not a judgement call — the release-steward never overrides it.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | success |
| 1 | state / validation error (incl. promote-before-PASS) |
| 2 | usage error |
