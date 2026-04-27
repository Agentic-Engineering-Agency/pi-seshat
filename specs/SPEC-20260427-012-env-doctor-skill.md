# SPEC-20260427-012 — env-doctor skill

## 1. Goal

Provide a single-shot, read-only pre-flight verifier that an operator runs before every dogfood session. It checks that all external dependencies (Honcho, Linear, GitHub CLI, Oh My Pi) and local wiring (symlinks, state-file integrity) are present and functional, then prints a PASS/FAIL/SKIP checklist and exits with a deterministic code. No mutations, no `--i-approve` gate.

## 2. Scope and non-goals

**In scope:**

- One skill at `.omp/skills/env-doctor/` containing:
  - `bin/env-doctor.ts` — TypeScript CLI entry point
  - `SKILL.md` — usage contract for the model
- Eight checklist items evaluated in fixed order (§4.1).
- Text and JSON output modes (`--json`).
- `--strict` flag that elevates optional checks to required.
- Exit codes: 0 (all required passed), 1 (required failure), 2 (invocation error).

**Explicitly not in scope:**

- NO mutations to any file, env var, or remote resource.
- NO secret-file reads beyond what is needed for round-trip checks (e.g. do not read `~/.bashrc` to grep for API keys).
- NO writing the JSON/text report anywhere persistent — stdout only.
- NO integration with SpecSafe slice lifecycle (does not open/close slices).
- NO CostCounter or token accumulation.
- NO MCP server wrapper.

## 3. Constraints

- **Language:** TypeScript, executable via `bun run .omp/skills/env-doctor/bin/env-doctor.ts`. Shebang: `#!/usr/bin/env -S bun run`.
- **Skill location:** `.omp/skills/env-doctor/bin/env-doctor.ts` + `.omp/skills/env-doctor/SKILL.md`.
- **Required-var set:** The four variables checked in item (a) and (b) must be the exact same set as `REQUIRED_VARS` in `.omp/tools/honcho/index.ts` (lines 74-77):
  `HONCHO_API_KEY`, `HONCHO_WORKSPACE_ID`, `HONCHO_SESSION_ID`, `HONCHO_PEER_ID`.
- **Test seam:** The `main()` function must accept an injected `context` object so unit tests can stub `env`, `fs`, `spawn`, and `Honcho` client construction without touching globals.
- **Secret hygiene:** The skill must never emit the literal value of any `*_API_KEY` env var. Where length is relevant, print length (e.g. `"present (64 chars)"`); where only presence matters, print `"present"` or `"missing"`.
- **State-file parser reuse:** Items (g) and (h) must reuse the same parsing/corrupt-quarantine semantics as `readStateFileOrNull` from `.omp/hooks/specsafe-session.ts` (lines 77-95) for `.pi/.honcho-state.json`. For `~/.omp/agent/honcho.json`, parseability is a simple `JSON.parse` guarded by `try/catch`.
- **Exit-code contract:** 0 = all required checks passed (optional checks may have skipped), 1 = at least one required check failed, 2 = malformed invocation (unknown flags, missing subcommand, etc.).

## 4. Decisions

1. **Checklist items and order —** The eight checks run sequentially in this exact order so that the human reader sees the dependency chain bottom-up:
   - (a) `HONCHO_API_KEY` present + round-trip via `client.session(env.HONCHO_SESSION_ID).search('__envdoctor_probe__')`. Catches auth failures (401/403) and network errors. A 404 (session not found) is treated as PASS-with-note because the goal is auth round-trip, not session validation.
   - (b) `HONCHO_WORKSPACE_ID`, `HONCHO_SESSION_ID`, `HONCHO_PEER_ID` present. Peer existence is structural (env-only), not network-checked.
   - (c) `LINEAR_API_KEY` present + round-trip via Linear `viewer` query. Fallback: `linear list --limit=1` invocation that exits 0. If the key is absent, this check is skipped in non-strict mode.
   - (d) `gh` binary on PATH + `gh auth status` exits 0.
   - (e) `omp` binary on PATH + `omp config get` exits 0.
   - (f) The four symlinks `~/.omp/agent/{hooks,tools,agents,skills}` exist and resolve into `$PWD/.omp/<name>` (verified via `fs.realpath`).
   - (g) `.pi/.honcho-state.json` either does not exist OR parses cleanly via `readStateFileOrNull` and is mode 0600. If the file does not exist, the check is skipped in non-strict mode.
   - (h) `~/.omp/agent/honcho.json` either does not exist OR is mode 0600 + parseable. If the file does not exist, the check is skipped in non-strict mode.

2. **REQUIRED vs OPTIONAL classification —**
   - REQUIRED: (a), (b), (d), (e), (f). These are the minimal set needed for a functional dogfood session.
   - OPTIONAL (skip if the prerequisite env/file is absent): (c), (g), (h). A session without Linear access or without an open SpecSafe slice is still usable.
   - `--strict` flag elevates all OPTIONAL checks to REQUIRED. Under `--strict`, a missing `LINEAR_API_KEY` causes exit 1, not a SKIP line.

3. **`--strict` semantics —** When passed, every check classified as OPTIONAL in §4.2 is treated as REQUIRED. The output format is unchanged; only the exit code and the PASS/FAIL/SKIP labels shift (SKIP becomes FAIL for optional prerequisites that are absent).

4. **`--json` output format —** Emits a single JSON object to stdout:
   ```json
   {
     "ok": false,
     "exit": 1,
     "items": [
       { "id": "a", "label": "HONCHO_API_KEY round-trip", "status": "PASS", "detail": "..." },
       { "id": "b", "label": "Honcho env vars present", "status": "PASS", "detail": "..." }
     ]
   }
   ```
   The `ok` field is `true` iff the exit code would be 0. Each item contains `id` (a-h), `label`, `status` (`PASS` | `FAIL` | `SKIP`), and `detail` (human-readable string, never containing a secret value).

5. **Exit-code rules —**
   - 0: all REQUIRED checks passed. OPTIONAL checks may have skipped.
   - 1: at least one REQUIRED check failed. This includes OPTIONAL checks that were elevated by `--strict`.
   - 2: invocation error — unknown flags, missing required arguments to a subcommand, or internal unhandled exception.

## 5. Acceptance criteria

1. Running `bun run .omp/skills/env-doctor/bin/env-doctor.ts` with **no env vars set** produces FAIL for checks (a), (b), (d), (e) and SKIP for (c), (g), (h); exits 1.
2. Running the skill with **full valid env** on this repo (all four symlinks in place, `gh` and `omp` on PATH, valid `HONCHO_API_KEY`, valid `LINEAR_API_KEY`) produces all PASS and exits 0.
3. Running with `--json` produces output that parses as valid JSON; the top-level object has boolean `ok`, integer `exit`, and array `items`; each item in `items` has string fields `id`, `label`, `status`, `detail`.
4. The symlink check (f) correctly distinguishes `realpath` resolving **into** `$PWD/.omp/<name>` versus resolving elsewhere: if `~/.omp/agent/hooks` resolves to `/some/other/path/.omp/hooks`, the check FAILs.
5. The honcho round-trip (a) uses a non-existent search query (`__envdoctor_probe__`) and treats HTTP 401/403 as FAIL, but treats a 404 or "session not found" response as PASS with note "auth OK (session not found)". The note must not contain the API key.
6. The unit-test suite contains **at least one test per checklist item** (a-h) using stubbed `env`, `fs`, and `spawn` (or equivalent test seams), with no live network calls in the default test run.
7. Running with `--strict` and a missing `LINEAR_API_KEY` produces FAIL for check (c) and exits 1, instead of SKIP.
8. No emitted output (text or JSON) contains the literal value of `HONCHO_API_KEY` or `LINEAR_API_KEY`; verification is a string scan of captured stdout/stderr for the literal key value.

## 6. Open questions and risks

- **`gh auth status` multi-host ambiguity.** `gh auth status` exits 0 when at least one host is authenticated, even if others are not. The skill treats exit 0 as PASS. If the operator uses GitHub Enterprise or multiple accounts, the check may pass on the wrong host. **Mitigation:** document in `SKILL.md` that the check validates "at least one authenticated GitHub host"; do not attempt to parse `gh auth status` stdout for host names.
- **Honcho API key in error surfaces.** The honcho probe (a) must sanitize the API key from any error message before displaying it. Mirror `sanitizeErrorForDisplay` from `.omp/tools/honcho/index.ts` (lines 69-73): split the error text on the key value and replace with `<redacted>`.
- **Concurrent session collision.** Running `env-doctor` while `omp` itself is running could cause both processes to query the same Honcho session concurrently. **Mitigation:** the probe query is read-only and ephemeral (a single `search` call with a probe string). It does not write messages, conclusions, or mutate session state. Document this in `SKILL.md`.
- **Secret leakage via `detail` fields.** Even with the sanitization helper, a misconfigured Honcho client could embed the API key in an unexpected field (e.g. a `baseURL` override that includes credentials). The skill must never log the `env` object or any raw SDK error detail directly; only the sanitized message string may appear in `detail`.
- **Code-bearing slice; test-writer step required.**
