# MIGRATION — pi-seshat onto Oh My Pi

Reference document for slice-008 migration. Spec at `specs/SPEC-20260426-008-oh-my-pi-migration.md`.

## What we did

Replaced the two heaviest hand-built infrastructure components with Oh My Pi natives, while preserving the components that give pi-seshat its product identity by porting them onto Oh My Pi's hook + custom-tool + skill-discovery extension surface.

| Replaced (now Oh My Pi native) | Preserved (ported as `.omp/` extensions) |
|---|---|
| Meridian + pi-scrub Anthropic-subscription proxy | Honcho durable memory (custom tool, validator/reviewer/steward allowlist intact) |
| `.pi/extensions/fallback-chain/` (slice-007) | SpecSafe slice lifecycle (hooks, trailer propagation intact) |
| | Six external-surface skills (push, memory, linear, docs, github, latest-docs) |
| | Seven Ghola personas |
| | `--i-approve` mutation gate (now a `tool_call` pre-hook) |

## Empirical findings vs the original plan

A2 dry-run on cheap models revealed two routing constraints absent from the spec's first draft:

1. **OpenAI Codex with a ChatGPT account hard-restricts model access.** Every gpt-5*, gpt-5.x*, gpt-5-codex* request returned `invalid_request_error: model not supported when using Codex with a ChatGPT account`. Upstream OpenAI policy. The chain's OpenAI link therefore points at `github-copilot/gpt-5` (same subscription class, different OAuth path, verified PONG).
2. **`google-gemini-cli` 404s on Cloud Code Assist.** Likely a project-ID or OAuth-scope mismatch from the login flow. `google-antigravity` covers Google fine. Diagnosing the Gemini CLI 404 is a follow-up troubleshooting note; not a blocker.

Result: fallback chain is `anthropic/claude-opus-4-7 → github-copilot/gpt-5 → google-antigravity/gemini-3.1-pro`.

## Cutover sequence

The migration is designed to coexist with the existing `~/.pi/agent/` install. Both runtimes work in parallel until slice-009 decommissions Meridian + pi-scrub + `~/.pi/agent/`.

1. **Pinned install** — `bun install -g @oh-my-pi/pi-coding-agent@14.4.0`. Vendored at this version; upstream patches do NOT auto-flow per spec §5.2 decision.
2. **Symlink repo extensions to runtime location** —
   ```bash
   ln -sf "$PWD/.omp/hooks"  ~/.omp/agent/hooks
   ln -sf "$PWD/.omp/tools"  ~/.omp/agent/tools
   ln -sf "$PWD/.omp/agents" ~/.omp/agent/agents
   ln -sf "$PWD/.omp/skills" ~/.omp/agent/skills
   ```
3. **Re-`/login`** under `omp` for each provider you intend to use — already done by Luci 2026-04-26.
4. **Settings configured** —
   - `omp config set retry.fallbackChains '<chain JSON>'` (see chain above)
   - `omp config set memories.enabled false` (Honcho is the only memory store per §5.4)
5. **Project AGENTS.md** flips dispatch wrapper from `pi` to `omp` when ready to cut over.

## Rollback

One config edit. Flip `AGENTS.md` back to `pi`-bound dispatch and the next session runs against `~/.pi/agent/` again. Meridian + pi-scrub remain alive until slice-009. Time-to-rollback: <60 seconds.

## Coexistence invariants

- Vanilla Pi (`pi`) and Oh My Pi (`omp`) are different binaries with different config roots — no PATH or config collision.
- Meridian runs as a systemd user service throughout the migration. `~/.pi/agent/models.json` continues to point at `127.0.0.1:3456`.
- The repo's `.pi/` directory is **not modified** during the migration.

## Acceptance status — slice-008.4 cutover landed 2026-04-26

| ID | Criterion | Status | Notes |
|---|---|---|---|
| A1 | `omp --version` + `agent.db` populated for six providers | ✅ Pass | omp v14.4.0; anthropic / openai-codex / google-antigravity / google-gemini-cli / github-copilot / kimi-code logged in |
| A2 | Anthropic OAuth + stealth subscription routing | ✅ Pass | `claude-haiku-4-5` → PONG; billing-classifier survival empirically confirmed |
| A3 | Fallback chain config + audit log | 🟡 Partial | Config installed; `fallback-audit.ts` hook subscribed to `auto_retry_*` events; full chain-trigger integration test deferred to live observation |
| A4 | Honcho round-trip + allowlist + Steward `product:` prefix | ✅ Pass | Slice-008.1: `as_peer` parameter required on `honcho_conclude`, validates against declared identity (not env). 226+ unit tests; integration scaffolding under `.omp/test/migration/identity.test.ts` (gated `OMP_LIVE_TESTS=1`, awaiting omp programmatic dispatch surface). |
| A5 | Each Ghola dispatches with correct identity + trailers | ✅ Pass at persona+code level | Slice-008.1: all seven personas declare `as_peer` in their Memory protocol. Slice-008.3: each persona pinned to a primary model + 5-link fallback chain. SpecSafe-subagents hook emits trailers on tool_result. Live trailer verification under real omp dispatch is part of behavioral A9 drill. |
| A6 | All six skills functional under `omp` | ✅ Pass | Slice-008.2: `memory` + `docs` skills decoupled from vanilla-Pi extension imports via inline-copied `_specsafe-state.ts`; pin tests enforce shape parity with canonical extensions. `grep -rn "../../../extensions/" .omp/skills/` returns zero. |
| A7 | `--i-approve` gate | ✅ Hook landed | `tool_call` pre-hook with mutation-pattern matchlist; integration test deferred to live observation |
| A8 | Coexistence of `pi` and `omp` | ✅ Pass | Different binaries (`pi` vs `omp`), different config roots (`~/.pi/agent/` vs `~/.omp/agent/`), no PATH or config collision verified |
| A9 | Rollback drill: <60s to `pi`-bound dispatch | 🟡 Mechanism verified | Symlinks at `~/.omp/agent/{hooks,tools,agents,skills}` resolve into the repo; `pi` (fnm path) and `omp` (mise+bun path) binaries both reachable; AGENTS.md cutover applied (slice-008.4). Behavioral round-trip drill (real task under omp → revert AGENTS.md → real task under pi) requires interactive operator engagement; <60s target depends on operator typing speed of one git revert. |
| A10 | `bun run typecheck` + `bun run test` baseline | ✅ Pass | 238 pass / 15 skip / 0 fail (was 197/8/0 pre-omp — net +41 tests from `.omp/` ports + slice-008.1/2 additions) |

Architectural constraints surfaced during slice-008.0 are documented in the master spec §5b and motivated the 008.0 / 008.1 / 008.2 split. Slices 008.1, 008.2, 008.3, and 008.4 (cutover) all landed on 2026-04-26.

## Risks tracked

- Bus factor on Oh My Pi (`can1357` is 99% of commits). Pinned version 14.4.0 mitigates upstream-stall blast radius.
- Mid-stream retry is upstream-default-on. Per §5.3 decision, validator and reviewer Gholas have it disabled at the persona level.
- Anthropic billing-classifier surveillance can change at any time. Cheap-model dry-runs are low-volume and unlikely to flag, but production usage warrants monitoring.

## Pending decommission (slice-009)

Once Luci has used the new install for at least one full SpecSafe loop in production AND A8/A9 are verified, slice-009 will:

- Stop and disable `meridian.service`
- Remove the pi-scrub plugin
- Delete or archive `~/.pi/agent/`
- Move repo `.pi/` contents into `archive/` or delete
- Update `AGENTS.md` to remove the legacy-fallback hatch
