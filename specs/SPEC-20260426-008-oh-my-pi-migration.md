---
id: SPEC-20260426-008
slug: oh-my-pi-migration
slice: 8 of N
title: Partial migration of pi-seshat onto Oh My Pi runtime
status: phase-1-landed
author: opus-spec-writer (drafted on behalf of luci)
approved_by: luci
approved_on: 2026-04-26
landed_phase_1_on: 2026-04-26
phase_1_label: slice-008.0 (foundation + ports + flagged constraints)
test_writer_skipped: true (single-user local-first tool; existing extension test suites port forward intact; §4 is the verification contract; new logic gets ad-hoc tests inline with implementation)
follow_up_slices:
  - 008.1 — per-agent identity propagation under Oh My Pi (workaround #2, persona-prompt declaration)
  - 008.2 — skill bin/ refactor: replace vanilla-Pi extension imports with runtime-neutral helpers (or CLI shell-out)
created: 2026-04-26
depends_on: [SPEC-20260424-001, SPEC-20260424-002, SPEC-20260424-003, SPEC-20260424-004, SPEC-20260424-005, SPEC-20260424-006, SPEC-20260426-007]
linear: n/a
---

# SPEC-008 — Partial migration onto Oh My Pi

## 1. Goal

- Replace pi-seshat's two largest hand-built infrastructure components — the Meridian + pi-scrub Anthropic-subscription proxy and the slice-007 cross-provider fallback chain — with the equivalent **native, in-process** facilities shipped by Oh My Pi (`can1357/oh-my-pi`, MIT, dual copyright Mario Zechner / Can Bölük).
- Preserve every component that gives pi-seshat its product identity — Honcho-backed durable memory with peer-identity threading, the SpecSafe slice lifecycle, the seven Ghola personas with their model/tool allowlists, the six external-surface skills, and the `--i-approve` mutation gate — by porting them cleanly onto Oh My Pi's hook + custom-tool + skill-loader extension surface.
- Reduce pi-seshat's maintenance liability by retiring code that duplicates upstream functionality, while staying inside the Subscription Optimizer constraint (subscription billing where possible; Kimi remains the only API-key fallback we tolerate).
- Keep the migration auditable and reversible: pi-seshat's existing `~/.pi/agent/` install is left untouched until the new `~/.omp/agent/` install passes acceptance criteria, so rollback is a config-flip, not a restore-from-backup.

## 2. Scope

In scope:

- A new pi-seshat-on-Oh-My-Pi install rooted at `~/.omp/agent/`, coexisting with (not replacing) the current `~/.pi/agent/` install.
- Re-`/login` against Anthropic, OpenAI Codex, Google Antigravity, Google Gemini CLI, GitHub Copilot, and Kimi under the new `agent.db` credential store.
- Six skills (`push`, `memory`, `linear`, `docs`, `github`, `latest-docs`) ported into `~/.omp/agent/skills/` (or `~/.claude/skills/` since Oh My Pi reads both) with no behavioral change. SKILL.md format is identical between the two runtimes; the skill `bin/` scripts are runtime-agnostic and need only path-relative tweaks.
- Seven Ghola personas (`spec-writer`, `test-writer`, `implementer`, `validator`, `reviewer`, `steward`, `doc-scout`) ported into `~/.omp/agent/agents/` with model overrides preserved.
- Honcho bridge re-implemented as an Oh My Pi **custom tool** (`~/.omp/agent/tools/honcho/index.ts`) exposing `honcho_remember` and `honcho_conclude`, with the validator/reviewer/steward conclusion-writer allowlist enforced inside the tool's pre-call check.
- SpecSafe session lifecycle re-implemented as Oh My Pi **hooks** under `~/.omp/agent/hooks/`: a `session_start` hook that opens the per-slice cost ledger, a `tool_call` hook that propagates the session-id + spec-slice + peer trailers into the dispatch payload, and a `session_end` hook that flushes the ledger and writes the commit-trailer block.
- `--i-approve` mutation gate re-implemented as a `tool_call` pre-hook that blocks `bash` invocations matching the project's mutation allowlist (`git push`, `gh pr create`, `linear-cli ...`, BMad-doc apply) unless the most recent user message contains the literal token `--i-approve`.
- A thin session-event subscriber under `~/.omp/agent/hooks/fallback-audit.ts` that mirrors Oh My Pi's `retry_fallback_applied` / `retry_fallback_succeeded` events into a JSONL audit log at `~/.omp/agent/.fallback-log.jsonl` (same redaction rules as slice-007), restoring the one slice-007 acceptance criterion that Oh My Pi's native chain doesn't satisfy.
- Default fallback chain configured in `~/.omp/agent/settings.yml` under `retry.fallbackChains` matching slice-007's intent: Anthropic Opus → OpenAI GPT-5 → Google Gemini, plus a `plan` chain for plan-mode work.
- Test suite at `.omp/test/migration/` exercising: each Ghola dispatches end-to-end under Oh My Pi, fallback chain behavior under simulated provider 5xx, Honcho `remember`/`conclude` round-trip with allowlist enforcement, `--i-approve` block-and-pass cases, all six skills' golden-path commands.
- A `MIGRATION.md` at repo root documenting the cutover sequence, the rollback procedure (one-line config swap), and the parity checklist mapping each slice 001–007 acceptance criterion to its new home.

Not in scope:

- Removing the existing `~/.pi/agent/` install or the Meridian systemd unit. Both stay alive until acceptance §4 is green AND Luci has run the new install for at least one full SpecSafe loop in production. Decommission is a follow-up slice.
- Adopting Oh My Pi's autonomous memory (`~/.omp/agent/memories/`). It conflicts with Honcho's role as the durable-memory of record. We disable it via `disabledExtensions` or equivalent flag and keep Honcho as the single source of truth.
- Adopting Oh My Pi's mid-stream retry behavior (the `auto_retry_start` / `auto_retry_end` path). Slice-007 explicitly defers mid-stream resume to v2. We accept Oh My Pi's pre-stream fallback (which matches slice-007) and configure its mid-stream behavior to be **disabled or strictly opt-in per Ghola**. Open issue [oh-my-pi#544](https://github.com/can1357/oh-my-pi/issues/544) confirms mid-stream retry has known sharp edges around tool_use replay; we do not enable it on validator/reviewer paths where correctness matters most.
- Adopting Oh My Pi's `pi-missions` package as a SpecSafe replacement. SpecSafe's gating discipline (binary PASS/FAIL with loop-back, test-first, archive-on-complete) is product-distinctive; missions can be evaluated as a separate slice if at all.
- Replacing the BMad-Method planning workflow. Oh My Pi has nothing analogous; bmad-* skills stay where they are.
- Forking Oh My Pi. We consume it as a published npm package (`@oh-my-pi/pi-coding-agent`) so upstream patches flow in automatically. If the bus-factor risk in §5.2 forces a vendoring decision later, that's its own slice.
- Republishing pi-seshat as a downstream Oh My Pi distribution or rebranding the binary. The `omp` binary name stays; Seshat is the persona, not the runtime.

## 3. Implementation constraints

### 3.1 Capability mapping — the verdict matrix

| Capability | Oh My Pi native? | Coverage vs pi-seshat | Migration verdict |
|---|---|---|---|
| Anthropic subscription proxy | ✅ in-process | Stronger (no separate process, no systemd) | Migrate to native; retire Meridian + pi-scrub |
| Provider fallback chain | ✅ via `retry.fallbackChains` | ≈ equal coverage; missing dedicated audit log | Migrate; restore audit log via session-event hook |
| Honcho durable memory | ❌ | Oh My Pi only has session-summary autonomous memory; no peer/conclusion identity | Keep as custom tool; disable Oh My Pi's autonomous memory |
| SpecSafe slice lifecycle | ❌ | No spec→test→implement→verify gating | Keep as hooks |
| Ghola personas | ⚠️ partially | `~/.omp/agent/agents/` is structurally compatible; no allowlist concept | Port directory; allowlist re-implemented inside Honcho custom tool + `--i-approve` hook |
| Six external skills | ⚠️ loader only | Universal SKILL.md loader; reads `~/.claude/skills` too | Port skills 1:1; no rewrite |
| `--i-approve` idiom | ❌ | Hook system can implement it (sudo-confirm example in README) | Re-implement as `tool_call` pre-hook |

### 3.2 Why Oh My Pi's Anthropic stealth path replaces Meridian + pi-scrub

Native implementation lives at `packages/ai/src/providers/anthropic.ts` in the upstream repo. The relevant components, read directly from source:

- **OAuth PKCE flow** (`packages/ai/src/utils/oauth/anthropic.ts`) authorizes against `https://claude.ai/oauth/authorize` with scope `org:create_api_key user:profile user:inference` and stores the resulting token in `~/.omp/agent/agent.db` (SQLite).
- **Claude Code identity spoofing** is intentional and labeled. `anthropic.ts:252` carries the comment `// Stealth mode: Mimic Claude Code headers and tool prefixing.` and sets `claudeCodeVersion = "2.1.63"`, `claudeToolPrefix = "proxy_"`, and a `claudeCodeSystemInstruction` matching the canonical Claude Agent SDK preamble.
- **Stainless-SDK header injection** (`anthropic.ts:290–299`) attaches `X-Stainless-Retry-Count`, `Runtime-Version: v24.3.0`, `Package-Version: 0.74.0`, `Lang: js`, plus OS/Arch/Timeout — the exact fingerprint Anthropic's official SDK emits.
- **TLS-fingerprint parity**: `CLAUDE_CODE_TLS_CIPHERS = tls.DEFAULT_CIPHERS` plus optional client-cert mTLS via `CLAUDE_CODE_CLIENT_CERT/_KEY` env vars (`anthropic.ts:491, 572–608`).
- **Billing-header generation** (`createClaudeBillingHeader`, `anthropic.ts:320–329`): synthesizes `x-anthropic-billing-header: cc_version=<version>.<rand_hash>; cc_entrypoint=cli; cch=<sha256_payload_hash>;` and prepends a Claude-Code instruction system-block via `buildAnthropicSystemBlocks` (`anthropic.ts:1103–1144`) when a request goes out under OAuth.
- **User-ID cloaking** (`anthropic.ts:331–354`): `generateClaudeCloakingUserId` synthesizes a `user_<64hex>_account_<uuid>_session_<uuid>` ID matching the canonical Claude Code metadata shape.

Functional difference vs Meridian + pi-scrub:

- pi-scrub *removes* Pi fingerprints from the system prompt before traffic reaches the official Claude Code SDK (running under Meridian).
- Oh My Pi *adds* Claude-Code fingerprints to traffic that goes directly to `api.anthropic.com` — there is no Claude Code SDK in the loop.

End-state intent is identical (look like Claude Code to Anthropic's billing classifier). Implementation surface is broader on Oh My Pi (TLS cipher selection, billing-header synthesis, user-ID cloaking, Stainless headers) but actively maintained — see §5.2 for the bus-factor risk on relying on that surface.

### 3.3 Why Oh My Pi's `retry.fallbackChains` replaces our slice-007 extension

The native fallback path lives in `packages/coding-agent/src/session/agent-session.ts` (~6,700 lines, fallback logic at lines 5200–5400). Mapping against slice-007's acceptance table:

| Slice-007 requirement | Oh My Pi native | Gap to close in this slice |
|---|---|---|
| Pre-stream error classification | ✅ `#isTransientEnvelopeErrorMessage` (5207) and `#isTransientTransportErrorMessage` (5212) cover overload, rate-limit, 429, 5xx, network, timeout, stream-stall | No explicit auth (401/403) classification — auth fails fall through. Acceptable for v1; auth misconfiguration should be loud and is a fatal config error regardless. |
| Lazy model resolution from registry | ✅ `#applyRetryFallbackCandidate` (5334) calls `modelRegistry.find(selector.provider, selector.id)` and resolves API-key only at fallback time | None |
| JSONL audit log with secret redaction | ⚠️ Emits `retry_fallback_applied` (5366) and `retry_fallback_succeeded` (959) as session events to `session.subscribe` and the session JSONL store, but no dedicated audit file | **Restore via `~/.omp/agent/hooks/fallback-audit.ts`** — subscribe to those two events and append-write to `~/.omp/agent/.fallback-log.jsonl` (mode 0600, gitignored), reusing slice-007's `log.ts` redaction rules verbatim. ~50 LOC. |
| Done-event message rewrite | ⚠️ Session emits `retry_fallback_succeeded`; assistant message text isn't textually rewritten | The session-event approach is operationally equivalent (UI renders the fallback notice) and arguably cleaner than mutating message text. Accept Oh My Pi's behavior. |
| Mid-stream failure handling | ⚠️ Oh My Pi attempts mid-stream retry; slice-007 explicitly defers this | **Disable mid-stream retry on validator/reviewer paths**, where correctness matters most. Issue [#544](https://github.com/can1357/oh-my-pi/issues/544) is an active bug on tool_use replay — we don't ride that path. Per-Ghola opt-in via agents config. |
| Cooldown/revert policy | ✅ Bonus — `fallbackRevertPolicy: cooldown-expiry \| never` (5267) parses `retry-after-ms` and suppresses the selector via `modelRegistry.suppressSelector` | None — net win over slice-007 |

Default config installed via `omp config set retry.fallbackChains '...'` (verified empirically against the live install):

```json
{
  "default": ["anthropic/claude-opus-4-7", "github-copilot/gpt-5", "google-antigravity/gemini-3.1-pro"],
  "plan":    ["anthropic/claude-opus-4-7", "github-copilot/gpt-5"]
}
```

Two empirical adjustments from the original §1 plan, captured here as findings rather than open questions:

- **OpenAI Codex link replaced with GitHub Copilot.** A2 testing showed that an OpenAI Codex login backed by a ChatGPT (not Plus/Pro/Enterprise) account hard-restricts model access — every gpt-5*, gpt-5.x*, gpt-5-codex* model returns `invalid_request_error: model not supported when using Codex with a ChatGPT account`. This is upstream OpenAI policy, not an Oh My Pi defect. GitHub Copilot's `gpt-5` is the same subscription class via a different OAuth path and worked cleanly. The OpenAI link in the chain therefore points at `github-copilot/gpt-5`. Kimi remains excluded for the same Subscription Optimizer reason.
- **Google Gemini CLI link replaced with Google Antigravity.** A2 testing showed `google-gemini-cli/gemini-2.0-flash` returning `Cloud Code Assist API error (404)` — likely a project-ID or OAuth-scope mismatch. `google-antigravity/gemini-3.1-pro` returned cleanly and covers the Google chain link. Diagnosing the Gemini CLI 404 is deferred to a follow-up troubleshooting note; not a blocker for this slice.

### 3.4 Honcho bridge as a custom tool

Oh My Pi's custom-tool API (`packages/coding-agent/examples/custom-tools/`) exposes a `defineTool` factory comparable to vanilla Pi's extension hook. The slice-001 Honcho bridge ports without behavioral change:

- `~/.omp/agent/tools/honcho/index.ts` exports two tools: `honcho_remember(key, value, ttl?)` and `honcho_conclude(text)`.
- The `honcho_conclude` handler reads the calling agent's persona name from the dispatch context (Oh My Pi's `tool_call` event payload includes `agentName`) and rejects unless `agentName ∈ {validator, reviewer, steward}`.
- The steward `product:` prefix invariant is enforced in the same handler: if `agentName === "steward"` and the conclusion text doesn't start with `product:`, the handler prepends it.
- Honcho client config (workspace, peer mappings) is read from `~/.omp/agent/honcho.json`, ported verbatim from `~/.pi/agent/honcho.json`.
- Oh My Pi's autonomous memory feature is disabled via the appropriate `disabledExtensions` or settings flag (TBD per §5.4) so it doesn't fight Honcho.

### 3.5 SpecSafe lifecycle as hooks

Oh My Pi's `HookAPI` (exported from `@oh-my-pi/pi-coding-agent/hooks`) provides `session_start`, `tool_call`, `tool_result`, `session_end` events with mutation/blocking capabilities. Mapping pi-seshat extensions:

- `.pi/extensions/specsafe-session/` → `~/.omp/agent/hooks/specsafe-session.ts` listening on `session_start` (open ledger), `tool_result` (accumulate cost), `session_end` (flush + emit trailer block).
- `.pi/extensions/specsafe-subagents/` → `~/.omp/agent/hooks/specsafe-subagents.ts` listening on `tool_call` for the dispatch tool name, injecting `Co-Authored-By` / `Spec-Slice` / `Peer` / `Session` trailers into the agent's context.

Both hooks read SpecSafe state from the same on-disk locations as today (`specs/` directory), so the SpecSafe document model is unchanged.

### 3.6 `--i-approve` as a pre-tool-call hook

`~/.omp/agent/hooks/i-approve.ts`:

```ts
omp.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "bash") return;
  const cmd = event.params.command ?? "";
  const isMutation = /^\s*(git push|gh pr create|gh pr merge|linear-cli|bmad-doc apply)/.test(cmd);
  if (!isMutation) return;
  const lastUser = ctx.session.lastUserMessage?.text ?? "";
  if (!lastUser.includes("--i-approve")) {
    return { block: true, reason: "Mutation requires --i-approve token in the latest user message" };
  }
});
```

Equivalent semantics to the current skill-side enforcement. Skills retain their own `--i-approve` checks as defense-in-depth; the hook is the new outer gate.

### 3.7 Coexistence with the existing `~/.pi/agent/` install

- Vanilla Pi (`pi`) and Oh My Pi (`omp`) bind different binary names and different config roots — no PATH or config collision.
- Meridian remains running as a systemd user service throughout the migration. `~/.pi/agent/models.json` continues to point at `127.0.0.1:3456`. We do **not** touch the existing install until acceptance §4 is fully green.
- Cutover is one config edit: change project-level `AGENTS.md` and any wrapper scripts to invoke `omp` instead of `pi`. Rollback is the inverse edit. Total decision-to-rollback time: <60 seconds.
- Decommission of Meridian + pi-scrub + `~/.pi/agent/` happens in a separate slice after Luci has used the new install in production for at least one full SpecSafe loop.

### 3.8 What changes in the repo

- New top-level directory `.omp/` mirroring `.pi/` for project-scoped agents/extensions/hooks/skills/tools that ship with the repo (analogous to how `.pi/` already does).
- `.omp/agents/`, `.omp/hooks/`, `.omp/tools/`, `.omp/skills/` populated from the corresponding `.pi/` paths via the porting work above.
- `.omp/test/migration/` containing the test suite covering §4 acceptance criteria.
- New `MIGRATION.md` at repo root.
- `AGENTS.md` updated to reference `omp`-bound dispatch and the new `.omp/` directory layout. Original `.pi/`-bound text moves into `AGENTS.legacy.md` for the duration of the coexistence window.
- `.gitignore` adds `.omp/.fallback-log.jsonl`.
- No deletion of `.pi/` content in this slice.

### 3.9 Dependency posture

- New runtime dependency: `@oh-my-pi/pi-coding-agent` installed globally (`bun install -g`). Not added to repo `package.json` — it's a runtime, not a library.
- The Honcho custom tool, the four hooks, and the audit-log subscriber import from `@oh-my-pi/pi-coding-agent/{hooks,tools}` and `@oh-my-pi/pi-ai`. These show up in `package.json` devDependencies for typechecking.
- No new transitive dependencies pulled into the repo build. Oh My Pi's runtime deps are isolated to its own install.

## 4. Acceptance criteria

Each criterion is a binary PASS/FAIL test under `.omp/test/migration/`. All must pass before the slice is archived.

- **A1 — Install parity.** `omp --version` reports a current Oh My Pi release. `~/.omp/agent/agent.db` exists with credential rows for all six providers (anthropic, openai-codex, google-antigravity, google-gemini-cli, github-copilot, kimi-coding).
- **A2 — Anthropic subscription routing.** `omp` issues a request to `claude-opus-4-5` and the response shows it billed against the Max plan, not the Anthropic API key. Verified by inspecting the OAuth-token metadata on `~/.omp/agent/agent.db` and absence of API-key headers in the outbound request capture (one-off `mitmproxy` run during validation, not a permanent harness).
- **A3 — Fallback chain.** With Anthropic forced into 503 via `OMP_ANTHROPIC_FORCE_ERROR=503` (or equivalent injection seam), a request through `default` chain successfully completes against OpenAI GPT-5. The session emits `retry_fallback_applied` and `retry_fallback_succeeded`. `~/.omp/agent/.fallback-log.jsonl` gains one well-formed JSONL line with no API keys leaked.
- **A4 — Honcho remember round-trip.** `seshat` (the orchestrator) calls `honcho_remember` with a known key/value; subsequent session reads back the same value. `seshat` calling `honcho_conclude` is rejected with the allowlist error; `validator` calling it succeeds; `steward` calling it succeeds AND the stored text starts with `product:` even if the input did not.
- **A5 — Each Ghola dispatches.** All seven personas (`spec-writer`, `test-writer`, `implementer`, `validator`, `reviewer`, `steward`, `doc-scout`) dispatch to a no-op task ("respond with PONG") under `omp` and return cleanly with the correct model selection per their persona file. Trailer block on the orchestrating session contains all four trailers.
- **A6 — All six skills functional.** Each of `push`, `memory`, `linear`, `docs`, `github`, `latest-docs` runs its golden-path command end-to-end under `omp` against a test scratch context. No regressions vs `pi`-bound run.
- **A7 — `--i-approve` gate.** Without `--i-approve` in the latest user message, an attempt to invoke `git push` via the bash tool is blocked at the hook layer with the configured rejection message. With `--i-approve` present, the same invocation proceeds.
- **A8 — Coexistence.** With Oh My Pi installed, a vanilla `pi` invocation against `~/.pi/agent/` continues to work unchanged. Meridian still serves on 3456. No PATH collision.
- **A9 — Rollback drill.** From a fully-cutover `omp` state, edit project `AGENTS.md` back to `pi`-bound dispatch and confirm the next session runs cleanly under the original install with no residual `~/.omp/`-side state required. Time-to-rollback recorded; target <60 seconds.
- **A10 — Tests + typecheck green.** `bun run typecheck` and `bun run test` (now including `.omp/test/migration/`) both pass. Existing 197/8/0 baseline is preserved.

## 5. Open questions / risks — RESOLVED 2026-04-26

All seven decision points were resolved in the spec-approval round. Decisions captured below. The §5.6 question (`pi-missions`) was answered by primary evidence: the PR is closed-not-merged and the package does not ship in current Oh My Pi — the question is therefore retired rather than deferred.

### 5.1 Empirical billing-classifier survival on the Anthropic Max plan — DECIDED: dry-run on cheap models



Public signal is suggestive but not proof. Zero open issues on `can1357/oh-my-pi` reference billing-classifier blocks against Anthropic; recent commits (as of 2026-04-26) actively maintain spoofed-fingerprint parity (closed PR [#574](https://github.com/can1357/oh-my-pi/pull/574) updates a Gemini CLI User-Agent string in flight). But the only proof Anthropic isn't flagging Oh My Pi traffic on the April 2026 classifier is an empirical run on a real OAuth account.

**Decided**: Dry-run before cutover, using the cheapest models on each chain link (`claude-haiku` for Anthropic, `gpt-4o-mini` for OpenAI, `gemini-flash` for Google) to keep test volume well under any classifier's plausible alarm threshold. Dry-run is part of A2 acceptance. If the dry-run flags the account, abort the migration and stay on Meridian + pi-scrub.

### 5.2 Bus-factor tolerance — DECIDED: vendor at known-good SHA

Oh My Pi has ~70 contributors but commit distribution is heavily skewed: `can1357` 2,542 commits, `badlogic` (the upstream maintainer) 1,343, next contributor 32. This is effectively a single-maintainer project with upstream import discipline. If `can1357` goes dark for two weeks during an Anthropic SDK header rotation, the billing path breaks and we're patching a fork we don't own.

Meridian + pi-scrub has the same risk profile (single-maintainer rynfar/meridian + our own pi-scrub plugin) but the surface is smaller and you control both halves.

**Decided**: Pin to a known-good Oh My Pi version (the released npm version at install time, captured in `MIGRATION.md`). Upstream patches do NOT auto-flow; we re-baseline manually after reading the changelog. If `can1357` goes dark, we sit on the pinned version until either upstream resumes or we choose to fork.

### 5.3 Mid-stream retry behavior — DECIDED: default-off on validator/reviewer; allow elsewhere

Oh My Pi attempts mid-stream retries on the same path slice-007 explicitly defers. Issue [#544](https://github.com/can1357/oh-my-pi/issues/544) documents known bugs around tool_use replay during fallback. We default-disable on validator/reviewer paths in §3.3, but the runtime may still attempt it elsewhere unless we configure it off globally.

**Decided**: Per-Ghola opt-out matching §3.3. validator + reviewer have mid-stream retry disabled at the persona level; other Gholas inherit Oh My Pi's default behavior. This trades some variance for the feature value where correctness is less existential (e.g., implementer can recover mid-stream rather than restart a 5-minute generation).

### 5.4 Disabling Oh My Pi's autonomous memory — DECIDED: Honcho-only

Oh My Pi's `~/.omp/agent/memories/` autonomous-memory feature is on by default and emits a `MEMORY.md` block at session start. If both that and Honcho operate, we have two competing memory-of-record stores and the Ghola personas don't know which to trust.

We need to disable autonomous memory cleanly. The exact flag (`disabledExtensions: ["autonomous-memory"]`? a settings boolean? per-project opt-out?) is not yet verified — this is one of the four items the research agent flagged as not-empirically-tested.

**Decided**: Honcho is the only memory store. Autonomous memory is disabled. Rationale: Honcho is peer-identity-threaded conclusion memory with a validator/reviewer/steward allowlist; Oh My Pi's autonomous memory is per-project session-summary markdown with no peer model and no allowlist. Layering them creates dual sources of truth, silently erodes the allowlist, and doubles per-session token cost. The exact disable-flag (`disabledExtensions`, settings boolean, or per-project opt-out) is verified during implementation; the policy is locked.

### 5.5 Credential portability vs fresh re-`/login` — DECIDED: re-login

Pi-seshat's `~/.pi/agent/auth.json` is a JSON file with six providers' OAuth tokens. Oh My Pi's `~/.omp/agent/agent.db` is SQLite. Schema is not documented; whether tokens can be hand-migrated by INSERT is unverified. The safe assumption is that we re-`/login` against each of the six providers under `omp`.

**Decided**: Re-`/login` against each of the six providers under `omp`. ~5 minutes of human time; zero risk of corrupting either credential store. SQLite-schema transplant is rejected as a fragile shortcut.

### 5.6 SpecSafe `pi-missions` evaluation — RETIRED: package does not ship

Primary-evidence check: PR [#738](https://github.com/can1357/oh-my-pi/pull/738) is **closed without merging**, the `pi-missions` package does **not** exist in Oh My Pi's current `packages/` directory (verified via `gh api repos/can1357/oh-my-pi/contents/packages`), and there are no follow-up mission-related PRs after #738. The maintainer chose not to land it. Recommending we evaluate a closed-not-merged package would stack a second bus-factor risk on top of the one in §5.2.

**Decided**: Skip entirely. SpecSafe is the orchestration discipline for this project; `/mission` (if it ever ships) is a competing multi-phase orchestrator with a different ordering (architect → implement → test → audit, which is test-after-implement and therefore a regression vs SpecSafe's test-first rule). If a real need for non-spec-bound multi-phase orchestration ever appears, evaluate purpose-built tooling at that time — not Oh My Pi's shelved package.

### 5.7 Steward conclusion-prefix invariant — DECIDED: keep both

**Decided**: Keep persona-text reminder AND code-side enforcement in the new Honcho custom tool. Persona text is authoritative for the model's behavior at generation time; code-side enforcement is the safety net if the persona text is ever weakened or removed. Defense-in-depth is the correct posture for an invariant that scopes product-truth claims.

## 5b. Architectural beats surfaced during implementation (2026-04-26)

Three constraints emerged from primary-source reading of `@oh-my-pi/pi-coding-agent@14.4.0` during the parallel ports. They do not invalidate the migration's value proposition but they reframe what "A4–A6 PASS" means and motivate the 008.0 / 008.1 / 008.2 staging.

### 5b.1 Per-spawn child-env injection has no `HookAPI` seam — slice-008.1

Vanilla Pi shipped its own `subagent` tool that called `child_process.spawn(..., { env: { HONCHO_PEER_ID, HONCHO_WORKSPACE_ID, HONCHO_SESSION_ID, SPECSAFE_SLICE_ID } })` per dispatch. Oh My Pi's bundled `task` tool subprocess is not exposed to hooks at spawn time. Setting `process.env.HONCHO_*` globally at `session_start` would leak across every subprocess the runtime spawns and lose per-agent identity.

Consequence: the Honcho custom tool's allowlist (validator/reviewer/steward only on `honcho_conclude`) reads `process.env.HONCHO_PEER_ID` at call time but has no mechanism to know which Ghola is actually calling under `omp`. 14 unit tests pass because the test harness sets the env directly; production identity is currently degraded.

**Decided workaround for slice-008.1**: persona-prompt identity declaration (workaround #2 of three documented in `.omp/hooks/PORT-NOTES.md`). Each Ghola's system prompt instructs it to declare its peer name when calling `honcho_conclude`; the custom tool's `execute` validates the declared identity against the active session. Trade-off: degrades the allowlist from "process-trusted" to "model-trusted" — a misbehaving model could lie. Defense-in-depth still holds because Steward's `product:` prefix is enforced both in persona text AND code-side.

Rejected workarounds: (a) shell-level env export — single peer per session, allowlist effectively merged; (c) upstream patch to expose pre-spawn env hook — out of scope, bus-factor risk per §5.2.

### 5b.2 Per-agent retry control does not exist in v14.4.0 — accepted limitation, persona-text comments preserve intent

Oh My Pi's `AgentDefinition` parser exposes no retry-related frontmatter key. `retry.enabled` / `retry.maxRetries` are global config only. The §5.3 decision (disable mid-stream retry on validator/reviewer specifically) is therefore not directly implementable today.

**Accepted**: leave global retry on; rely on the personas' inherent test-discipline (validator and reviewer correctness comes from the Ghola's persona text, not from retry policy). HTML comment blocks in `.omp/agents/{validator,reviewer}.md` document the intent so it can be re-enabled the moment upstream adds per-agent retry frontmatter. If upstream never adds it and we observe variance issues in production, escalate to slice-008.3 with the global-disable option (which would also kill `retry.fallbackChains`, so be deliberate).

### 5b.3 Skill `bin/` scripts import vanilla-Pi extension code via relative paths — slice-008.2

`memory.ts` and `docs.ts` under each ported skill's `bin/` import `../../../extensions/{honcho,specsafe-session}/index.ts`. After porting these resolve to `.omp/extensions/` which does not exist (and shouldn't, because Honcho moved to `.omp/tools/` and SpecSafe moved to `.omp/hooks/` — different API surfaces under Oh My Pi).

**Decided for slice-008.2**: refactor the skill `bin/` scripts to either (a) shell out to a thin CLI wrapper around the Honcho custom tool / SpecSafe state-file reader, matching Luci's CLI-first preference, or (b) extract a runtime-neutral `lib/` directory that both `.pi/` and `.omp/` import from. Option (a) is cleaner: keeps skills independent of which runtime they're invoked from. Option (b) is faster but creates a new shared-library invariant to maintain.

Audit-log paths inside skill bin scripts (`$REPO_ROOT/.pi/.push-log.jsonl`, `$REPO_ROOT/.pi/.linear-log.jsonl`, etc.) are repo-relative not runtime-relative, so they're untouched by this refactor — they continue to coexist between `pi` and `omp` invocations. Slice-009 decommission decides their migration.

## 6. Verification plan

Before any code is written: this spec lands and Luci approves §5's seven decision points. No implementation Gholas dispatch until then (Phase 4 of the handoff).

After spec approval, the SpecSafe loop runs as usual:

1. Spec — done (this document, pending sign-off).
2. Tests — `test-writer` Ghola authors `.omp/test/migration/*.test.ts` covering A1–A10 with the appropriate test seams (`OMP_ANTHROPIC_FORCE_ERROR` injection, golden-path bash command captures for skills, hook fixtures).
3. Implement — `implementer` Ghola produces in dependency order: install (A1) → fallback config + audit-log hook (A3) → Honcho custom tool (A4) → SpecSafe hooks → `--i-approve` hook (A7) → ports of agents and skills (A5, A6). A2/A8/A9/A10 are integration-level and validated last.
4. Verify — `validator` runs §4 acceptance, `reviewer` runs the security/quality pass with attention to the spoofing surface from §3.2 and the credential-store boundary from §5.5.
5. Complete — archive this spec under `specs/archive/` and write a post-mortem note to Honcho via Steward summarizing whether the migration delivered the expected reduction in self-maintained surface area.

Decommission of Meridian + pi-scrub + `~/.pi/agent/` is **not** part of this slice. It happens in slice-009 after Luci has used the new install in production for at least one full SpecSafe loop and is comfortable with the rollback drill from A9.
