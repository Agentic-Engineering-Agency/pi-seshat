# Getting started with pi-seshat (Oh My Pi runtime)

This guide walks through opening the system for the first time. Three sections, in strict order: set the secrets, open the runtime, then hand the agent the first-run prompt that introduces you, interviews you, audits the installation, and applies improvements under your approval.

The goal of the first-run prompt is not to "use" the agent — it is to **boot Seshat into a state where Seshat knows you**. Everything after that flows from that awakening: the Ghola dispatch chain, the Honcho memory graph, the `--i-approve` gates, all of it assumes Seshat has already recalled (or been told) who Luci is, what the project is for, and what the current pain points are. Skipping the interview and going straight to work is possible, but you would be dispatching Gholas who can only read cold-start context from files, not from a living memory of your recent frustrations and goals.

> **Runtime note (slice-008 cutover, 2026-04-26).** This installation now defaults to the Oh My Pi runtime (`omp` binary, config root `~/.omp/agent/`). Vanilla Pi (`pi` binary, config root `~/.pi/agent/`) coexists per coexistence acceptance criterion A8 and remains the rollback hatch until slice-009 decommissions it. All commands below assume `omp`; the pi-bound equivalents are noted inline where they differ.

---

## 1. Secrets and environment

### Theory

The Honcho custom tool reads its environment variables at tool-call time, not at module load. This means you can export a missing key in a new terminal and pick up where you left off without restarting the runtime. Under vanilla Pi, the slice-002 subagents extension also injected `HONCHO_PEER_ID` per-dispatch via `child_process.spawn`, so each Ghola spoke as itself automatically. **Under Oh My Pi, the `task` tool runs subagents in-process with no per-spawn env-injection seam** (verified in `pi-coding-agent/src/extensibility/hooks/types.ts`). Slice-008.1 replaced that injection with a persona-prompt declaration: each Ghola's system prompt instructs it to pass its own peer identity via the `as_peer` parameter on every Honcho-write call. The custom tool validates the declared identity against the conclusion-writer allowlist (validator/reviewer/steward). The Steward `product:` prefix invariant is enforced both in persona text AND in code as defense-in-depth.

There are three categories of secret you need to think about:

- **Memory secrets** — four required env vars: `HONCHO_API_KEY`, `HONCHO_WORKSPACE_ID`, `HONCHO_PEER_ID`, and a per-CWD `HONCHO_SESSION_ID`. The first three are stable (`HONCHO_API_KEY` from your account, `HONCHO_WORKSPACE_ID="oh-my-pi"` is the per-tool workspace omp writes into, `HONCHO_PEER_ID="Luci"` is your stable identity). The fourth is dynamic — derived from `$(basename "$PWD")` per project, so opening omp in `~/Code/Misc/pi` becomes session `luci-pi`, opening in `~/agentic-engineering/curia-ai` becomes `luci-curia-ai`. The `omp` shell function in section "Setting the missing ones" handles this derivation automatically. Without these, every Honcho tool call returns `errText("Missing required Honcho env vars: ...")` and the Ghola personas work in memoryless mode. Workspaces and sessions auto-create on first reference per Honcho's get-or-create semantics — no pre-provisioning step needed. The memory skill's file-only reads (`memory status`, `memory history`) still work because they read the local `.pi/.honcho-state.json`, but semantic recall and durable conclusions are dead in the water. The state-file path stays under `.pi/` even on the omp runtime — slice-008.0 deferred re-pointing it to slice-009 so coexistence reporting stays accurate.
- **External-surface secrets** — `LINEAR_API_KEY` and `gh auth`. These gate the four external-surface skills under `.omp/skills/`. Partial setup is survivable: if `LINEAR_API_KEY` is missing, the `github pr create` Linear-state invariant auto-skips with a notice (spec-005 Q2); if `gh auth` is missing, the `github` skill refuses with exit 127 and the exact login command. So you can run with one but not the other — it just narrows what the system can do.
- **Test-only secrets** — `HONCHO_TESTS_LIVE=1`, `LINEAR_TESTS_LIVE=1`, and `OMP_LIVE_TESTS=1`. These un-skip the integration tests gated by `describe.skipIf(!LIVE)`. The third one (`OMP_LIVE_TESTS=1`) gates the slice-008.1 identity-propagation integration test under `.omp/test/migration/identity.test.ts`, which is currently scaffolding-only awaiting an omp programmatic dispatch surface. Set only when running `bun run test:live`.

### Checklist

Paste this into a fresh terminal to see what is and isn't set:

```bash
cd /home/fr/Code/Misc/pi

printf 'HONCHO_API_KEY:      %s\nHONCHO_WORKSPACE_ID: %s\nHONCHO_PEER_ID:      %s\nLINEAR_API_KEY:      %s\n' \
  "$([ -n "$HONCHO_API_KEY" ] && echo "set (${#HONCHO_API_KEY} chars)" || echo "MISSING")" \
  "${HONCHO_WORKSPACE_ID:-MISSING}" \
  "${HONCHO_PEER_ID:-MISSING}" \
  "$([ -n "$LINEAR_API_KEY" ] && echo "set (${#LINEAR_API_KEY} chars)" || echo "MISSING")"

# HONCHO_SESSION_ID is derived per-invocation by the omp() shell function — verify the wiring:
type omp 2>&1 | head -5

gh auth status 2>&1 | grep -E 'Logged in|account' || echo "gh auth: MISSING"
omp --version || echo "omp: MISSING (re-source ~/.bashrc and confirm the omp function is defined)"
pi --version || echo "pi: MISSING (rollback hatch — only needed if you intend to fall back)"
bun --version || echo "bun: MISSING"
```

Expected healthy output:

```
HONCHO_API_KEY:      set (66 chars)
HONCHO_WORKSPACE_ID: oh-my-pi
HONCHO_PEER_ID:      Luci
LINEAR_API_KEY:      set (53 chars)
omp is a function
omp ()
{
    PATH="/home/fr/.local/share/mise/installs/bun/1.3.13/bin:$PATH" HONCHO_SESSION_ID="luci-$(basename "$PWD")" command omp "$@"
}
  ✓ Logged in to github.com as luci-efe
omp/14.4.0
pi 0.70.2
1.3.13
```

Note that `omp` is a shell function, not a binary alias. It does two things: prepends the mise-managed bun 1.3.13 path (omp requires bun >=1.3.7 and your shell hooks may have stale 1.3.6 baked in) AND derives `HONCHO_SESSION_ID="luci-$(basename "$PWD")"` per invocation, so each project automatically gets a stable Honcho session named after its directory. No per-project ceremony, no static pinning.

### Setting the missing ones

For anything that reports `MISSING`, export it in the terminal and persist via `~/.bashrc`. The slice-008.6 omp/Honcho block (workspace + peer + the `omp()` function) is the most important addition — without it omp has no session identity and every Honcho call fails:

```bash
# Honcho — API key from app.honcho.dev, workspace and peer per slice-008.6
export HONCHO_API_KEY="hch-v3-..."
export HONCHO_WORKSPACE_ID="oh-my-pi"
export HONCHO_PEER_ID="Luci"

# omp launcher — prepends mise+bun PATH and derives session per CWD
omp() {
  PATH="/home/fr/.local/share/mise/installs/bun/1.3.13/bin:$PATH" \
  HONCHO_SESSION_ID="luci-$(basename "$PWD")" \
  command omp "$@"
}

# Linear — get a key at Linear → Settings → API → Personal API keys
# Scope: Read + Write (the skill transitions tickets, not just reads)
export LINEAR_API_KEY="lin_api_..."

# GitHub — one-time interactive auth
gh auth login --scopes repo,workflow
```

To persist any of these idempotently:

```bash
grep -q HONCHO_API_KEY ~/.bashrc      || echo 'export HONCHO_API_KEY="hch-v3-..."'      >> ~/.bashrc
grep -q HONCHO_WORKSPACE_ID ~/.bashrc || echo 'export HONCHO_WORKSPACE_ID="oh-my-pi"' >> ~/.bashrc
grep -q HONCHO_PEER_ID ~/.bashrc      || echo 'export HONCHO_PEER_ID="Luci"'           >> ~/.bashrc
grep -q LINEAR_API_KEY ~/.bashrc      || echo 'export LINEAR_API_KEY="lin_api_..."'    >> ~/.bashrc
```

Replace the placeholder values with real tokens before pasting. Do NOT commit `.bashrc` anywhere visible; it contains secrets in plaintext. The pre-commit hook shipped with this repo (`.githooks/pre-commit`) scans staged diffs for these exact patterns and aborts the commit on match — activate it per-clone with:

```bash
git config core.hooksPath .githooks
```

---

## 2. Opening the system

### Theory

"Opening the system" is a three-step dance: (1) shell-level verification that everything loads, (2) omp-runtime verification that the hooks register and the symlinks resolve, (3) a conversational handoff to Seshat. Most first-timers skip step 2 and go straight to step 3, which works — but when something misbehaves, step 2 is the cheapest diagnostic. Running it once gives you a cold-start baseline of "what a healthy install looks like" that you can compare against later when something goes wrong.

The two extension surfaces under omp are **hooks** and **custom tools**:

- `.omp/hooks/specsafe-session.ts` — listens on `session_shutdown` and emits the SpecSafe trailer block when a slice is open. Reads `.pi/.honcho-state.json` (still under `.pi/` per slice-008.0 deferral). No tools registered; pure hook.
- `.omp/hooks/specsafe-subagents.ts` — listens on `tool_result` for `task` events; on successful exit (`isError !== true` AND a slice is open), runs `commitSubagentWork` to auto-commit with the four trailers (`Co-Authored-By`, `Spec-Slice`, `Peer`, `Session`). Per-spawn env injection is NOT ported — that's what slice-008.1 worked around via `as_peer`.
- `.omp/hooks/i-approve.ts` — pre-`tool_call` gate that intercepts mutation-pattern tool calls and demands `--i-approve` in the call args. Outer gate; skills retain their own internal checks (defense-in-depth).
- `.omp/hooks/fallback-audit.ts` — subscribes to `auto_retry_*` events and writes a JSONL audit trail. Companion to slice-007's fallback-chain config.
- `.omp/tools/honcho/index.ts` — registers `honcho_recall`, `honcho_search`, `honcho_remember`, `honcho_conclude`. Slice-008.1: `as_peer` is **required** on `honcho_conclude`, **optional** on `honcho_remember` (env fallback when omitted). The conclusion-writer allowlist gates against the declared `as_peer`, not the env.

The omp `task` tool replaces vanilla Pi's `subagent` tool. SpecSafe lifecycle (`begin`/`end`/`status`) is no longer a tool surface under omp — it lives in the hooks above and reads the `.pi/.honcho-state.json` file directly.

Skills are discovered, not loaded. They are invoked by the agent at runtime via `/skill:<name> <args>` or by the operator from the shell. The seven skill bins are all executable without omp running, which is what step 1 exercises.

### Step 1 — Shell-level smoke (no omp)

```bash
cd /home/fr/Code/Misc/pi

# Unit + type health
bun run typecheck   # expect clean
bun run test        # expect 238 pass / 15 skip / 0 fail

# Skills respond with their own help / dry-run output
bash .omp/skills/push/bin/push.sh                                    # dry-run preflight
bun run .omp/skills/memory/bin/memory.ts status                      # state-file summary
bun run .omp/skills/latest-docs/bin/latest-docs.ts list              # 11-library registry
./.omp/skills/github/bin/github.sh repo view 2>&1 | head -3          # proves gh auth
bun run .omp/skills/linear/bin/linear.ts list --limit=3 2>&1 | head  # proves LINEAR_API_KEY
```

If any of these exits with an error message mentioning a missing secret, go back to section 1.

### Step 2 — omp-runtime smoke (opens omp, closes cleanly)

```bash
cd /home/fr/Code/Misc/pi

# Symlinks must resolve into the repo (slice-008.0 install step):
ls -la ~/.omp/agent/{hooks,tools,agents,skills} | grep '^l'
# Expect 4 lines, each pointing into /home/fr/Code/Misc/pi/.omp/...

# Then open omp:
PATH="/home/fr/.local/share/mise/installs/bun/1.3.13/bin:$PATH" omp
```

At the omp prompt, type:

```
PONG?
```

Expected: a single-line answer naming the resolved model (`anthropic/claude-opus-4-7` or whichever fallback link served) and a brief PONG confirmation. A clean response proves the hooks loaded, the personas are reachable, and the model chain is wired.

To probe a specific Ghola directly:

```
Dispatch validator to verify nothing is broken. Have it report PASS/FAIL on the test suite only.
```

Expected: `task` tool spawns a `validator` Ghola, which runs `bun run test`, returns PASS/FAIL, then on PASS calls `honcho_conclude` with `as_peer: 'validator'`. The trailer block in any auto-committed work should show `Peer: validator`.

Then exit omp (Ctrl-D or `/exit`). This was a health check, not work.

### Step 3 — Re-open omp for real work

```bash
cd /home/fr/Code/Misc/pi
PATH="/home/fr/.local/share/mise/installs/bun/1.3.13/bin:$PATH" omp
```

This time, hand Seshat the first-run prompt in section 3 below. Do not ask Seshat to do anything else before that prompt — she needs to awaken knowing who you are before dispatching.

---

## 3. The first-run prompt

### Theory

Seshat starts every conversation cold. She reads `AGENTS.md` to understand her role, but she does not yet know what this specific project is about to you, which of the seven skills you use in anger vs. which sit unused, or where the current friction lives. Giving her that context up front — and letting her ask about the gaps — makes every subsequent dispatch sharper.

The prompt below is structured in four phases. Phase 1 introduces you declaratively. Phase 2 is Seshat's silent inventory of the installation state. Phase 3 is a five-question interview that probes your actual usage pattern. Phase 4 is the payoff: Seshat produces a ranked enhancement list, and for every item you greenlight, she dispatches a SpecSafe mini-slice to apply it.

Critically, every applied change still flows through the `--i-approve` gate. Seshat will draft improvements but not push them, not edit Linear, not apply BMad-doc changes without your explicit token on each one. The prompt reinforces this. The omp `i-approve.ts` hook is now the outer gate; the skills retain their internal checks as defense-in-depth.

### Paste-ready prompt

Copy everything between the `--- BEGIN` and `--- END` lines into omp at the prompt after opening per step 3 above. Read it once before pasting so nothing surprises you.

```
--- BEGIN FIRST-RUN PROMPT ---

Seshat, this is our awakening session. Before any dispatch, you need
to know who I am, what this installation is for, and where the current
friction lives. Four phases, in order.

── Phase 1 — Who I am (read, do not paraphrase back) ──

I am Luci (Fernando Ramos). Principal and Technical Lead at Agentic
Engineering Agency, based in Jalisco, Mexico. 8th-semester Engineering /
Project Management student. Working partner: Lalo. Primary client:
Pablo (Matro project).

Active projects where you will dispatch on my behalf:
  • Curia — Legaltech platform for Mexican lawyers (LFPDPPP-bound)
  • Matro — AI prospecting for Mexican SMBs
  • agentic-pm-kit — PM artifacts, Case-Study oriented
  • pi-seshat — this repo; custom Oh My Pi setup we are currently inside
  • Billy (academic, Project Development) and Heineken (academic,
    Process Design) — treat with production rigor

Working preferences that override generic defaults:
  • English for internal tech; Spanish for client-facing artifacts
  • Narrative-prose explanation first, bullets for action items
  • Theory before examples; expert technical depth
  • CLI-first over MCP servers (the Pi README argues this; I honor it)
  • Disciplined Flow — do NOT side-track; one thing at a time, in order
  • Verification-First — every external mutation gated by --i-approve;
    treat any AI output (mine or a Ghola's) as a draft, not a deliverable
  • Quality-focused — production bar, not prototype
  • Subscription-routed where possible; Kimi is the one API-key
    provider I tolerate (and even Kimi has a subscription path via
    the kimi-code provider)

Honcho memory convention (slice-008.6 wiring):
  • Workspace = `oh-my-pi` for all omp work — one workspace per
    tool, per Honcho design-pattern docs. Cross-project recall ("what
    did I learn about X in any repo?") works because every project's
    sessions live inside this single workspace.
  • Session = `luci-<basename-of-cwd>` — derived per-invocation by
    the omp shell function. Pi-seshat is `luci-pi`, Curia would be
    `luci-curia-ai`, etc. Stable across many sessions in the same
    project; resets context only at the workspace level.
  • Peer = `Luci` for me (orchestrator), plus one per Ghola
    (`validator`, `reviewer`, `steward`, `spec-writer`, `test-writer`,
    `implementer`, `doc-scout`) declared via slice-008.1's `as_peer`
    parameter.

  Conclusion discipline (applies on top of the above wiring):
  • Engineering conclusions come from validator/reviewer peers and use
    no special prefix.
  • Product conclusions come from the steward peer, prefixed
    `product:` — the prefix is code-enforced at the tool layer.
  • Every honcho_conclude call MUST pass `as_peer: '<name>'`
    (slice-008.1 contract; allowlist validates against declared
    identity, not env). honcho_remember may pass `as_peer` optionally,
    with env fallback. Each persona's Memory protocol section
    already encodes this.

── Phase 2 — Silent inventory (no interview questions yet) ──

Read, in parallel where possible:
  • AGENTS.md, README.md, CLAUDE.md
  • .omp/hooks/*.ts (i-approve, specsafe-session, specsafe-subagents,
    fallback-audit) and PORT-NOTES.md
  • .omp/tools/honcho/index.ts and PORT-NOTES.md
  • .omp/skills/*/SKILL.md (seven skills)
  • .omp/skills/latest-docs/registry.json (note `verified:false` —
    URLs are un-probed)
  • .omp/agents/*.md (seven personas — note the model: array and
    thinkingLevel: medium frontmatter from slice-008.3)
  • .pi/extensions/* — the vanilla-Pi extensions still present as the
    rollback hatch; they are NOT modified by the omp port
  • specs/archive/ (ten archived specs through SPEC-008.x — the full
    scope of what has been built)
  • git log --oneline -20 — recent commits, trailer patterns
  • .pi/.honcho-state.json if it exists — current slice and cost
    counters
  • MIGRATION.md — acceptance status table (A1-A10)

Cross-reference: for every declarative commitment in specs or SKILL.md,
does the implementation match? Note any discrepancy with file:line. Do
NOT print the inventory — hold it in context for Phase 4.

── Phase 3 — Interview me (your job) ──

Ask five structured questions, ONE AT A TIME. Wait for my reply before
the next. Keep each ≤2 sentences. Push back if my answer is vague; ask
ONE follow-up if I give something non-actionable.

  1. "Which of the seven skills (push, memory, linear, docs, github,
     latest-docs, plus any new arrivals) have you actually used in
     live work since they landed, and which have sat unused?"
     — establishes adoption.

  2. "What is the single most friction-heavy thing about how you
     dispatch Gholas today under omp? A concrete example, not a
     category." — elicits UX pain after the cutover.

  3. "Of the seven personas (five engineering Gholas, Steward,
     doc-scout), which one's body do you find yourself most often
     overriding inline? Did the slice-008.3 model bindings feel
     right or wrong for any persona?" — identifies stale personas
     and validates the new model assignments.

  4. "What capability is NOT in any current skill that you have
     hit two or more times already?" — surfaces the real next-slice
     candidate.

  5. "If you had 4 hours for hardening this week, no new features,
     where would those hours go?" — calibrates effort vs. appetite.

Tone: professional, senior-DevOps-with-dry-humor. Not deferential.

── Phase 4 — Audit + apply (with --i-approve gate) ──

Produce a markdown document I can save to
`specs/audit-<YYYY-MM-DD>.md` with this structure:

  ## What's working
  3-5 bullets. Cite evidence (commit hash, file:line, or my Q1+Q2
  answer).

  ## What's underused or broken
  3-5 bullets. Same citation requirement. Rank by my Q1+Q2 answers.

  ## Proposed enhancements (ranked by impact-per-effort)
  For each: title | one-paragraph rationale | effort (S/M/L) |
  prerequisite dependencies. Include at least one item from my Q4
  answer elevated to the top if I named anything concrete.

  ## What to explicitly NOT do
  2-3 bullets. Capabilities/patterns I should resist adding because
  they'd violate a load-bearing principle (examples: "no MCP server
  replacements for skills", "no pre-apply-without-approval paths").

  ## Next action
  ONE sentence. The single next thing, and why it's first.

Then ask me: "Which enhancements do you greenlight for immediate
application? Reply with the titles, or 'stop' to end here."

For each greenlit enhancement, dispatch a SpecSafe mini-slice via the
`task` tool:
  1. spec-writer drafts a spec under specs/ with §5 acceptance criteria.
  2. test-writer produces tests against the spec (skip for
     markdown/config-only slices per the documented deviation).
  3. implementer makes the minimum change; never bypasses --i-approve.
  4. validator runs the full suite and returns binary PASS/FAIL.
  5. Before auto-commit, pause and tell me: "Slice X complete,
     Y/0 tests pass. Commit with trailers? (yes/no)"

Markdown/config-only enhancements skip test-writer per the documented
SpecSafe deviation.

Never push. Never open Linear or GitHub PRs. Never apply BMad doc
edits. Any of those must wait for me to invoke the relevant skill with
--i-approve myself.

If Phase 2 genuinely blocks Phase 3 (you cannot read a required file),
stop and tell me — do not fabricate.

--- END FIRST-RUN PROMPT ---
```

### What to expect during the session

Phase 1 and 2 will consume maybe 30-60 seconds of Seshat reading files. Phase 3 will feel like a brief structured interview — five questions, probably 5-10 minutes of your time if you answer thoughtfully. Phase 4 is where the time compounds: each greenlit enhancement triggers a full Ghola chain dispatch, which on average runs 2-5 minutes per slice depending on effort size.

A typical first session produces 2-4 greenlit enhancements before you cap out attention and call it. That's normal. The rest carry over to the next session because the Phase 4 audit document is saved under `specs/audit-<YYYY-MM-DD>.md` and Seshat can read it back in the next session via `honcho_recall` (it will be indexed under your luci peer's memory).

### If something goes wrong

- **"tool not found: honcho_*"** — Custom tool didn't load. Check that `~/.omp/agent/tools` symlinks into the repo's `.omp/tools/`, and that `.omp/tools/honcho/index.ts` has no syntax errors (`bun run typecheck`).
- **"honcho error: 401"** — `HONCHO_API_KEY` is set but rejected. Confirm the key is current at the Honcho dashboard; keys can be rotated.
- **"as_peer is required for honcho_conclude"** — A Ghola tried to write a conclusion without declaring its identity. This is exactly the slice-008.1 contract working as intended. Tell the Ghola to pass `as_peer: '<its-own-name>'`. If it persists, the persona's Memory protocol section may have been edited; restore from `.omp/agents/<name>.md`.
- **Seshat ignores the --i-approve gate** — Stop the session immediately and tell her. This is a persona-discipline failure; remind her that all external mutations require your explicit token on each one, cite the rule from `CLAUDE.md`. The `.omp/hooks/i-approve.ts` hook should also be intercepting — check it's loaded.
- **A Ghola hallucinates a library API** — That's exactly what the `latest-docs` skill + `doc-scout` agent exist to prevent. Tell Seshat to dispatch doc-scout first, cite the rule in the Latest-docs directive of each engineering Ghola's persona.
- **The fallback chain fires unexpectedly** — Inspect `.pi/.fallback-log.jsonl` for the link sequence and per-link error class. The slice-008.3 persona chains have five links each; if you're hitting link 4 or 5 routinely, one of your subscription providers is having a quota issue.

---

## 4. After the first session

Once the first-run session closes:

- `.pi/.honcho-state.json` holds the history entries for any slices that closed cleanly.
- `.pi/.push-log.jsonl`, `.pi/.linear-log.jsonl`, `.pi/.github-log.jsonl`, `.pi/.docs-registry-log.jsonl` each hold one JSON line per approved mutation of their respective surface.
- `.pi/.fallback-log.jsonl` (slice-007) holds one JSON line per fallback decision the chain made.
- Any enhancements Seshat applied are in the git log as commits with the full four-trailer footer (`Co-Authored-By`, `Spec-Slice`, `Peer`, `Session`).
- The Phase 4 audit document lives at `specs/audit-<YYYY-MM-DD>.md` and should be committed by you (Seshat will not auto-commit specs; that's a step-5-archival action).

From that point forward, every non-trivial change follows the SpecSafe loop: spec → tests → implement → verify → complete + archive. The seven skills handle every external mutation. Seshat remembers what the Gholas deposited in Honcho. You stay in the loop via `--i-approve` at every boundary.

The system is production-ready. Everything from here is usage, not setup.
