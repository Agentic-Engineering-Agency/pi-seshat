---
id: SPEC-20260424-001
slug: pi-honcho-bridge-v1
slice: 1 of 6
title: Pi ↔ Honcho memory bridge + SpecSafe session lifecycle + subagent env/commit patch
status: approved
author: seshat (drafted by orchestrator on behalf of luci)
created: 2026-04-24
linear: n/a (meta-project; no Linear ticket)
---

# SPEC-001 — Pi ↔ Honcho Bridge (v1)

## 1. Goal

Give Pi durable, peer-scoped memory backed by Honcho, threaded automatically through every subagent spawn, with a SpecSafe-aware session lifecycle and git-based traceability for every successful subagent action. After this slice lands, an orchestrator (Seshat) can open a spec slice, dispatch Gholas, and each Ghola reads/writes shared memory under a distinct peer identity without ever being told the session or workspace ID in prompt.

## 2. Why this first

Every other planned slice (Linear skill, Steward agent, AGENTS.md rewrite, doc-scout, theme) depends on (a) session identity being resolvable from the environment and (b) memory reads/writes being available as tools. Spec 001 is the load-bearing floor; nothing else compiles without it.

## 3. Scope

In scope:

- New extension `.pi/extensions/honcho/` registering 4 tools: `honcho_recall`, `honcho_search`, `honcho_remember`, `honcho_conclude`.
- New extension `.pi/extensions/specsafe-session/` registering 3 tools: `specsafe_begin`, `specsafe_end`, `specsafe_status`. Owns `.pi/.honcho-state.json` (0600, JSON, lock-protected).
- Patch to existing `.pi/extensions/specsafe-subagents/index.ts` — inject `HONCHO_*` + `SPECSAFE_SLICE_ID` env into child processes and auto-commit on successful child exit with trailer metadata.
- `bun test` suite under `.pi/extensions/honcho/test/` and `.pi/extensions/specsafe-session/test/` exercising real network against the `pi-dev-sandbox` Honcho workspace.
- README for each new extension (Pi skills-style — the model reads this to understand the tool).

Explicitly not in scope (deferred slices):

- `steward` agent, `linear` skill, `github` skill, `docs` skill, `push` skill, `memory` skill — slices 3–5.
- `AGENTS.md` rewrite, `doc-scout` agent, agent-body honcho directives — slice 2 & 6.
- Theme / prompt prefix — optional, post-v1.
- Multi-slice concurrency (parallel open sessions) — v2.
- Cache layer over Honcho reads — v2.
- Secret migration from `~/.bashrc` to Wrangler/1Password — deferred until Pi runs outside this laptop.
- Extraction to an `@agentic-engineering/pi-honcho` npm package — post-stability.

## 4. Non-goals

- Replacing Pi's session JSONL file. Honcho is long-term memory; `~/.pi/agent/sessions/` remains the short-term transcript.
- Offering conclusion-approval UI. Git log + validator-only writes are the audit surface.
- Writing a MCP bridge. Pi does not speak MCP by design.
- Supporting Bash-only environments. This project targets Bun + TypeScript on Arch.

## 5. Implementation constraints

### 5.1 Runtime & deps

- Bun-native TypeScript, no bundler, no transpile step. Pi loads `.ts` via `@mariozechner/jiti`.
- Add one runtime dependency: `@honcho-ai/sdk` (latest). No other new deps.
- Dev dep: `@types/bun` if needed for the test files.

### 5.2 Identity flow

- All peer/session/workspace identity is read from environment variables **at tool-call time**, never at module-load time. This is load-bearing — it lets the orchestrator switch slices without reloading Pi.
- Required env vars at tool-call time: `HONCHO_API_KEY`, `HONCHO_WORKSPACE_ID`, `HONCHO_SESSION_ID`, `HONCHO_PEER_ID`.
- Optional: `HONCHO_BASE_URL` (for sandbox/self-hosted override).
- Optional: `SPECSAFE_SLICE_ID` (for commit trailers; may differ from session id if we ever split them).
- Missing required env → tool returns `{ isError: true, content: [...] }` with an explicit message naming the missing variable. No silent degradation, no "best effort."

### 5.3 State file

- Path: `<project-root>/.pi/.honcho-state.json`. `.gitignore` entry added in this slice.
- Mode: `0600` (writable only by owner).
- Writes go through `withFileMutationQueue` (already imported by `specsafe-subagents`) to avoid torn writes under concurrent tool calls.
- Shape:
  ```json
  {
    "currentSlice": {
      "id": "SPEC-20260424-001" | "CUR-92__login-password-reset",
      "workspaceId": "pi-dev-sandbox",
      "sessionId": "<honcho-returned-session-id>",
      "beganAt": "ISO-8601 UTC",
      "costCounter": {
        "honchoCalls": 0,
        "honchoCost": 0,
        "subagentTokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0, "turns": 0 }
      }
    } | null,
    "history": [
      {
        "sliceId": "string",
        "workspaceId": "string",
        "sessionId": "string",
        "beganAt": "ISO-8601 UTC",
        "endedAt": "ISO-8601 UTC",
        "outcome": "PASS" | "FAIL" | "ABANDONED",
        "costSummary": { /* same shape as costCounter */ }
      }
    ]
  }
  ```
- The file MAY be absent (means no slice open). Tools handle that branch explicitly, not via exceptions.

### 5.4 Tool contracts

All tools follow Pi's convention: `{ content: [{type:"text", text}], details?, isError? }`.

#### `honcho_recall({ query, target?, scope? })`
- `scope`: `"session"` (default) | `"peer"` | `"workspace"`.
- `target`: optional peer ID to query about (theory-of-mind); defaults to self (no target).
- Maps to `peer.chat(query, { target, sessionId: scope==="session" ? state.sessionId : undefined })`.
- Returns the natural-language answer as `text`; full response object in `details`.

#### `honcho_search({ query, scope?, limit? })`
- `scope`: `"session"` (default) | `"peer"` | `"workspace"`.
- `limit`: default 10, max 50.
- Maps to `peer.search()` / `session.search()` depending on scope.
- Returns top-k hits as a formatted text block; raw hits in `details`.

#### `honcho_remember({ content, role? })`
- `role`: `"assistant"` (default) | `"user"`. The peer speaking is always `HONCHO_PEER_ID`.
- Maps to `session.addMessages([peer.message(content)])`.
- Returns `{text: "remembered"}` + message ID in `details`.

#### `honcho_conclude({ content })`
- **Restricted tool.** Executes the write only if `HONCHO_PEER_ID ∈ { "validator", "reviewer", "steward" }`.
- On unauthorized peer: returns `isError: true`, `text: "peer <id> is not permitted to write conclusions"`. Does not call Honcho.
- Maps to the Honcho conclusion-create endpoint. Exact SDK method name to be verified at TDD step against `@honcho-ai/sdk`'s generated types.
- Returns conclusion ID in `details`.

#### `specsafe_begin({ sliceId, workspaceId? })`
- Creates a new Honcho session (or resumes if `sliceId` already in history — see open question Q3).
- `workspaceId` defaults to the value of `HONCHO_WORKSPACE_ID` env or fails if neither is set.
- Writes `currentSlice` to state file. Fails if `currentSlice` is already populated (one open slice at a time — v1 invariant).
- Returns the new `sessionId`.

#### `specsafe_end({ outcome })`
- `outcome`: `"PASS"` | `"FAIL"` | `"ABANDONED"`.
- Appends `currentSlice` (enriched with `endedAt` + `outcome`) to `history`, clears `currentSlice`.
- Does NOT delete the Honcho session — memory persists; this is just local lifecycle state.

#### `specsafe_status({})`
- Returns current slice + summary of recent history entries. Read-only. No env or file writes.

### 5.5 Subagent extension patch

- File: `.pi/extensions/specsafe-subagents/index.ts`, function `runAgent`.
- Change 1 — env injection. On `spawn`:
  ```ts
  const state = readState();  // tolerant: returns null if no slice open
  const childEnv = {
    ...process.env,
    HONCHO_PEER_ID: agent.name,
    ...(state ? {
      HONCHO_WORKSPACE_ID: state.currentSlice.workspaceId,
      HONCHO_SESSION_ID: state.currentSlice.sessionId,
      SPECSAFE_SLICE_ID: state.currentSlice.id,
    } : {}),
  };
  spawn(invocation.command, invocation.args, { cwd, shell: false, stdio: [...], env: childEnv });
  ```
- Change 2 — auto-commit on success. After `resolve(code)`:
  ```ts
  if (code === 0 && state) {
    await commitSubagentWork({
      agent: agent.name,
      sliceId: state.currentSlice.id,
      sessionId: state.currentSlice.sessionId,
      message: oneLineSummary(result.messages),
    });
  }
  ```
- `commitSubagentWork` uses `git add -A && git -c commit.gpgsign=<user-setting> commit -m "<agent>: <summary>" --trailer "Co-Authored-By: <agent> <agent@seshat.local>" --trailer "Spec-Slice: <id>" --trailer "Peer: <agent>" --trailer "Session: <sessionId>"`.
- No-op if `git status --porcelain` is empty.
- Failure of commit MUST NOT fail the subagent call — log stderr, continue.
- Never runs `git push`.

### 5.6 Cost counter

- Every `honcho_*` tool call increments `currentSlice.costCounter.honchoCalls` by 1 and adds returned cost (if provided by SDK) to `honchoCost`.
- Every subagent return in `specsafe-subagents` adds the child's usage stats to `currentSlice.costCounter.subagentTokens`.
- Counter is flushed to disk on each increment (inside the file-mutation queue). Cheap because writes are small.
- `specsafe_end` rolls the counter into the `costSummary` of the archived history entry.

### 5.7 Security

- `.honcho-state.json` mode 0600, owner-only.
- `.pi/.doc-drafts/`, `.pi/.push-log.jsonl`, `.pi/.linear-log.jsonl`, `.pi/.github-log.jsonl` — reserved for future slices; add to `.gitignore` pre-emptively in this slice to avoid cross-slice churn.
- API key read from `process.env.HONCHO_API_KEY`. Never logged. Never written to state file.
- Tool result text must not echo the API key even if the SDK error message embeds it — sanitize error messages before returning.

### 5.8 Error semantics

- Network failure to Honcho → `isError: true` with `text: "honcho unreachable: <stderr>"`. No retries in v1 (simpler; Pi user can retry manually).
- Unauthorized `honcho_conclude` → see 5.4.
- Missing env → see 5.2.
- State file corruption on read → log the error, return `currentSlice: null` as if no slice open. Preserve the corrupt file at `.pi/.honcho-state.json.corrupt-<timestamp>` for forensics.

## 6. Acceptance criteria

Each MUST be demonstrable before the slice is PASSed by the validator.

1. `bun install` in the project root completes with `@honcho-ai/sdk` resolved; no other new runtime deps.
2. Launching `pi` from the project root shows both `honcho` and `specsafe-session` in the startup extensions list.
3. Calling `specsafe_begin({ sliceId: "TEST-001", workspaceId: "pi-dev-sandbox" })` creates a Honcho session and produces `.pi/.honcho-state.json` with mode `0600` containing a non-empty `currentSlice.sessionId`.
4. Calling `specsafe_begin` again without an intervening `specsafe_end` returns `isError: true, text: "slice already open: <id>"`.
5. Calling `honcho_remember({content: "hello from luci"})` with env `HONCHO_PEER_ID=luci` succeeds; a subsequent `honcho_search({query: "hello"})` returns the content within 10 seconds (latency budget — Honcho-side indexing).
6. Calling `honcho_conclude({content: "x"})` with `HONCHO_PEER_ID=implementer` returns `isError: true` and does not create a Honcho conclusion.
7. Same call with `HONCHO_PEER_ID=validator` succeeds; the returned conclusion ID resolves via the SDK's list-conclusions endpoint.
8. Spawning any registered subagent via the patched `subagent` tool while a slice is open produces a new git commit on the current branch when the child exits 0 and the working tree was changed. Commit message begins with `<agent-name>:`. Commit trailers contain `Co-Authored-By:`, `Spec-Slice:`, `Peer:`, `Session:`.
9. Spawning a subagent that exits non-zero produces **no** git commit and leaves the working tree untouched.
10. Spawning a subagent with a clean working tree (nothing to commit) produces no commit and no error.
11. State file's `costCounter.honchoCalls` increments by exactly 1 per `honcho_*` tool invocation; `subagentTokens.turns` increments per subagent return.
12. `specsafe_end({ outcome: "PASS" })` moves the `currentSlice` into `history`, sets `endedAt`, and clears `currentSlice` to `null`.
13. `specsafe_status({})` reflects the post-end state correctly.
14. All `bun test` suites pass against a live `pi-dev-sandbox` Honcho workspace (no mocks at the SDK boundary).
15. Biome `check` and `format --check` pass on all new and modified files.
16. `.pi/.honcho-state.json` is present in `.gitignore` and never appears in `git status`.
17. No secret material (API key, tokens) appears in any tool's returned `content` text or `details` object across all tests.

## 7. Open questions / risks

- **Q1** — `@honcho-ai/sdk` Bun compatibility. Package claims Node; Bun is Node-compatible for most things but `EventSource` / streaming edge cases have historically bitten. **Mitigation:** first TDD step is a one-liner bun script that imports `LinearClient`, does a trivial `.viewer` call, and proves the happy path works before we write any tool code. If it fails, we fall back to `fetch`-based HTTP calls against Honcho's REST/GraphQL endpoints — more code, zero SDK risk.
- **Q2** — Exact conclusion-create method name in `@honcho-ai/sdk`. SDK docs fetched during planning were sparse; verified behavior is `peer.chat`, `peer.search`, `session.addMessages`, but the conclusion-write surface is inferred from the Honcho MCP tool set, not the SDK. **Mitigation:** TDD step 1 probes the SDK's generated types; if no direct method, fall back to raw Honcho HTTP API (known good).
- **Q3 — RESOLVED 2026-04-24:** v1 errors with `"slice already exists in history"` on re-begin. v2 may add `--resume`.
- **Q4** — Branch hygiene under auto-commit. If user is on `main` with dirty work-tree unrelated to the slice, auto-commit will capture it. **Mitigation:** on `specsafe_begin`, warn (not block) if `git status --porcelain` is non-empty; document the convention "start a slice on a clean branch named for its sliceId." A `git-hygiene` skill could enforce this later but is not in this slice.
- **Q5** — Rate limits. Honcho's pricing/limits aren't documented in the material we fetched. Cost counter surfaces usage but doesn't throttle. **Acceptable** for v1 on a personal Honcho account; revisit when we hit a wall.

## 8. Handoff notes to test-writer

- Tests MUST hit a real `pi-dev-sandbox` workspace created against the live Honcho API. No mocks at the SDK boundary. This is per Luci's "don't mock the database" rule.
- Test data must be deterministic enough that parallel runs don't collide: prefix session IDs with `test-${timestamp}-${random}` and clean up in `afterAll`.
- Critical invariants to test exhaustively: conclusion-writer allowlist, env-injection correctness, commit trailer presence, no-commit-on-failure, state-file atomicity under concurrent tool calls.
- Skip test cases that require two Pi processes running simultaneously — Bun's `$` with a spawned subprocess is sufficient coverage.
- Add a pre-flight check in the test setup that verifies `HONCHO_API_KEY` is present and `pi-dev-sandbox` workspace is reachable; skip the whole suite with a loud message if not.

## 9. Handoff notes to implementer

- Read this entire spec before starting.
- Implement in the order: state-file helpers → `specsafe-session` extension → `honcho` extension → subagent patch. Each layer is independently testable.
- Do not add logging beyond what's necessary to pass the tests. Pi's UI surfaces tool errors; we don't need console spam.
- When in doubt about an ambiguity, STOP and flag to the spec-writer. Do not invent behavior.
- Commit your own work incrementally within this slice using the existing `specsafe-subagents` auto-commit once it's patched — eat the dog food.
