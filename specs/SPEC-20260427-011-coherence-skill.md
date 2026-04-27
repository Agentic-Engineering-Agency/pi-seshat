# SPEC-20260427-011 — coherence skill

## 1. Goal

A read-only, cross-source consistency checker that surfaces drift between Linear issue state, SpecSafe slice files, and commit `Spec-Slice:` trailers. No mutations, no `--i-approve` gate.

## 2. Scope and non-goals

**In scope:**

- `.omp/skills/coherence/SKILL.md` — skill descriptor with frontmatter + body.
- `.omp/skills/coherence/README.md` — model-facing usage doc.
- `.omp/skills/coherence/bin/coherence.ts` — Bun CLI with three subcommands:
  - `coherence check linear-vs-specs`
  - `coherence check trailers-vs-linear`
  - `coherence check brief-coverage`
- Test fixtures under `.omp/test/coherence/` (checked in, no secrets).

**Non-goals:**

- NO `--i-approve` flag (the skill is read-only).
- NO mutations to Linear issues, git history, or spec files.
- NO automatic Linear state changes.
- NO automatic file creation or modification.
- NO CostCounter token accumulation.
- NO MCP-server replacement.

This is a **code-bearing slice; test-writer step required**.

## 3. Constraints

- **Language:** TypeScript, executable via `bun run .omp/skills/coherence/bin/coherence.ts`.
- **Upstream dependency:** Must call the existing `linear` skill (`bun run .omp/skills/linear/bin/linear.ts`) for all Linear data access; do NOT import `@linear/sdk` directly.
- **Skill location:** `.omp/skills/coherence/bin/coherence.ts` + `SKILL.md` + `README.md`.
- **Auth:** `LINEAR_API_KEY` absence is a config error (exit 2), not a crash.
- **Repo context:** Must tolerate being run in a repo with no Linear integration.
- **Exit codes:** 0 = all clean, 1 = drift detected, 2 = config or usage error.
- **Output:** Plain text to stdout, one drift item per line, prefixed with a category tag in square brackets.

## 4. Decisions

1. **Trailer scan range defaults to `HEAD~50..HEAD`, overridable via `--range=`.**  
   Rationale: The push skill already scans a commit range for trailers; defaulting to 50 commits covers ~1–2 weeks of active work without unbounded history traversal. The `--range=` flag lets CI or manual runs adjust the window.

2. **Linear key extraction follows the github skill convention: regex `^([A-Z]+-[0-9]+)([-_].*)?$`.**  
   Rationale: DRY. Both branch names and spec filenames use `<KEY>-<slug>` or `<KEY>__<slug>` (e.g. `CUR-92-login-fix`, `CUR-92__login-fix`). Reusing the same regex prevents divergent matching logic.

3. **Spec-to-Linear matching uses KEY prefix equality, not exact string match.**  
   Rationale: Sub-slices exist (e.g. `CUR-008__auth`, `CUR-008__perf`) that all map to the same Linear ticket `CUR-008`. Prefix matching (`spec KEY starts with Linear KEY`) handles this naturally. Exact equality would falsely flag every sub-slice as orphan.

4. **Exit codes: 0 = clean, 1 = drift detected, 2 = config/usage error.**  
   Rationale: Consistent with unix conventions and the linear skill (which uses exit 2 for auth errors). Callers can distinguish "everything is fine" from "there is work to do" from "I couldn't even run."

5. **Output format: one drift item per line, prefixed with `[category]`.**  
   Rationale: Machine-greppable and human-readable. Categories: `[orphan-linear]`, `[orphan-spec]`, `[orphan-trailer]`, `[stale-trailer]`, `[orphan-brief]`. Example: `[orphan-linear] CUR-92 in_progress, no spec`.

6. **When `LINEAR_API_KEY` is absent, all subcommands exit 2 with a single-line stderr notice.**  
   Rationale: Mirrors the github skill's graceful degradation when Linear is unavailable. The notice must be exactly one line so it can be parsed by CI wrappers.

7. **Commits bearing multiple `Spec-Slice:` trailers use the LAST trailer.**  
   Rationale: Matches the push skill's semantic convention — the final trailer in a commit message represents the active slice at commit time. The `trailers-vs-linear` subcommand must extract trailers per commit and take the last value.

8. **`linear list` stdout is parsed as a fixed-width table.**  
   Rationale: The linear skill currently has no `--json` output mode. The coherence skill must parse the human-readable table (KEY in column 1, STATE in column 2). If the linear skill later gains `--json`, the coherence skill should switch to parsing JSON instead.

## 5. Acceptance criteria

1. `bun run .omp/skills/coherence/bin/coherence.ts check linear-vs-specs` executes without throwing when run against the test fixture repo under `.omp/test/coherence/fixture/`.
2. Given a fixture where Linear returns `CUR-92 in_progress` but `specs/CUR-92__*.md` does not exist, the command exits 1 and stdout contains exactly one line matching `^\[orphan-linear\] CUR-92`.
3. Given a fixture where `specs/CUR-92__login-fix.md` exists but Linear has no open ticket matching `CUR-92`, the command exits 1 and stdout contains exactly one line matching `^\[orphan-spec\] CUR-92`.
4. `bun run .omp/skills/coherence/bin/coherence.ts check trailers-vs-linear --range=HEAD~5..HEAD` parses a fixture commit history containing both commits with and without `Spec-Slice:` trailers without error.
5. Given a fixture where a commit has `Spec-Slice: CUR-92` but Linear `get CUR-92` returns state `triage`, the command exits 1 and stdout contains a line matching `^\[stale-trailer\]`.
6. `bun run .omp/skills/coherence/bin/coherence.ts check brief-coverage` matches Linear `in_progress`/`in_review` tickets against `specs/briefs/<KEY>*.md` by KEY prefix; a missing brief produces a line matching `^\[orphan-brief\]`.
7. When `LINEAR_API_KEY` is unset, every subcommand exits 2 and stderr contains the single-line notice `Linear integration unavailable: LINEAR_API_KEY not set.` (or equivalent one-line message).
8. Test fixtures and unit tests live under `.omp/test/coherence/` and are checked into the repo.
9. At least one unit test exercises each of the three subcommands via a mocked `linear` skill invocation.
10. The `coherence.ts` source does not contain any import from `@linear/sdk` (verified by `grep -r "@linear/sdk" .omp/skills/coherence/` returning empty).

## 6. Open questions and risks

- **Q1 — `linear list` table format fragility.** The upstream linear skill outputs a fixed-width text table. If column widths or ordering change, the parser breaks. **Mitigation:** add a `--json` flag to the linear skill and switch coherence to consume it; until then, the parser contract must be documented in `README.md` and unit-tested against a pinned fixture.
- **Q2 — Sub-slice edge case precision.** Prefix matching (`spec KEY starts with Linear KEY`) means `CUR-9` would match `CUR-92`. The regex `^([A-Z]+-[0-9]+)` guarantees the ticket number is fully consumed, but implementer should ensure prefix matching stops at word boundaries (e.g. `CUR-92__` or `CUR-92-`).
- **Q3 — Performance on large repos.** Scanning `HEAD~50..HEAD` and spawning `linear list` per invocation is fine for interactive use; for CI on repos with hundreds of open tickets, latency may be noticeable. **Mitigation:** the `--range=` flag already exists; future work could add `--team=` filter passthrough to `linear list`.
- **Q4 — Graceful degradation without Linear.** If a user runs coherence in a repo that has never had Linear set up, exit 2 with a notice is correct but may be noisy in pre-commit hooks. **Mitigation:** document that coherence is intended for repos with active Linear integration; hook usage is optional.
