# Getting started with pi-seshat

This guide walks through opening the system for the first time. Three sections, in strict order: set the secrets, open the runtime, then hand the agent the first-run prompt that introduces you, interviews you, audits the installation, and applies improvements under your approval.

The goal of the first-run prompt is not to "use" Pi — it is to **boot Seshat into a state where Seshat knows you**. Everything after that flows from that awakening: the Ghola dispatch chain, the Honcho memory graph, the `--i-approve` gates, all of it assumes Seshat has already recalled (or been told) who Luci is, what the project is for, and what the current pain points are. Skipping the interview and going straight to work is possible, but you would be dispatching Gholas who can only read cold-start context from files, not from a living memory of your recent frustrations and goals.

---

## 1. Secrets and environment

### Theory

Pi-Seshat reads environment variables at tool-call time, not at module load. This means you can export a missing key in a new terminal and pick up where you left off without restarting Pi. It also means a subagent spawned by Seshat inherits the parent process's env, including the Honcho identity variables that the subagents-patch extension injects per-dispatch (`HONCHO_WORKSPACE_ID`, `HONCHO_SESSION_ID`, `HONCHO_PEER_ID`).

There are three categories of secret you need to think about:

- **Memory secrets** — `HONCHO_API_KEY` and `HONCHO_PEER_NAME`. Without these, every Honcho tool call returns `errText("HONCHO_API_KEY not set")` and the Ghola personas work in memoryless mode. The memory skill's file-only reads (`memory status`, `memory history`) still work because they read the local `.pi/.honcho-state.json`, but semantic recall and durable conclusions are dead in the water.
- **External-surface secrets** — `LINEAR_API_KEY` and `gh auth`. These gate the four external-surface skills. Partial setup is survivable: if `LINEAR_API_KEY` is missing, the `github pr create` Linear-state invariant auto-skips with a notice (spec-005 Q2); if `gh auth` is missing, the `github` skill refuses with exit 127 and the exact login command. So you can run with one but not the other — it just narrows what the system can do.
- **Test-only secrets** — `HONCHO_TESTS_LIVE=1` and `LINEAR_TESTS_LIVE=1`. These un-skip the integration tests gated by `describe.skipIf(!LIVE)`. Set only when you're running `bun run test:live`.

### Checklist

Paste this into a fresh terminal to see what is and isn't set:

```bash
cd /home/fr/Code/Misc/pi

printf 'HONCHO_API_KEY:   %s\nHONCHO_PEER_NAME: %s\nLINEAR_API_KEY:   %s\n' \
  "$([ -n "$HONCHO_API_KEY" ] && echo "set (${#HONCHO_API_KEY} chars)" || echo "MISSING")" \
  "${HONCHO_PEER_NAME:-MISSING}" \
  "$([ -n "$LINEAR_API_KEY" ] && echo "set (${#LINEAR_API_KEY} chars)" || echo "MISSING")"

gh auth status 2>&1 | grep -E 'Logged in|account' || echo "gh auth: MISSING"
pi --version    || echo "pi: MISSING"
bun --version   || echo "bun: MISSING"
```

Expected healthy output:

```
HONCHO_API_KEY:   set (52 chars)
HONCHO_PEER_NAME: Luci
LINEAR_API_KEY:   set (53 chars)
  ✓ Logged in to github.com as luci-efe
pi 0.70.2
1.3.6
```

### Setting the missing ones

For anything that reports `MISSING`, export it in the terminal and persist via `~/.bashrc`:

```bash
# Honcho — if not already in ~/.bashrc
export HONCHO_API_KEY="hnc_..."
export HONCHO_PEER_NAME="Luci"

# Linear — get a key at Linear → Settings → API → Personal API keys
# Scope: Read + Write (the skill transitions tickets, not just reads)
export LINEAR_API_KEY="lin_api_..."

# GitHub — one-time interactive auth
gh auth login --scopes repo,workflow

# Persist Honcho + Linear keys to ~/.bashrc (idempotent)
grep -q HONCHO_API_KEY ~/.bashrc || echo 'export HONCHO_API_KEY="hnc_..."' >> ~/.bashrc
grep -q HONCHO_PEER_NAME ~/.bashrc || echo 'export HONCHO_PEER_NAME="Luci"' >> ~/.bashrc
grep -q LINEAR_API_KEY ~/.bashrc || echo 'export LINEAR_API_KEY="lin_api_..."' >> ~/.bashrc
```

Replace the placeholder values with real tokens before pasting. Do NOT commit `.bashrc` anywhere visible; it contains secrets in plaintext. The pre-commit hook shipped with this repo (`.githooks/pre-commit`) scans staged diffs for these exact patterns and aborts the commit on match — activate it per-clone with:

```bash
git config core.hooksPath .githooks
```

---

## 2. Opening the system

### Theory

"Opening the system" is a three-step dance: (1) shell-level verification that everything loads, (2) Pi-runtime verification that the three extensions register their tools, (3) a conversational handoff to Seshat. Most first-timers skip step 2 and go straight to step 3, which works — but when something misbehaves, step 2 is the cheapest diagnostic. Running it once gives you a cold-start baseline of "what a healthy Pi looks like" that you can compare against later when something goes wrong.

The three extensions register these tools into Pi's runtime at load time:

- `honcho` registers `honcho_remember`, `honcho_recall`, `honcho_search`, `honcho_conclude`. All gate on `HONCHO_API_KEY`; `honcho_conclude` additionally gates on `HONCHO_PEER_ID` being in the conclusion-writer allowlist (validator, reviewer, steward).
- `specsafe-session` registers `specsafe_begin`, `specsafe_end`, `specsafe_status`. These manage `.pi/.honcho-state.json` which is the single source of truth for "what slice is currently open."
- `specsafe-subagents` registers the `subagent` tool (an enhanced version of Pi's built-in subagent dispatch that injects the Honcho identity env vars into every spawned child and auto-commits with the four trailers on successful exit).

Skills are different from extensions — they are not loaded by Pi at startup. They are invoked by the agent at runtime via `/skill:<name> <args>`, which spawns the skill's CLI as a subprocess. The six skills are all executable without Pi running, which is what step 1 exercises.

### Step 1 — Shell-level smoke (no Pi)

```bash
cd /home/fr/Code/Misc/pi

# Unit + type health
bun run typecheck   # expect clean
bun run test        # expect 156 pass / 8 skip / 0 fail

# Skills respond with their own help / dry-run output
bash .pi/skills/push/bin/push.sh                                    # dry-run preflight
bun run .pi/skills/memory/bin/memory.ts status                      # state-file summary
bun run .pi/skills/latest-docs/bin/latest-docs.ts list              # 11-library registry
./.pi/skills/github/bin/github.sh repo view 2>&1 | head -3          # proves gh auth
bun run .pi/skills/linear/bin/linear.ts list --limit=3 2>&1 | head  # proves LINEAR_API_KEY
```

If any of these exits with an error message mentioning a missing secret, go back to section 1.

### Step 2 — Pi-runtime smoke (opens Pi, closes cleanly)

```bash
cd /home/fr/Code/Misc/pi
pi
```

At the `>` prompt, type:

```
specsafe_status
```

Expected response: `{ currentSlice: null, history: [...] }`. A clean response proves all three extensions loaded and Pi can reach them. If you get "tool not found" or an unhandled error, the extensions didn't register — check `.pi/extensions/*/index.ts` for syntax errors and restart Pi.

Then exit Pi (Ctrl-D or `/exit` depending on your Pi build). This was a health check, not work.

### Step 3 — Re-open Pi for real work

```bash
cd /home/fr/Code/Misc/pi
pi
```

This time, hand Seshat the first-run prompt in section 3 below. Do not ask Seshat to do anything else before that prompt — she needs to awaken knowing who you are before dispatching.

---

## 3. The first-run prompt

### Theory

Seshat starts every conversation cold. She reads `AGENTS.md` to understand her role, but she does not yet know what this specific project is about to you, which of the six skills you use in anger vs. which sit unused, or where the current friction lives. Giving her that context up front — and letting her ask about the gaps — makes every subsequent dispatch sharper.

The prompt below is structured in four phases. Phase 1 introduces you declaratively. Phase 2 is Seshat's silent inventory of the installation state. Phase 3 is a five-question interview that probes your actual usage pattern. Phase 4 is the payoff: Seshat produces a ranked enhancement list, and for every item you greenlight, she dispatches a SpecSafe mini-slice to apply it.

Critically, every applied change still flows through the `--i-approve` gate. Seshat will draft improvements but not push them, not edit Linear, not apply BMad-doc changes without your explicit token on each one. The prompt reinforces this.

### Paste-ready prompt

Copy everything between the `--- BEGIN` and `--- END` lines into Pi at the `>` prompt after opening per step 3 above. Read it once before pasting so nothing surprises you.

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
  • pi-seshat — this repo; custom Pi setup we are currently inside
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

Honcho memory convention:
  • Workspace = one per project (curia, matro, agentic-pm-kit,
    billy, heineken, pi-dev-sandbox for tests). This session is
    workspace=pi-dev-sandbox.
  • Peer = luci (for me), plus one per Ghola.
  • Engineering conclusions come from validator/reviewer peers.
  • Product conclusions come from the steward peer, prefixed
    `product:` — the prefix is code-enforced as of this installation.

── Phase 2 — Silent inventory (no interview questions yet) ──

Read, in parallel where possible:
  • AGENTS.md, README.md, CLAUDE.md
  • .pi/extensions/*/index.ts (honcho, specsafe-session,
    specsafe-subagents)
  • .pi/skills/*/SKILL.md (six skills)
  • .pi/skills/latest-docs/registry.json (note `verified:false` —
    URLs are un-probed)
  • .pi/agents/*.md (seven personas)
  • specs/archive/ (six archived specs — this is the full scope of
    what has been built)
  • git log --oneline -20 — recent commits, trailer patterns
  • .pi/.honcho-state.json if it exists — current slice and cost
    counters

Cross-reference: for every declarative commitment in specs or SKILL.md,
does the implementation match? Note any discrepancy with file:line. Do
NOT print the inventory — hold it in context for Phase 4.

── Phase 3 — Interview me (your job) ──

Ask five structured questions, ONE AT A TIME. Wait for my reply before
the next. Keep each ≤2 sentences. Push back if my answer is vague; ask
ONE follow-up if I give something non-actionable.

  1. "Which of the six skills (push, memory, linear, docs, github,
     latest-docs) have you actually used in live work since they
     landed, and which have sat unused?" — establishes adoption.

  2. "What is the single most friction-heavy thing about how you
     dispatch Gholas today? A concrete example, not a category."
     — elicits UX pain.

  3. "Of the seven personas (five engineering Gholas, Steward,
     doc-scout), which one's body do you find yourself most often
     overriding inline?" — identifies stale personas.

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

For each greenlit enhancement, dispatch a SpecSafe mini-slice:
  1. spec-writer drafts a spec under specs/ with §5 acceptance criteria.
  2. test-writer produces tests against the spec.
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

- **"tool not found: honcho_*"** — Extensions didn't load. Run step 2 smoke, check `.pi/extensions/*/index.ts` for syntax errors.
- **"honcho error: 401"** — `HONCHO_API_KEY` is set but rejected. Confirm the key is current at the Honcho dashboard; keys can be rotated.
- **Seshat ignores the --i-approve gate** — Stop the session immediately and tell her. This is a persona-discipline failure; remind her that all external mutations require your explicit token on each one, cite the rule from `CLAUDE.md`.
- **A Ghola hallucinates a library API** — That's exactly what the `latest-docs` skill + `doc-scout` agent exist to prevent. Tell Seshat to dispatch doc-scout first, cite the rule in the directive block of each engineering Ghola's persona.

---

## 4. After the first session

Once the first-run session closes:

- `.pi/.honcho-state.json` holds the history entries for any slices that closed cleanly.
- `.pi/.push-log.jsonl`, `.pi/.linear-log.jsonl`, `.pi/.github-log.jsonl`, `.pi/.docs-registry-log.jsonl` each hold one JSON line per approved mutation of their respective surface.
- Any enhancements Seshat applied are in the git log as commits with the full four-trailer footer (`Co-Authored-By`, `Spec-Slice`, `Peer`, `Session`).
- The Phase 4 audit document lives at `specs/audit-<YYYY-MM-DD>.md` and should be committed by you (Seshat will not auto-commit specs; that's a step-5-archival action).

From that point forward, every non-trivial change follows the SpecSafe loop: spec → tests → implement → verify → complete + archive. The six skills handle every external mutation. Seshat remembers what the Gholas deposited in Honcho. You stay in the loop via `--i-approve` at every boundary.

The system is production-ready. Everything from here is usage, not setup.
