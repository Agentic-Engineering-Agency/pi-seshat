# SPEC-20260427-014 — latest-docs registry URL probe

## 1. Goal

Produce a one-shot (or run-on-demand) script that probes every `verified: false`
entry in the `latest-docs` registry by exercising the existing
`latest-docs fetch <lib>` command, flips `verified: true` on HTTP success,
logs failures with their status codes, and writes an audit-log entry per
probed library. The script is idempotent: running it twice produces no diff
on the second run.

## 2. Scope and non-goals

In scope:
- A single TypeScript script at `.omp/skills/latest-docs/bin/probe-registry.ts`.
- Dry-run mode (default): prints a deterministic diff preview and exits 0.
- Apply mode (`--apply`): writes the updated registry atomically.
- Sequential probing of all 11 unverified entries.
- Audit-log append to `.pi/.docs-registry-log.jsonl`.

Not in scope:
- **Do NOT make this a permanent subcommand of `latest-docs`.** The audit
elevates it as a one-shot probe; if it earns permanence later, that's a
follow-up slice.
- **Do NOT add `--i-approve`.** Probing is read-only against the network;
the only mutation is flipping `verified` flags in the registry file, which
is config-only and the script should preview-then-apply with explicit
confirmation (`--apply`).
- Do NOT auto-repair dead URLs (change the `url` field). The script only
mutates the `verified` boolean.
- Do NOT probe entries already marked `verified: true`.

This is a **config-only slice; test-writer step skipped per documented
SpecSafe deviation.**

## 3. Constraints

- The script **MUST** use the existing `latest-docs fetch <lib>` command
  (NOT a parallel HTTP client — DRY). It shells out to
  `bun run .omp/skills/latest-docs/bin/latest-docs.ts fetch <lib>` and
  inspects the exit code.
- It **MUST** distinguish HTTP success (`exit 0` → write `verified: true`)
  from HTTP failure (`exit 2` or network error → leave `verified: false`,
  log status).
- It **MUST** be idempotent: running twice in a row without intervening
  registry changes produces an empty diff on the second run.
- The script **MUST** read from and write to `.pi/skills/latest-docs/registry.json`
  (the same path the skill uses), not `.omp/skills/latest-docs/registry.json`.
- Registry write **MUST** be atomic (write to a temp file, then `fs.renameSync`).
- The script **MUST** preserve `_meta` block verbatim and preserve key
  ordering in `registry.json`.

## 4. Decisions

1. **Script location:** `.omp/skills/latest-docs/bin/probe-registry.ts`.
   Rationale: colocated with the skill it exercises; not a standalone skill
   of its own.

2. **Invocation:** `bun run .omp/skills/latest-docs/bin/probe-registry.ts [--apply]`.
   Without `--apply`, prints a deterministic diff preview ( unified-diff or
   key-by-key summary) and exits 0. With `--apply`, writes the registry.
   Rationale: read-only by default; mutation requires explicit opt-in.

3. **Failure handling:** collect ALL failures, report them at end with their
   status codes, then exit 0 if `--apply` succeeded (some failures are
   expected on a real network). Do NOT short-circuit on the first failure.
   Rationale: a single transient 403 from GitHub raw should not mask the
   state of the other 10 entries.

4. **Registry write:** atomic via temp-file + rename. Preserve key ordering
   by iterating `Object.keys(originalRegistry)` when building the output
   object. Preserve `_meta` block by copying it verbatim before iterating
   entries. Rationale: avoids corrupting the registry on crash; keeps the
   file human-readable and diff-stable.

5. **Audit log:** append one JSON line per probed entry to
   `.pi/.docs-registry-log.jsonl` with shape:
   ```json
   {"ts":"2026-04-27T12:00:00.000Z","action":"probe","lib":"hono","exit":0,"verified_flipped":true}
   ```
   Rationale: mirrors the existing audit-log pattern from `register --i-approve`
   and gives a traceable record of what the probe observed.

## 5. Acceptance criteria

1. **Dry-run produces deterministic diff.** Running the script without
   `--apply` prints a preview of which entries would be flipped to
   `verified: true` and which would remain `verified: false`, then exits 0.
   The registry file on disk is unchanged.

2. **Apply flips verified on success.** Running with `--apply` sets
   `verified: true` for every entry whose `latest-docs fetch <lib>` exits 0,
   and leaves `verified: false` for entries whose fetch exits non-zero.

3. **`_meta` block preserved verbatim.** After `--apply`, the `_meta` key
   in `.pi/skills/latest-docs/registry.json` contains exactly the same
   object (including field order) as before the run.

4. **Key ordering preserved.** After `--apply`, the key sequence in
   `.pi/skills/latest-docs/registry.json` is identical to the pre-run
   sequence (verified by `diff <(jq -S 'keys' before.json) <(jq -S 'keys' after.json)`
   returning empty, or equivalent).

5. **Audit log gets one line per probed entry.** After `--apply`,
   `.pi/.docs-registry-log.jsonl` contains one new JSON line for each
   library that was probed (i.e. each `verified: false` entry). Each line
   has `action: "probe"`, the library name, the fetch exit code, and a
   boolean indicating whether `verified` was flipped.

6. **Idempotency.** Running the script twice in a row with `--apply`
   produces no diff on the second run (the diff preview is empty and no
   additional audit-log lines are written).

7. **Empirical observation.** The validator's run of the actual probe
   observes at least one entry either (a) flipped from `verified: false`
   to `verified: true`, or (b) remaining `verified: false` with a logged
   non-zero exit code. The validator reports which outcome occurred.

## 6. Open questions and risks

- **GitHub raw rate limiting.** Three entries point at
  `raw.githubusercontent.com` (`@honcho-ai/sdk`, `@linear/sdk`,
  `@libsql/client`, `zod`). GitHub raw is rate-limited. The script probes
  sequentially (not in parallel) to avoid triggering the limit on a burst
  of 11 requests.

- **Do not flip `true → false` on transient failure.** If a URL was
  previously `verified: true` and a later probe fails (network blip),
  the script MUST NOT overwrite it back to `false`. The script only ever
  flips `false → true`; it never downgrades a previously verified entry.

- **Cache side-effect is by design.** `latest-docs fetch <lib>` writes
  cache files under `.pi/.docs-cache/<lib>/` as a side effect. The probe
  intentionally exercises the full fetch path including conversion and
  caching; this is not a bug.
