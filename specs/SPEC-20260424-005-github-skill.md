---
id: SPEC-20260424-005
slug: github-skill
slice: 5 of 6
title: GitHub skill — gh wrapper with draft-mode mutations and Linear-state invariant
status: approved
author: seshat (drafted on behalf of luci)
created: 2026-04-24
depends_on: [SPEC-20260424-001, SPEC-20260424-002, SPEC-20260424-003, SPEC-20260424-004]
linear: n/a
---

# SPEC-005 — GitHub Skill

## 1. Goal

Provide a safety-wrapped `github` skill that:

- passes through `gh` read commands with zero ceremony,
- gates every mutation behind `--i-approve`,
- enforces the "update Linear before opening a PR" invariant at the tool level so the rule survives agent forgetfulness,
- writes a forensic log to `.pi/.github-log.jsonl`.

## 2. Scope

In scope:

- `.pi/skills/github/{SKILL.md,bin/github.sh,README.md}`.
- Audit log `.pi/.github-log.jsonl` (gitignored, 0600).
- Depends on `linear` skill (slice 4) for the invariant check.

Not in scope:

- Reimplementing `gh`. We shell out.
- PR review commands (`gh pr review`) — out of scope for v1 (human-authored reviews remain manual).
- GitHub Actions, releases, repos mgmt beyond what the engineering loop needs.

## 3. Implementation constraints

### 3.1 Commands

```
github pr view <n>                              # pass-through
github issue view <n>                           # pass-through
github repo view                                # pass-through
github api <route>                              # pass-through for GET; gated for non-GET

github pr create --title=... [--body=...] [--draft] [--base=main] [--i-approve]
github pr comment <n> <body>                                                    [--i-approve]
github pr edit <n> [--add-label=...] [--remove-label=...]                       [--i-approve]
github pr merge <n> [--squash|--rebase|--merge]                                 [--i-approve]
github issue comment <n> <body>                                                 [--i-approve]
github issue edit <n> [flags]                                                   [--i-approve]
```

### 3.2 Linear-state invariant on `pr create`

Before creating a PR, the skill:

1. Parses the current branch name. Expects the pattern `<LINEAR-KEY>[-__].*` (e.g. `CUR-92-login-fix` or `CUR-92__login-fix`).
2. If the pattern doesn't match: refuse with "branch does not reference a Linear ticket; rename to `<KEY>-<slug>` first."
3. If matched: call `linear get <KEY>` and read the state. Refuse if state is not one of the PR-ready states (default: `in_progress`, `in_review`). Override with `--bypass-linear-check` (requires explicit `--i-approve` + `--bypass-linear-check`).
4. If checks pass: proceed with `gh pr create --draft ...` (draft by default — explicit `--ready` flag for non-draft).

### 3.3 Draft mode + log

- Mutations without `--i-approve`: print the resolved `gh` command and any Linear-state context. Exit 0. No execution.
- With `--i-approve`: execute `gh`, capture stdout/stderr/exit, append log entry:
  ```json
  {"ts":"<ISO>","cmd":"<gh subcommand>","args":[...],"exit":0,"result_url":"https://github.com/...","approver":"luci"}
  ```

### 3.4 Auth

- Uses existing `gh auth status`. Skill fails loudly if `gh` is not installed or not logged in, with the exact `gh auth login --scopes repo,workflow` command in the error.

## 4. Acceptance criteria

1. `github pr view <n>` on any real PR in the repo returns the same output as `gh pr view <n>`.
2. `github pr create --title=X` (no `--i-approve`) prints a preview including the resolved Linear state of the ticket implied by the branch name, and exits 0 without creating a PR.
3. `github pr create --title=X --i-approve` on a branch with a Linear ticket in `in_progress` creates the PR and logs it.
4. Same command on a branch with a Linear ticket in `done` refuses with a clear state-mismatch message.
5. Same command on a branch name not matching the Linear pattern refuses with the rename hint.
6. `github pr merge <n> --i-approve --squash` merges; log captures the merge commit SHA.
7. `github api` for GET routes passes through; for POST/PATCH/DELETE requires `--i-approve`.
8. `.pi/.github-log.jsonl` is in `.gitignore`.
9. Running the skill with no `gh` in PATH prints the install + auth command and exits non-zero.

## 5. Open questions / risks

- **Q1 — RESOLVED 2026-04-24:** `--bypass-linear-check` + `--i-approve` together = conscious override path. Accepted.
- **Q2 — RESOLVED 2026-04-24:** missing `LINEAR_API_KEY` → invariant check auto-skips with a single-line notice. Accepted.
- **Q3** — Rate limits on `gh api`. We surface the `X-RateLimit-Remaining` header when below 1000.
