# SPEC-20260427-009 — omp slice-lifecycle entry

## 1. Goal

Provide a standalone CLI entry point under `.omp/skills/specsafe/bin/specsafe.ts` that opens, closes, and reports the status of SpecSafe slices under the Oh My Pi runtime. Without this, `.omp/hooks/specsafe-subagents.ts:133` short-circuits on `!slice` and the auto-commit-with-trailers machinery silently no-ops — every Ghola dispatch under `omp` commits without `Spec-Slice:` trailers.

## 2. Scope and non-goals

In scope:
- A single TypeScript CLI `.omp/skills/specsafe/bin/specsafe.ts` with three subcommands: `begin`, `end`, `status`.
- State-file read/write that preserves the bit-identical `StateFile`/`CurrentSlice`/`HistoryEntry`/`CostCounter` shapes from `.omp/hooks/specsafe-session.ts`.
- Corrupt-state-file quarantine matching `readStateFileOrNull` semantics.
- Idempotency: `begin` refuses when a slice is already open; `end` refuses when none is open.
- Unit tests under `.omp/test/` exercising all three commands plus edge cases.

Not in scope:
- Honcho session creation (the CLI writes a session id passed as an argument, same as the vanilla tools).
- CostCounter mutation (the counter shape is preserved at zeroes, matching the port's no-mutation stance per `PORT-NOTES.md:23-28`).
- MCP-server or CustomToolFactory surface (shape (b) was evaluated and rejected; see §4.1).
- Changes to `.pi/extensions/specsafe-session/index.ts` or vanilla Pi behavior.

## 3. Constraints

- State-file path: `.pi/.honcho-state.json` relative to `process.cwd()`, via `statePathFor(cwd)` from `.omp/hooks/specsafe-session.ts`.
- Exact types that MUST round-trip with `readStateFileOrNull`:
  - `CostCounter`: `{ honchoCalls: number; honchoCost: number; subagentTokens: { input, output, cacheRead, cacheWrite, cost, turns: number } }`
  - `CurrentSlice`: `{ id, workspaceId, sessionId, beganAt, costCounter }`
  - `HistoryEntry`: `{ sliceId, workspaceId, sessionId, beganAt, endedAt, outcome: "PASS"|"FAIL"|"ABANDONED", costSummary }`
  - `StateFile`: `{ currentSlice: CurrentSlice|null, history: HistoryEntry[] }`
- File mode MUST be `0o600` after every write.
- The CLI MUST produce JSON output that is byte-identical in shape to what `.pi/extensions/specsafe-session/index.ts` writes, so `readStateFileOrNull` in the omp hook continues to parse it without change.
- The CLI is code-bearing; test-writer step is REQUIRED.

## 4. Decisions

1. **Shape: standalone CLI under `.omp/skills/specsafe/bin/specsafe.ts`.** Rejected (b) restoring tools as a `CustomToolFactory` because no in-process integration is needed — slice management is an operator-level action, not a model-level tool call. Rejected (c) dual-run because it defeats the purpose of running under `omp`. The CLI pattern mirrors existing `.omp/skills/*/bin/*.ts` skills (`latest-docs`, `memory`, `linear`) and is ~40 LOC. It can be exercised from a terminal alongside `omp` without touching the hook or tool surface.

2. **Language: TypeScript via `bun run` shebang.** Rejected Bash because the existing port surface is entirely TypeScript; using TS ensures shape-fidelity with the existing `StateFile` types imported from `.omp/hooks/specsafe-session.ts` and avoids manual JSON construction errors. The shebang is `#!/usr/bin/env -S bun run` matching `latest-docs.ts` and `memory.ts`.

3. **Command surface:**
   - `specsafe begin <slice-id> <workspace-id> <session-id>` — writes `currentSlice` with `beganAt = new Date().toISOString()` and a fresh zeroed `costCounter`. Preserves existing `history`.
   - `specsafe end <PASS|FAIL|ABANDONED>` — moves `currentSlice` to `history` with `endedAt` and the supplied outcome, then sets `currentSlice = null`.
   - `specsafe status` — prints "OPEN: <slice-id>" or "no slice open", plus history count.
   - Any unknown subcommand or missing required argument exits non-zero with usage text.

4. **Corrupt-state-file handling:** Same quarantine semantics as `readStateFileOrNull`: on any parse failure, rename the file to `<path>.corrupt-<timestamp>` (best-effort), then treat as empty state (`{ currentSlice: null, history: [] }`). This ensures the CLI never crashes on a malformed file.

5. **Idempotency and atomic write:**
   - `begin` when `currentSlice !== null` MUST print an error to stderr and exit with code 1.
   - `end` when `currentSlice === null` MUST print an error to stderr and exit with code 1.
   - Writes MUST be atomic: write to `<path>.tmp-<pid>-<timestamp>` then `renameSync` to the target, matching the vanilla `writeStateFile` pattern. This also mitigates races with `bumpHonchoCallCounter` (§6).

## 5. Acceptance criteria

1. Running `bun run .omp/skills/specsafe/bin/specsafe.ts begin TEST-001 ws-abc sess-123` in a fresh repo creates `.pi/.honcho-state.json` with `currentSlice.id === "TEST-001"`, `currentSlice.workspaceId === "ws-abc"`, `currentSlice.sessionId === "sess-123"`, a valid ISO `beganAt`, zeroed `costCounter`, and empty `history`.
2. After (1), running `bun run .omp/skills/specsafe/bin/specsafe.ts end PASS` moves the slice to `history[0]` with `outcome === "PASS"`, a valid `endedAt`, `currentSlice === null`, and `history.length === 1`.
3. Running `bun run .omp/skills/specsafe/bin/specsafe.ts status` when a slice is open prints a line containing `OPEN: TEST-001`; when no slice is open prints a line containing `no slice open`.
4. Running `begin` a second time while a slice is open exits with code 1 and prints an error containing `already open`.
5. Running `end` with no open slice exits with code 1 and prints an error containing `no slice open`.
6. The state file written by the CLI is parseable by `readStateFileOrNull` imported from `.omp/hooks/specsafe-session.ts` without throwing, and the returned object deep-equals the CLI's internal state.
7. After every write, `stat -c '%a' .pi/.honcho-state.json` (or `fs.statSync` in tests) returns `600`.
8. At least one unit test under `.omp/test/` exercises each of criteria (1)–(7) in isolation using temporary directories.
9. Given a corrupt `.honcho-state.json` (invalid JSON), the CLI quarantines it (file is renamed to `.corrupt-<timestamp>`), treats state as empty, and allows `begin` to succeed.

## 6. Open questions and risks

- **Coexistence with vanilla Pi's `specsafe_begin/end/status` tools.** Both the vanilla extension and this CLI write the same `.pi/.honcho-state.json` file. Both MUST produce structurally identical JSON so that whichever runtime is active can read what the other wrote. The acceptance criterion (6) covers the omp→omp round-trip, but there is no automated test for pi→omp or omp→pi cross-reading. The implementer MUST verify this manually or add a cross-parity test.

- **Race with `bumpHonchoCallCounter` in `.omp/tools/honcho/index.ts:133`.** That function does a read-modify-write of the same state file on every Honcho tool call. It does NOT use atomic rename (it calls `writeFileSync` directly). The CLI's atomic write (tmp+rename) is the mitigation: in the worst case `bumpHonchoCallCounter` overwrites a just-written CLI state, or the CLI overwrites a just-bumped counter. This is accepted as best-effort consistency — the counter is advisory and never blocks a tool call (documented at `index.ts:133-136`). If races become observable in practice, the fix is to add a file lock or a serialize-write queue; this spec does not require it.
