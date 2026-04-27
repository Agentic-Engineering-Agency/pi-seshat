# SPEC-20260427-015 — SKILL.md and JSDoc path consolidation (.pi/ → .omp/)

## 1. Goal

Sweep `.pi/skills/<name>/...` references out of operator-facing
documentation (SKILL.md "Example invocation" blocks, JSDoc headers in
skill bin scripts, README example blocks) so that a fresh reader of a
skill's docs sees the post-cutover canonical path. Slice-008.4 cut
dispatch over to `omp` and slice-013 swept README.md/CLAUDE.md, but the
six skill SKILL.md files retained their pre-cutover invocation examples
pointing at `bun run .pi/skills/<name>/bin/<name>.ts`.

This spec is a backfill, written after the implementation landed in
commit `4f8075f` (2026-04-27). The work was small enough to execute
inline without a pre-authored spec; the trailer was written first and
this file is the documented retroactive contract.

## 2. Scope and non-goals

In scope:
- SKILL.md "Example invocation" code blocks for the six skills (`docs`,
  `github`, `latest-docs`, `linear`, `memory`, `push`).
- JSDoc file-header invocation comments inside `.omp/skills/<name>/bin/<name>.ts`
  for `docs`, `linear`, `memory` (the three with such headers).
- README example blocks under `.omp/skills/memory/README.md`.
- Test-name strings inside `.omp/skills/latest-docs/test/latest-docs.test.ts`
  and `.omp/skills/linear/test/linear.test.ts` that quote `.pi/`-rooted
  paths in test labels (these test files are not run by the
  `package.json` test glob but the labels are doc-correct after the
  rewrite).
- Cache-display path `.pi/.docs-cache/` → `.omp/.docs-cache/` inside
  `.omp/skills/latest-docs/SKILL.md` (display only — does not change
  where `latest-docs.ts` actually writes).

Explicitly out of scope (slice-009 territory; A8 rollback invariant
from MIGRATION.md):
- The cache-write path inside `.omp/skills/latest-docs/bin/latest-docs.ts`.
- The registry-read path at `.omp/skills/latest-docs/bin/latest-docs.ts:84`
  and the matching path in `.omp/skills/latest-docs/bin/probe-registry.ts`.
- The linear-skill subprocess invocation paths in
  `.omp/skills/github/bin/github.sh:245,332`.
- `.pi/.honcho-state.json` — the slice-state file the omp hooks share
  with the vanilla-Pi extensions.
- `.pi/extensions/` — the rollback hatch.
- `.pi/.{push,linear,github,docs-registry,fallback}-log.jsonl` audit-log
  write paths in the bin scripts.

## 3. Constraints

- Pure documentation. No behavioral changes. Tests MUST stay at
  271 pass / 15 skip / 0 fail (the slice-014 baseline).
- Where a JSDoc/comment line accurately describes what the code
  actually does (e.g. the cache-write path at runtime is `.pi/.docs-cache/`),
  the comment MUST stay accurate to the code. Rewriting the doc to lie
  about the code is forbidden.
- Slice carries a `Spec-Slice: SPEC-20260427-015` trailer on its single
  commit.

## 4. Decisions

1. **Markdown-only slice; test-writer step skipped per the documented
   SpecSafe deviation.** §5 acceptance criteria are the verification
   contract.

2. **Conservative `sed` substitution scoped to JSDoc comment lines and
   `.md` files.** Inside `.ts` files the substitution only triggers on
   lines beginning with `\s*\*` (i.e. JSDoc continuation lines); never
   on code paths inside string literals.

3. **Two cache-display references in the latest-docs skill stay split.**
   `latest-docs/SKILL.md` § "Cache layout" is rewritten to
   `.omp/.docs-cache/` (operator-facing). `latest-docs.ts:20` JSDoc
   stays `.pi/.docs-cache/` because the runtime write site at
   `latest-docs.ts:~256` still writes there. When slice-009 rewrites
   the runtime write site, the JSDoc updates with it.

4. **Four `.pi/` references survive deliberately and are not bugs:**
   - `.omp/skills/github/bin/github.sh:245` — calls
     `bun run "$REPO_ROOT/.pi/skills/linear/bin/linear.ts" get $key`.
     Real subprocess invocation. Switching it requires confirming the
     `.omp/` copy of `linear.ts` has byte-equivalent behavior.
     Slice-009 work item.
   - `.omp/skills/github/bin/github.sh:332` — operator hint string
     `./.pi/skills/linear/bin/linear.ts transition ... --i-approve`.
     Documented as the canonical invocation; flips when (a) above flips.
   - `.omp/skills/latest-docs/bin/probe-registry.ts:14` — JSDoc
     describing what the code at line 48 actually does
     (`REGISTRY_PATH = path.join(cwd, ".pi", "skills", ...)`).
     Accurate to the code; flips when slice-009 consolidates registry.
   - `.omp/skills/latest-docs/bin/latest-docs.ts:20` — JSDoc describing
     the runtime cache-write path. Same contract as (3) above.

## 5. Acceptance criteria

1. `grep -rEn '\.pi/skills/' .omp/skills/` returns exactly three lines:
   the two `github.sh` invocation/hint lines plus the JSDoc line in
   `probe-registry.ts:14` (§4.4 first three bullets). The fourth
   exception (`latest-docs.ts:20` JSDoc for `.pi/.docs-cache/`) is
   covered separately by C6 below because it matches a different
   pattern (`\.pi/\.docs-cache`).
2. `grep -rEn '\.pi/skills/' .omp/skills/{docs,linear,memory,push}/` returns empty.
3. `grep -nE '\.pi/skills/' .omp/skills/latest-docs/SKILL.md` returns empty.
4. `grep -nE '\.pi/skills/' .omp/skills/github/SKILL.md` returns empty.
5. `grep -nE '\.pi/\.docs-cache' .omp/skills/latest-docs/SKILL.md` returns empty.
6. `grep -nE '\.pi/\.docs-cache' .omp/skills/latest-docs/bin/latest-docs.ts`
   returns exactly one match (the JSDoc line at ~20, accurate to the
   runtime write site).
7. All seven persona files in `.omp/agents/` are unchanged by this slice
   (slice-010 was the persona slice; slice-015 does not touch personas).
8. Full suite: `bun run test` reports 271 pass / 15 skip / 0 fail.
9. Type check: `bun run typecheck` clean.
10. Single commit on the branch carries `Spec-Slice: SPEC-20260427-015`.

## 6. Open questions and risks

- **Registry duplication is still latent.** This slice does not
  consolidate `.pi/skills/latest-docs/registry.json` and
  `.omp/skills/latest-docs/registry.json` into a single source. Edits
  to the `.omp/` copy are silently ignored under `omp` because
  `latest-docs.ts:84` reads only the `.pi/` copy. Mitigation outside
  this slice: a footgun comment in both `_meta.note` blocks
  (committed separately as a chore) describes the asymmetry. Full fix
  is slice-009 work.

- **JSDoc lag.** Two JSDoc lines (`probe-registry.ts:14`,
  `latest-docs.ts:20`) still describe `.pi/`-rooted paths because the
  code at those line numbers writes there. When slice-009 moves the
  runtime paths, those JSDoc lines update in the same commit. The risk
  is forgetting the JSDoc update at slice-009 time; mitigation is the
  §4.4 enumeration above acting as a checklist.

- **Branch under fix/omp-function-path.** This slice committed onto a
  pre-existing branch whose original commit (7c7bb7e) was unrelated to
  the audit. Branch hygiene is cosmetic; the PR title and description
  are what reviewers see.
