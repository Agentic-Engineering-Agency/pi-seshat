# pi-seshat

Custom Pi installation that layers **Seshat the Ghola v2** — a memory-bearing
orchestrator — on top of @oh-my-pi/pi-coding-agent. Adds Honcho-backed
durable memory with three-layer identity enforcement, SpecSafe v2 session
lifecycle with per-slice cost accounting, agent-aware git commit trailers,
14 CLI-wrapped skills (six external-surface, eight internal-tooling) all
gated behind an `--i-approve` idiom, a universal `verify` contract runner,
a `coherence` drift checker, a `bootstrap` skill that propagates the system
to any other project via symlink, and `autopilot` cross-session mission
continuity that survives omp's 70% auto-handoff boundary.

The name: Seshat is the Egyptian goddess of writing and records; a Ghola
is a Dune-universe regrown-consciousness. The system reflects both —
Seshat holds the long record, the Gholas are single-purpose consciousnesses
awakened for one bounded task and dismissed on exit.

## What's here

Three tiers of Pi extension, plus the v2 enforcement and autonomy layers:

- **Agents** (`.omp/agents/*.md`) — 13 declarative personas: ten engineering
  Gholas (architect, spec-writer, test-writer, implementer, validator,
  reviewer, reviewer-code, reviewer-lite, security-reviewer, docs-writer),
  two product owners (steward, release-steward), and doc-scout (fetches
  latest official docs before code). Each persona carries a curated
  primary-model + 2-3 fallback chain assigned from the authenticated model
  palette.
- **Hooks and tools** (`.omp/hooks/*.ts`, `.omp/extensions/*.ts`,
  `.omp/tools/honcho/index.ts`) — ported lifecycle hooks (`specsafe-session`,
  `specsafe-subagents`, `i-approve`, `fallback-audit`, `autopilot`) plus
  three v2 enforcement extensions (`identity-gate`, TTSR rule reminders,
  TDD iron law). The Honcho memory bridge is implemented as an omp
  `CustomToolFactory` (see `.omp/tools/honcho/PORT-NOTES.md`). The vanilla
  `.pi/extensions/` tree remains as the rollback hatch (slice-008.4
  cutover; A8 acceptance).
- **Skills** (`.omp/skills/<name>/{bin/,SKILL.md,README.md}`) — 15
  CLI-wrapped capabilities: six external-surface (push, memory, linear,
  docs, github, latest-docs) and nine internal-tooling (specsafe slice
  lifecycle, env-doctor pre-flight, coherence drift checker, verify
  contract runner, state durable context, mission UH packet shim,
  bootstrap project initializer, deploy global installer, autopilot
  cross-session continuity). Every external mutation is `--i-approve`-
  gated and writes a forensic JSONL audit log (mode 0600, gitignored).

### v2 enforcement planes (code, not prose)

Invariants are enforced in code; prose alone is not load-bearing:

- **identity-gate** (`.omp/extensions/identity-gate.ts`) — `tool_call`
  interceptor that blocks `honcho_conclude` / `honcho_remember` with
  missing, unknown, or spoofed `as_peer` and appends every decision
  (allow AND deny) to `~/.omp/agent/.identity-audit.jsonl`. Layered with
  the TTSR rule and the tool-internal allowlist.
- **TTSR rules** (`.omp/rules/*.mdc`) — `identity-peer-gate.mdc` corrects
  mid-stream when a `honcho_conclude` lands without a valid persona;
  `tdd-iron-law.mdc` interrupts production edits to demand RED-before-GREEN.
- **i-approve gate** (`.omp/hooks/i-approve.ts`) — blocks `git push`,
  `gh ... create/merge/...`, `linear-cli`, `bmad-doc apply`, and
  `npm|bun publish` unless the latest user message contains the literal
  `--i-approve` token.
- **verify skill** (`.omp/skills/verify`) — machine-checks every
  acceptance criterion (`check_command` + `severity`). Code gates on
  tests; docs/config gate on a non-test `check_command`. Nothing ships
  unverified — there is no "skip checks for markdown" carve-out.
- **state skill** (`.omp/skills/state`) — durable cross-session mission
  context (`.omp/.state.json` + `STATE.md`) so heavy facts survive
  compaction and session restarts.

## SpecSafe workflow

Every non-trivial change follows a five-step loop: spec → tests →
implement → verify/QA → complete + archive. Specs live in `specs/`
until committed; archived specs move to `specs/archive/`. Tests are
written before implementation. The verify step is binary PASS/FAIL;
FAIL loops back, PASS advances.

SpecSafe v2 adds scale-level classification (L0 trivial → L4
enterprise) and prunes the persona chain to the smallest level that
fits the mission. At L3+ the architect runs up front; at L4 the
release-steward assembles the promotion record and UH mission packet.

Markdown/config-only slices skip the test-writer step and use the
spec's §5 acceptance criteria as the verification contract. This is
a documented deviation from canonical SpecSafe's "no stage skipping"
invariant.

## Honcho identity model

- **Workspace** = `oh-my-pi`. One workspace per tool, per Honcho's design-pattern docs. All projects (curia, matro, agentic-pm-kit, billy, heineken, pi-seshat itself) share this single workspace; cross-project recall works because every project's sessions live in it.
- **Session** = `luci-<basename-of-cwd>`. Derived per invocation by the `omp` shell function from the cwd. Pi-seshat is `luci-pi-seshat`, Curia is `luci-curia-ai`, etc. Stable across many sessions in the same project.
- **Peers** = `Luci` (human/orchestrator) plus one per Ghola: `validator`, `reviewer`, `reviewer-code`, `security-reviewer`, `steward`, `release-steward`. Only these six personas may call `honcho_conclude`; the identity-gate extension enforces the allowlist at the `tool_call` boundary and audits every decision. `honcho_remember` may pass `as_peer` optionally with env fallback.

Per-spawn child-env-injection (the vanilla-Pi `subagent` flow described in earlier revisions of this section) was deliberately not ported under omp — see `.omp/hooks/PORT-NOTES.md` §specsafe-subagents for the rationale and the model-trusted `as_peer` contract that replaces it (SPEC-20260426-008.1, hardened in v2.1 by `identity-gate` + TTSR).

## Autonomous missions (autopilot + 70% auto-handoff)

A mission can run to completion **across many sessions** without
re-priming context by hand. Three layers cooperate:

1. **Goal Mode** (native; configured in `.omp/config.yml` →
   `goal.enabled: true`, `continuationModes: [interactive]`) — the
   autonomous, auto-continuing loop *within* a session.
2. **Auto-handoff at 70%** (native; `.omp/config.yml` →
   `compaction.strategy: handoff`, `thresholdPercent: 70`,
   `autoContinue: true`, `handoffSaveToDisk: true`) — at 70% context
   omp writes a handoff document, saves it to the artifacts dir,
   injects `<handoff-context>`, and continues in a new in-process session.
3. **autopilot** (`.omp/skills/autopilot`, `/skill:autopilot`) —
   bridges the boundary omp pauses by design
   (`GoalRuntime.onThreadResumed` deliberately PAUSES an active goal on
   every session resume/switch). The bridge mirrors the objective to
   `.omp/.autopilot.json` and re-arms the goal at each `session_start`
   / `session_switch`, so the loop survives both auto-handoffs and
   full process restarts.

Run the orchestrator on a 1M-context model — the 70% trigger must
leave ample working room; autopilot warns at a boundary if the window
is < 1M.

## Getting started

Required environment:

```bash
export HONCHO_API_KEY="hch-v3-..."
export HONCHO_WORKSPACE_ID="oh-my-pi"
export HONCHO_PEER_ID="Luci"
export LINEAR_API_KEY="lin_api_..."
gh auth login --scopes repo,workflow
```

The `omp` shell wrapper (defined in `~/.zshrc`) derives
`HONCHO_SESSION_ID="luci-$(basename $PWD)"` per invocation and pins
`bun >=1.3.7`. With the symlinks installed by the `deploy` skill, every
project gets the orchestrator, Gholas, rules, and skills without a
per-project install.

See `GETTING-STARTED.md` for the full opening sequence and
smoke-pass checklist.

## Cast

- **Seshat the Ghola** (`AGENTS.md`) — the memory-bearing orchestrator persona. Coordinates Gholas through the full spec-first loop, delegates work, and reads from Honcho but is not itself a Honcho peer and does not write durable conclusions.
- **architect** *(L3+)* (`.omp/agents/architect.md`) — up-front technical design + acceptance skeleton for complex multi-component missions. Write-only to `specs/design/`.
- **spec-writer** (`.omp/agents/spec-writer.md`) — produces a concrete, testable implementation spec from the delegated request.
- **test-writer** (`.omp/agents/test-writer.md`) — derives or updates tests from the spec before implementation begins.
- **implementer** (`.omp/agents/implementer.md`) — makes the smallest coherent production changes that satisfy the spec and tests.
- **validator** (`.omp/agents/validator.md`) — runs verification, reports pass/fail, and writes durable engineering lessons on PASS via `honcho_conclude`.
- **reviewer** (`.omp/agents/reviewer.md`) — stage-1 spec-compliance review; writes the matching post-merge retrospective via `honcho_conclude`.
- **reviewer-code** (`.omp/agents/reviewer-code.md`) — stage-2 code-quality review; distrusts the implementer, audits maintainability/edge cases/test quality.
- **reviewer-lite** *(opt-in)* (`.omp/agents/reviewer-lite.md`) — cost-optimized second-opinion reviewer (MiniMax). Not in any default chain; run alongside `reviewer-code` for model diversity, or swap in for cost-sensitive L0–L1 work.
- **security-reviewer** *(L3+)* (`.omp/agents/security-reviewer.md`) — injection / authz / secrets / supply-chain / data-exposure audit before promote.
- **docs-writer** *(L2+ optional)* (`.omp/agents/docs-writer.md`) — updates OUR user-facing docs (≠ doc-scout, which fetches external library docs).
- **Steward** (`.omp/agents/steward.md`) — product owner per project (Honcho workspace-scoped). Intakes Linear tickets, writes briefs, proposes BMad-doc edits (never applies), and writes durable `product:`-prefixed conclusions.
- **release-steward** *(L4)* (`.omp/agents/release-steward.md`) — promotion gate; assembles the promotion record and UH mission packet, drafts the release (dry-run; Luci applies with `--i-approve`).
- **doc-scout** (`.omp/agents/doc-scout.md`) — fetches the latest official docs for a named library via the `latest-docs` skill and returns a synthesis with verbatim code blocks. No write, no edit, no bash. Core enforcement rule: training-data recall is not authoritative; only the cache-dated Markdown from the canonical vendor URL is.
