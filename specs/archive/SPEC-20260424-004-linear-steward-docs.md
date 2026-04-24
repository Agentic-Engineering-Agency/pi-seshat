---
id: SPEC-20260424-004
slug: linear-steward-docs
slice: 4 of 6
title: Linear skill + Steward agent + Docs skill (BMad-doc proposal flow)
status: archived
author: seshat (drafted on behalf of luci)
created: 2026-04-24
depends_on: [SPEC-20260424-001, SPEC-20260424-002, SPEC-20260424-003]
linear: n/a
---

# SPEC-004 — Steward + Linear + Docs

## 1. Goal

Introduce the product-side half of the system:

- **`steward` agent** — one markdown file defining the Product Owner persona; Honcho's workspace-scoping gives it a distinct memory per project.
- **`linear` skill** — thin Bun CLI wrapping `@linear/sdk`; draft-mode default, `--i-approve` required for mutations, forensic log.
- **`docs` skill** — propose/apply flow for Steward-authored edits to BMad artifacts (PRDs, UX specs, architecture, briefs). Steward never writes docs directly; it proposes diffs + rationale and waits for human approval.

## 2. Scope

In scope:

- `.pi/agents/steward.md` — persona, memory protocol, tool allowlist.
- `.pi/skills/linear/{SKILL.md,bin/linear.ts,README.md}` — CLI.
- `.pi/skills/docs/{SKILL.md,bin/docs.ts,README.md}` — proposal queue.
- `specs/briefs/` already exists; add a top-level `README.md` explaining the briefs/ archive/ convention.
- Audit log `.pi/.linear-log.jsonl` (gitignored, 0600).
- Proposal queue at `.pi/.doc-drafts/` (directory, gitignored).

Not in scope (slice 5+):

- GitHub / `gh` skill.
- Automatic Linear-state checks triggered from other skills (moves to slice 5).
- Latest-docs skill + doc-scout (slice 6).
- Steward authoring BMad docs *directly* — explicitly forbidden.

## 3. Implementation constraints

### 3.1 Steward agent

- `name: steward`, `description: "Product Owner for the current project. Intakes Linear tickets, produces briefs, drafts Linear state updates, proposes BMad-doc edits."`
- Tool allowlist:
  `read,find,grep,ls,honcho_recall,honcho_search,honcho_remember,honcho_conclude,linear_*,docs_*,write_brief`
  where `linear_*` and `docs_*` are placeholders for whichever tool names the skill registers (skills expose tools as `skill_<command>` to the model — exact naming to be verified against Pi's skill-tool binding).
  - Note: `write_brief` in v1 is just `write`, scoped by discipline to `specs/briefs/*.md` only. The persona prompt enforces this.
- Memory protocol: recall → remember as usual; `honcho_conclude` allowed for product-domain truths.
- Explicitly denied: `edit`, `bash`, `subagent`. Steward is a leaf node.
- Persona body includes: "You are the product steward for whichever project you're currently scoped to (via Honcho workspace). Intake Linear tickets, query Honcho for prior product context, and produce clean briefs. Never modify BMad docs directly — always propose via `/skill:docs propose` with a justification Luci will approve."

### 3.2 Linear skill

Commands:

```
linear list [--team=CUR] [--state=triage|todo|in_progress|in_review|done] [--assignee=me]
linear get <KEY>                                 # e.g. CUR-92
linear comment <KEY> <body>        [--i-approve]
linear transition <KEY> <state>    [--i-approve]
linear create --team=<id> --title=<t> [--body=<b>] [--i-approve]
```

- Auth: `LINEAR_API_KEY` env var; fail loudly if absent with the exact export line to add to `~/.bashrc`.
- Reads pass through immediately.
- Mutations without `--i-approve` print a preview block: resolved team/project/state IDs, the full mutation payload shape, and the line-by-line diff of what would change. Exit 0 (it's a successful dry-run, not an error).
- Mutations with `--i-approve`: execute against Linear, append to `.pi/.linear-log.jsonl`:
  ```json
  {"ts":"<ISO>","action":"<cmd>","key":"<KEY>","before":{...},"after":{...},"approver":"luci"}
  ```
- State transitions resolve state-name → state-ID via Linear's `team.states` query at call time. Cache per-session in memory (not on disk).
- Rate limit headers (`x-ratelimit-*`) surfaced in output when remaining < 50.

### 3.3 Docs skill

Commands:

```
docs propose <path> --rationale=<r>       # body of proposed file read from stdin
docs list                                  # pending drafts
docs show <id>                             # unified diff + rationale
docs apply <id> --i-approve                # lands the change (auto-committed by specsafe-subagents flow? no — this is called by a human; see below)
docs discard <id>
```

- `propose` writes `.pi/.doc-drafts/<ISO>-<slug>.patch` containing a unified diff plus a `# Rationale` header block.
- `apply --i-approve` patches the file tree with `git apply --index` and then stages+commits with trailers:
  `Proposed-By: steward`, `Approved-By: luci`, `Spec-Slice: <id>` (if slice open), `Rationale-From: <draft-id>`.
- `discard` moves the patch to `.pi/.doc-drafts/.discarded/` for forensic retention.
- Scope constraint: proposed paths MUST begin with `docs/`, `specs/`, or `specs/briefs/`. Any other path → refuse with "docs skill is scoped to BMad artifacts."

## 4. Acceptance criteria

1. `.pi/agents/steward.md` parses as valid frontmatter; `name` resolves at discovery.
2. Dispatching `subagent({ agent: "steward", task: "intake CUR-92" })` with a slice open reaches the Steward's Ghola process and produces `specs/briefs/CUR-92.md` (assuming CUR-92 exists in Linear).
3. Steward attempting to `edit` or `bash` returns isError from Pi's built-in tool-allowlist enforcement.
4. `linear list` against a real team returns at least one issue (smoke test).
5. `linear comment CUR-X "test comment"` (no `--i-approve`) prints a preview and does NOT comment on Linear.
6. Same with `--i-approve` posts the comment and appends to `.pi/.linear-log.jsonl`.
7. `linear transition CUR-X in_review --i-approve` successfully changes state; the log entry contains accurate `before`/`after` state names.
8. `docs propose docs/PRD.md --rationale="add X section"` with a valid patch on stdin creates a file under `.pi/.doc-drafts/` and appears in `docs list`.
9. `docs apply <id> --i-approve` applies the patch, stages it, commits with the right trailers. `git log -1` shows `Proposed-By: steward` and `Approved-By: luci`.
10. `docs discard <id>` removes the draft from the active list.
11. Any `docs propose` for a path outside `docs/`, `specs/`, `specs/briefs/` is rejected.
12. `.pi/.linear-log.jsonl` and `.pi/.doc-drafts/` are in `.gitignore`.

## 5. Open questions / risks

- **Q1** — Exact Linear SDK method for workflow-state transition TBD; confirmed only at TDD. Fallback: raw GraphQL via `client.client.request(...)`.
- **Q2 — RESOLVED 2026-04-24:** briefs use `write` directly; BMad docs use the propose/apply flow.
- **Q3 — RESOLVED 2026-04-24:** `docs apply` mid-slice commits WITH `Spec-Slice` trailer; without if no slice open.
- **Q4 — RESOLVED 2026-04-24:** Steward's conclusion content is prefixed with `product:` for dialect separation.
