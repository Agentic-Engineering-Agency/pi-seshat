# pi-seshat

Custom Pi installation that layers Seshat the Ghola — a memory-bearing
orchestrator — on top of @mariozechner/pi-coding-agent. Adds Honcho-backed
durable memory, SpecSafe session lifecycle with per-slice cost accounting,
agent-aware git commit trailers, eight safety-wrapped external-surface skills
(push, memory, linear, docs, github, latest-docs, specsafe, env-doctor) gated
behind an --i-approve idiom, a `coherence` consistency checker, and a
`bootstrap` skill that propagates the system to any other project via symlink.

The name: Seshat is the Egyptian goddess of writing and records; a Ghola
is a Dune-universe regrown-consciousness. The system reflects both —
Seshat holds the long record, the Gholas are single-purpose consciousnesses
awakened for one bounded task and dismissed on exit.

## What's here

Three tiers of Pi extension:

- **Agents** (`.omp/agents/*.md`) — seven declarative personas: five
  engineering Gholas (spec-writer, test-writer, implementer, validator,
  reviewer), plus the Steward (product-owner per project) and doc-scout
  (fetches latest official docs before code).
- **Hooks and tools** (`.omp/hooks/*.ts`, `.omp/tools/honcho/index.ts`) — ported lifecycle hooks (`specsafe-session`, `specsafe-subagents`, `i-approve`, `fallback-audit`) and the Honcho memory bridge as an omp `CustomToolFactory`. See `.omp/hooks/PORT-NOTES.md` and `.omp/tools/honcho/PORT-NOTES.md` for what was ported faithfully and what was deliberately dropped. The vanilla `.pi/extensions/` tree remains as the rollback hatch (slice-008.4 cutover; A8 acceptance).
- **Skills** (`.omp/skills/<name>/{bin/,SKILL.md,README.md}`) -- nine CLI-wrapped capabilities: six external-surface (push, memory, linear, docs, github, latest-docs) and three internal-tooling (specsafe slice lifecycle, env-doctor pre-flight, coherence drift checker), plus a `bootstrap` skill that initializes any foreign project to use this system via `.omp` symlink + AGENTS.md/CLAUDE.md templates. Every external mutation is `--i-approve`-gated and writes a forensic JSONL audit log (mode 0600, gitignored).

## SpecSafe workflow

Every non-trivial change follows a five-step loop: spec → tests →
implement → verify/QA → complete + archive. Specs live in `specs/`
until committed; archived specs move to `specs/archive/`. Tests are
written before implementation. The verify step is binary PASS/FAIL;
FAIL loops back, PASS advances.

Markdown/config-only slices skip the test-writer step and use the
spec's §5 acceptance criteria as the verification contract. This is
a documented deviation from canonical SpecSafe's "no stage skipping"
invariant.

## Honcho identity model

- **Workspace** = `oh-my-pi`. One workspace per tool, per Honcho's design-pattern docs. All projects (curia, matro, agentic-pm-kit, billy, heineken, pi-seshat itself) share this single workspace; cross-project recall works because every project's sessions live in it.
- **Session** = `luci-<basename-of-cwd>`. Derived per invocation by the `omp` shell function from the cwd. Pi-seshat is `luci-pi`, Curia is `luci-curia-ai`, etc. Stable across many sessions in the same project.
- **Peers** = `Luci` (human/orchestrator) plus one per Ghola: `validator`, `reviewer`, `steward`, `spec-writer`, `test-writer`, `implementer`, `doc-scout`. Every `honcho_conclude` call MUST pass `as_peer: '<name>'` (slice-008.1 contract; the allowlist validates against the declared identity, not env). `honcho_remember` may pass `as_peer` optionally with env fallback.

Per-spawn child-env-injection (the vanilla-Pi `subagent` flow described in earlier revisions of this section) was deliberately not ported under omp — see `.omp/hooks/PORT-NOTES.md` §specsafe-subagents for the rationale and the model-trusted `as_peer` contract that replaces it (SPEC-20260426-008.1).

## Getting started

Required environment:

```bash
export HONCHO_API_KEY="hnc_..."
export HONCHO_PEER_NAME="Luci"
export LINEAR_API_KEY="lin_api_..."
gh auth login --scopes repo,workflow
```

See `GETTING-STARTED.md` for the full opening sequence and
smoke-pass checklist.

## Cast

- **Seshat the Ghola** (`AGENTS.md`) — the memory-bearing orchestrator persona. Coordinates Gholas through the full spec-first loop, delegates work, and reads from Honcho but is not itself a Honcho peer and does not write durable conclusions.
- **spec-writer** (`.omp/agents/spec-writer.md`) — produces a concrete, testable implementation spec from the delegated request.
- **test-writer** (`.omp/agents/test-writer.md`) — derives or updates tests from the spec before implementation begins.
- **implementer** (`.omp/agents/implementer.md`) — makes the smallest coherent production changes that satisfy the spec and tests.
- **validator** (`.omp/agents/validator.md`) — runs verification, reports pass/fail, and writes durable engineering lessons on PASS via `honcho_conclude`.
- **reviewer** (`.omp/agents/reviewer.md`) — performs a final engineering review and writes post-merge retrospective lessons via `honcho_conclude`.
- **Steward** (`.omp/agents/steward.md`) — product owner per project (Honcho workspace-scoped). Intakes Linear tickets, writes briefs, proposes BMad-doc edits (never applies), and writes durable `product:`-prefixed conclusions.
- **doc-scout** (`.omp/agents/doc-scout.md`) — fetches the latest official docs for a named library via the `latest-docs` skill and returns a synthesis with verbatim code blocks. No write, no edit, no bash. Core enforcement rule: training-data recall is not authoritative; only the cache-dated Markdown from the canonical vendor URL is.
