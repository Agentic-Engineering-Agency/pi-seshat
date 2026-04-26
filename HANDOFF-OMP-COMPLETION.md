# pi-seshat → Oh My Pi completion handoff

**Date of handoff:** 2026-04-26
**Outgoing session:** slice-008.0 implementation
**Repo:** /home/fr/Code/Misc/pi (github.com/Agentic-Engineering-Agency/pi-seshat)
**Last commit on `main`:** `aaede47 slice-008.0: pi-seshat migration onto Oh My Pi (foundation + ports)` — local only, **not yet pushed to origin**.
**Pending objective:** apply all remaining fixes, configs, integration tests, and cutover steps so Luci can use pi-seshat under `omp` end-to-end. Then push.

---

## Paste this prompt into the fresh session

```
You are inheriting a pi-seshat installation that has just landed slice-008.0 of an
Oh My Pi (`omp`) migration. The foundation is committed locally as commit aaede47,
but four things stand between current state and Luci being able to use the system
under omp end-to-end. Your job is to land those four things in disciplined SpecSafe
slices, integration-test each, and then push.

## Who you're working with

You are helping Luci (Fernando Ramos, GitHub luci-efe, info@agenticengineering.agency) —
Principal/Partner and Technical Lead at Agentic Engineering Agency, Jalisco, Mexico.
8th-semester Engineering/Project Management student. Bilingual; English for all
internal/technical work, Spanish for client-facing artifacts.

Load-bearing traits to keep front-of-mind:
- Disciplined Flow — strict order of operations; do not side-track.
- Verification-First — every external mutation gated by an explicit --i-approve
  token, and AI output is a draft requiring primary-evidence validation.
- Orchestrator — dispatches subagents for non-trivial work; expects you to do
  the same for any port, refactor, or integration test.
- Methodical — SpecSafe (spec → tests → implement → verify → archive) is the
  development discipline; never skip a step. BMad-Method handles planning when
  starting from scratch (not relevant here).
- Subscription Optimizer — subscription billing where possible. Anthropic Max
  ($200/mo), OpenAI Plus/Pro, Google Antigravity, Google Gemini CLI, GitHub
  Copilot, Kimi (only API-key-allowed provider).
- Theory before practice; mixed prose/bullet response structure; expert technical
  depth.

## Where the slice-008.0 work landed

Read these files in this order before doing anything:

1. `specs/SPEC-20260426-008-oh-my-pi-migration.md` — the master spec, status
   `phase-1-landed`. §5b documents three architectural beats that motivated
   the 008.0/008.1/008.2 split. §6 describes the SpecSafe verification plan.
2. `MIGRATION.md` at repo root — the operator-facing migration doc with the
   acceptance status table reflecting 008.0 reality (A1, A2, A7, A8, A10
   green; A3, A4, A5 yellow; A6 red; A9 untested).
3. `.omp/README.md` — quick orientation to the layout and how it deploys via
   symlinks into ~/.omp/agent/.
4. `.omp/hooks/PORT-NOTES.md` and `.omp/tools/honcho/PORT-NOTES.md` — the two
   PORT-NOTES files the slice-008.0 ports left for you. They are the most
   accurate source for what got adapted and why.
5. `.pi/extensions/honcho/index.ts`, `.pi/extensions/specsafe-session/index.ts`,
   `.pi/extensions/specsafe-subagents/index.ts` — vanilla-Pi sources you'll
   need to consult when refactoring the skill bin/ scripts.
6. `aaede47` commit message — full rationale for what landed, what was deferred,
   and why.

## What you must deliver before Luci can use pi-seshat under omp

### Slice-008.1 — per-Ghola identity propagation (workaround #2)

Why: `~/.omp/agent/tools/honcho/index.ts`'s allowlist on `honcho_conclude`
reads `process.env.HONCHO_PEER_ID` at call time. Vanilla Pi set that env per
dispatch via its own `subagent` tool's child_process.spawn. Oh My Pi's bundled
`task` tool does NOT expose a per-spawn-env hook seam (verified in slice-008.0
by reading `@oh-my-pi/pi-coding-agent@14.4.0`'s HookAPI; details in
`.omp/hooks/PORT-NOTES.md`). Setting env globally at session_start would leak
across every subprocess and lose per-Ghola identity.

Decided fix (per spec §5b.1): persona-prompt identity declaration. Each Ghola's
system prompt instructs it to declare its peer identity when calling
honcho_conclude; the custom tool validates the declared peer against the
allowlist. Trade-off: degrades from "process-trusted" to "model-trusted" —
a misbehaving model could lie about its identity. Defense-in-depth still
holds because Steward's `product:` prefix is enforced both in persona text
AND code-side.

Concrete work:

1. Spec — write `specs/SPEC-20260426-008.1-persona-prompt-identity.md`
   following the format of `specs/archive/SPEC-20260426-007-cross-provider-fallback.md`.
   §1 Goal, §2 Scope, §3 Implementation constraints, §4 Acceptance criteria,
   §5 Open questions (probably none — the design is decided).
2. Update each `.omp/agents/*.md` persona body to include a "When calling
   honcho_remember or honcho_conclude, you MUST pass your own peer identity
   in the call's `as_peer` (or equivalent) parameter" instruction, in
   identity-natural language for each Ghola. Steward's persona must continue
   to require the `product:` prefix on conclusions.
3. Add an `as_peer` (or equivalent — check the existing tool schema) parameter
   to the `honcho_remember` and `honcho_conclude` tool definitions in
   `.omp/tools/honcho/index.ts`. The tool's execute() validates `as_peer`
   against the allowlist (validator/reviewer/steward) for `honcho_conclude`.
   Steward's `product:` prefix gate continues to fire.
4. Identity-spoofing prevention: cross-check `as_peer` against a session-level
   signal that's harder for the LLM to fake. Options to evaluate:
   - Read the agent name from `ctx.sessionManager.getEntries()` looking for the
     last AgentStartEvent or equivalent — Oh My Pi's session entries should
     record which agent is currently running. Verify in
     `~/.cache/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/session/session-manager.ts`.
   - Or, on session_start in a new hook, write the active agent's name to a
     session-scoped scratch file that the custom tool reads.
   - If neither is reliable, accept the model-trust degradation explicitly
     and document the limitation. The defense-in-depth from Steward's
     prefix invariant still holds.
5. Tests — add unit tests covering the allowlist enforcement with `as_peer`
   parameter. Add an integration test that dispatches through omp's `task`
   tool and verifies the right peer is recorded.
6. Verify acceptance: A4 must turn green at the production level (not just
   unit-test). A5 must turn green for trailers + identity.

### Slice-008.2 — skill bin/ refactor (CLI-first)

Why: `.omp/skills/{memory,docs}/bin/*.ts` (and a few other skills) import
`../../../extensions/{honcho,specsafe-session}/index.ts` via TypeScript path
relatives. Under .omp/ those resolve to .omp/extensions/ which does not exist
(and shouldn't, because Honcho moved to .omp/tools/ and SpecSafe moved to
.omp/hooks/ — different API surfaces). Skills will fail at runtime under omp.

Decided fix (per spec §5b.3): refactor skills to shell out to a thin CLI
wrapper rather than directly TypeScript-importing extension code. Matches
Luci's CLI-first preference (her CLAUDE.md mandates "Skills for external
CLI wrappers"; importing extension internals violated this).

Concrete work:

1. Spec — `specs/SPEC-20260426-008.2-skill-cli-decoupling.md`.
2. Audit which skills actually import extension code. The slice-008.0 skill
   port report flagged memory.ts and docs.ts; verify the rest with a grep.
3. Identify what each import currently uses. Likely: SpecSafe's
   `statePathFor`, slice-state read helpers, Honcho conclusion writers.
4. Create a thin CLI surface for the needed primitives. Two options:
   a. Add CLI subcommands to omp custom tools (probably not — omp's custom
      tool API doesn't expose tools as standalone CLI binaries).
   b. Create runtime-neutral helper scripts at `.omp/lib/` (or a top-level
      `lib/`) that both pi and omp can shell out to. Each helper is a tiny
      bun-runnable script that reads/writes the same on-disk state files
      (.pi/.honcho-state.json, etc.) the extensions did.
   Option (b) is faster and matches the "skills shell out to CLIs" pattern.
5. Refactor the offending skill bin/ scripts to shell out (subprocess) to
   those helpers instead of TypeScript-importing extension paths.
6. Tests — port whatever skill tests existed; add one integration test per
   skill that runs the golden-path command end-to-end under omp.
7. Verify A6 turns green.

### Slice-008.3 — per-persona model+provider assignment

Luci will attach to YOUR session the specific provider+model mapping she
wants for each Ghola. When she does, the mapping looks something like:

  spec-writer:  anthropic/claude-opus-4-7:high
  test-writer:  anthropic/claude-sonnet-4-6:high
  implementer:  github-copilot/gpt-5:high
  validator:    anthropic/claude-opus-4-7:high
  reviewer:     anthropic/claude-opus-4-7:high
  steward:      anthropic/claude-opus-4-7:medium
  doc-scout:    google-antigravity/gemini-3.1-pro:medium

(The above is illustrative; use the mapping she gives you.)

Add `model: <provider/model:reasoningLevel>` to each persona's frontmatter.
Verify the format against `~/.cache/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/agents/`
or the OMP "agents" directory in its source tree. If a per-persona fallback
chain override is also wanted (e.g., validator's chain stays on Anthropic),
configure those via `omp config set retry.fallbackChains` with Ghola-keyed
chain entries and reference them from the persona frontmatter.

This is the smallest of the three slices — mostly mechanical YAML edits
across seven .md files plus one round of validation that omp picks up the
overrides. Bundle it with 008.1 if it makes the spec lighter; otherwise
keep it separate.

### Slice-008.4 — A9 rollback drill + AGENTS.md cutover

When 008.1 + 008.2 + 008.3 are green, do the cutover:

1. Confirm A3 (fallback chain integration), A4 (Honcho production), A5
   (Ghola dispatch), A6 (skills), A7 (--i-approve gate) all flip from
   yellow/red to green via integration tests under real omp.
2. Run the rollback drill (A9): edit `AGENTS.md` to point dispatch at omp,
   confirm a small task runs end-to-end. Then edit AGENTS.md back to pi,
   confirm the original install still works. Time the round-trip; target
   <60 seconds.
3. Update MIGRATION.md's acceptance table to all-green.
4. Update `specs/SPEC-20260426-008-oh-my-pi-migration.md` status from
   `phase-1-landed` to `archived` and move it to `specs/archive/`.

### Push

Once all of the above is green and the cutover is committed, Luci will
greenlight pushing. The push skill enforces --i-approve; do not push
without explicit "push the commits" + --i-approve from Luci. The aaede47
commit (slice-008.0) will be in the same push.

## Order of operations — strict

  Phase 0 — Verify state on arrival, before touching anything:

  cd /home/fr/Code/Misc/pi
  git log --oneline | head -5            # expect aaede47 at HEAD
  git status --short                      # expect clean (or untracked .omp/ runtime cruft)
  bun run typecheck                       # expect clean
  bun run test                            # expect 218 pass / 14 skip / 0 fail
  ls -la ~/.omp/agent/                    # expect symlinks for hooks/tools/agents/skills
  systemctl --user is-active meridian.service   # expect "active"
  PATH="/home/fr/.local/share/mise/installs/bun/1.3.13/bin:/home/fr/.cache/.bun/bin:$PATH" omp --version
                                          # expect omp/14.4.0
  PATH=as-above omp config get retry.fallbackChains
                                          # expect populated chain JSON

  If any check returns unexpectedly, surface to Luci before proceeding.

  Phase 1 — Wait for Luci to attach the per-persona model+provider mapping
  (slice-008.3 input). She said she would.

  Phase 2 — Open slice-008.1 spec, dispatch test-writer to write tests, then
  implementer to land the work. Verify acceptance. Commit with full SpecSafe
  trailers (Co-Authored-By + Spec-Slice + Peer + Session).

  Phase 3 — Open slice-008.2 spec, same dispatch pattern. Commit.

  Phase 4 — Apply slice-008.3 (the persona model assignments). Commit.

  Phase 5 — Run A9 rollback drill. If green, cut AGENTS.md over to omp.
  Commit.

  Phase 6 — Run the full A1-A10 integration suite one more time end-to-end.
  Update MIGRATION.md. Archive the spec. Final commit.

  Phase 7 — Surface readiness to push to Luci. Wait for her explicit
  --i-approve. Then push using the push skill.

## Constraints — non-negotiable

- Always orchestrate, always verify. Spawn subagents (Opus for synthesis/
  spec-writing/QA, Sonnet for routine implementation) for non-trivial tasks.
  Validate every subagent response with primary evidence — file:line
  citations, fresh tool calls, your own re-runs of test commands. Subagent
  output is a draft.
- Always check latest official docs before writing code against any library.
  In this slice's case the relevant "library" is `@oh-my-pi/pi-coding-agent`
  itself; consult its installed source at
  `/home/fr/.cache/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/`
  rather than memory or web search.
- The `--i-approve` idiom is sacred. No git push, no Linear write, no PR
  open, no npm publish without an explicit token in Luci's most recent
  message. The .omp/hooks/i-approve.ts hook is now the outer gate AND the
  skills retain their internal checks (defense-in-depth).
- Never push without explicit Luci approval. Push happens at the very end
  of this whole sequence, not before.
- SpecSafe loop on every non-trivial change: spec → tests → implement →
  verify → complete + archive. Test files precede implementation. The
  test-writer step CAN be skipped only for markdown/config-only slices
  (008.3 might qualify; 008.1 and 008.2 do not).
- English for internal documentation. Spanish only for client-facing
  artifacts (none in this slice).
- Subscription-only billing where possible. Direct API keys are an
  explicit fallback; Kimi K2.6 is the only API-key-required provider Luci
  tolerates. Default fallback chain configured per slice-007 / slice-008
  spec is `anthropic/claude-opus-4-7 → github-copilot/gpt-5 →
  google-antigravity/gemini-3.1-pro`. Do NOT configure Codex via ChatGPT
  account or Gemini CLI as fallback links — both are empirically broken
  per A2 testing (see MIGRATION.md "empirical findings").
- Bun on this system is 1.3.13 via mise. Oh My Pi requires >=1.3.7. Always
  prepend `PATH="/home/fr/.local/share/mise/installs/bun/1.3.13/bin:/home/fr/.cache/.bun/bin:$PATH"`
  for omp invocations because the shell hooks may have stale 1.3.6 paths
  baked in.

## What can go wrong and how to recover

- If slice-008.1's `as_peer`-against-session-record verification turns out
  to be unreliable (i.e., Oh My Pi doesn't expose agent identity in
  session entries cleanly), DO NOT fabricate the API. Fall back to "model-
  trust + Steward prefix defense-in-depth" and document the limitation
  explicitly in the spec. Surface to Luci.
- If slice-008.2's CLI-helper approach gets ugly because the helpers need
  to pull in too much extension surface, evaluate Option (a) (TypeScript
  shared lib) instead. Either is acceptable; the principle is "skills
  must not import vanilla-Pi extension paths."
- If integration tests fail under real omp dispatch but unit tests pass,
  it almost certainly means an env-var or symlink-resolution issue.
  Verify ~/.omp/agent/{hooks,tools,agents,skills} are all symlinks
  pointing into the repo's .omp/ before debugging deeper.
- If Anthropic's billing classifier ever flags the omp stealth path mid-
  flight (an A2 regression), rollback is one AGENTS.md edit. Meridian +
  pi-scrub remain alive throughout this whole sequence per spec §3.7;
  decommission is slice-009, not before.

## Final word

The migration's load-bearing question — whether Oh My Pi's Anthropic
stealth path survives the April 2026 billing classifier on Luci's Max
plan — is empirically PASSED. Everything in this handoff is engineering
follow-through, not existential risk. Luci values rigorous PASS/FAIL
gating; do not declare A4/A5/A6 green without integration evidence under
real omp dispatch (not unit tests with env-var stubs).

Begin with Phase 0 verification. Wait for Luci to attach the per-persona
model+provider mapping. Then proceed Phase 2 onward.
```

---

## Notes for the outgoing session (you, right now)

- File written to `/home/fr/Code/Misc/pi/HANDOFF-OMP-COMPLETION.md`. Untracked. Commit-decision is yours.
- The prompt is self-contained for a fresh session and assumes zero prior conversation context.
- Luci will attach the per-persona model+provider mapping to whatever new conversation she starts with this prompt.
- The previous handoff (HANDOFF-OH-MY-PI.md) is now committed in `aaede47` as a historical artifact — leave it alone.
- Slice-008.0's commit `aaede47` is local-only, NOT pushed. The handoff explicitly tells the next session not to push speculatively; push happens at the very end after the cutover is green.

If you want me to commit this handoff doc or do anything else before ending this session, say the word.
