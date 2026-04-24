---
id: SPEC-20260424-003
slug: push-and-memory-skills
slice: 3 of 6
title: Local safety-wrapper skills — push (consent-gated) and memory (read-side helpers)
status: archived
author: seshat (drafted on behalf of luci)
created: 2026-04-24
depends_on: [SPEC-20260424-001, SPEC-20260424-002]
linear: n/a
---

# SPEC-003 — Push + Memory Skills

## 1. Goal

Land two Pi skills that operate only on local state:

- **`push`** — the single authorized path for any `git push`. Consent-gated by a mandatory `--i-approve` flag with pre-flight checks and a forensic audit log.
- **`memory`** — read-side helpers over Honcho + `.honcho-state.json` that make cost and activity visible to the human (Luci) in plain text. No mutations.

These precede all external-surface skills (Linear, GitHub) because they establish the audit-log + draft-mode idiom we'll replicate.

## 2. Scope

In scope:

- `.pi/skills/push/` directory with:
  - `SKILL.md` (Pi skill descriptor with frontmatter + body)
  - `bin/push.sh` (Bash script; `set -euo pipefail`)
  - `README.md` (model-facing usage doc)
- `.pi/skills/memory/` directory with:
  - `SKILL.md`
  - `bin/memory.ts` (Bun script)
  - `README.md`
- Forensic append-only log at `.pi/.push-log.jsonl` (0600, gitignored).

Not in scope:

- Auto-push or scheduled pushes.
- PR creation (slice 5).
- Memory mutations (slice 1 covers writes).

## 3. Implementation constraints

### 3.1 `push` skill

Invocation forms:

```
/skill:push                              # dry-run: prints what would happen, does NOT push
/skill:push --i-approve                  # executes after pre-flight
/skill:push --i-approve --remote=origin  # explicit remote override (default: origin)
```

Pre-flight checks (ALL must pass; any failure aborts with a clear message):

1. Working tree clean (`git status --porcelain` empty).
2. Local branch is ahead of, not diverged from, the remote tracking branch.
3. Not on `main` / `master` unless `--allow-main` is also explicit (defense against accidental main pushes).
4. At least one commit on the branch carries the `Spec-Slice:` trailer (sanity check: this branch was actually worked via Seshat).
5. `.pi/.honcho-state.json` has `currentSlice === null` (you don't push mid-slice; close the slice first).

If all pass: run `git push` and append one JSON line to `.pi/.push-log.jsonl`:

```json
{"ts":"<ISO>","branch":"<name>","remote":"<remote>","range":"<old>..<new>","commits":N,"approver":"luci"}
```

### 3.2 `memory` skill

Commands (all read-only, no `--i-approve` needed):

```
/skill:memory status                      # current slice + cost counter summary
/skill:memory review <session-id>         # list all conclusions written during that session
/skill:memory cost [<slice-id>]           # cost breakdown: Honcho calls + subagent tokens
/skill:memory history [--limit=10]        # recent finished slices with PASS/FAIL outcome
/skill:memory search <query>              # wraps honcho_search at workspace scope
```

Output is plain text, formatted for REPL readability: table columns, right-aligned numbers, totals on the last line.

### 3.3 Shared conventions

- Skills are invokable via `/skill:<name>` from Seshat; READMEs are read by the model when it considers using the skill.
- Every mutation in any future skill MUST follow the `--i-approve` idiom established here.
- Audit log files share the `<action>-log.jsonl` suffix convention and mode 0600.

## 4. Acceptance criteria

1. `/skill:push` with no flags prints a full pre-flight report and exits 0 without pushing.
2. `/skill:push --i-approve` on a clean-tree, ahead-of-remote feature branch pushes successfully and appends one line to `.pi/.push-log.jsonl`.
3. `/skill:push --i-approve` on `main` without `--allow-main` exits non-zero with "refusing to push to protected branch."
4. `/skill:push --i-approve` mid-slice (currentSlice != null) exits non-zero with "slice still open: call specsafe_end first."
5. `/skill:memory status` run while a slice is open reports the slice ID, session ID, honcho call count, and total subagent tokens accurately (cross-verified against the state file).
6. `/skill:memory cost` run after a finished slice prints a human-readable cost breakdown matching the state file's history entry.
7. `/skill:memory review <session>` lists conclusions whose `created_at` falls within the slice's beganAt..endedAt window (via Honcho list_conclusions + timestamp filter).
8. Neither skill writes to Honcho, ever.
9. `.pi/.push-log.jsonl` is in `.gitignore`.

## 5. Open questions / risks

- **Q1** — `memory review` correctness relies on timestamps. If Honcho's `createdAt` is server-side and our `beganAt` is local, clock skew could miss entries. **Mitigation:** filter by session ID whenever the SDK supports it; fall back to timestamp with a ±5s grace band.
- **Q2** — Should `push` auto-open a browser to the PR URL? **Proposal:** no. Keep it shell-only in v1; PR creation is a separate action in slice 5 and is itself gated.
