# pi-seshat

Custom Pi installation that layers Seshat the Ghola — a memory-bearing
orchestrator — on top of @mariozechner/pi-coding-agent. Adds Honcho-backed
durable memory, SpecSafe session lifecycle with per-slice cost accounting,
agent-aware git commit trailers, and six safety-wrapped external-surface
skills (push, memory, linear, docs, github, latest-docs) gated behind an
--i-approve idiom.

The name: Seshat is the Egyptian goddess of writing and records; a Ghola
is a Dune-universe regrown-consciousness. The system reflects both —
Seshat holds the long record, the Gholas are single-purpose consciousnesses
awakened for one bounded task and dismissed on exit.

## What's here

Three tiers of Pi extension:

- **Agents** (`.pi/agents/*.md`) — seven declarative personas: five
  engineering Gholas (spec-writer, test-writer, implementer, validator,
  reviewer), plus the Steward (product-owner per project) and doc-scout
  (fetches latest official docs before code).
- **Extensions** (`.pi/extensions/*/index.ts`) — three imperative
  TypeScript modules: `honcho` (memory bridge with conclusion-writer
  allowlist), `specsafe-session` (slice lifecycle + cost counters),
  `specsafe-subagents` (the subagent dispatcher, patched to inject
  Honcho identity into spawned children and auto-commit on exit).
- **Skills** (`.pi/skills/<name>/{bin/,SKILL.md,README.md}`) — six
  CLI-wrapped capabilities. Every external mutation is `--i-approve`-
  gated and writes a forensic JSONL audit log (mode 0600, gitignored).

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

- **Workspace** = one per project (curia, matro, agentic-pm-kit,
  billy, heineken, plus pi-dev-sandbox for tests).
- **Session** = one SpecSafe slice. Naming: `<LINEAR-KEY>__<slug>`
  when tied to a Linear ticket (e.g. `CUR-92__login-fix`),
  `SPEC-<YYYYMMDD>-NNN` for meta work.
- **Peers** = flat, workspace-scoped: `luci` (human), `seshat`
  (orchestrator), and one peer per Ghola (spec-writer,
  test-writer, implementer, validator, reviewer, steward,
  doc-scout).

Parent Pi opens a session via `specsafe_begin(sliceId, workspaceId)`.
State persists at `.pi/.honcho-state.json` (mode 0600). When Seshat
dispatches via `subagent(...)`, the child inherits `HONCHO_WORKSPACE_ID`,
`HONCHO_SESSION_ID`, `HONCHO_PEER_ID=<agent.name>`, and
`SPECSAFE_SLICE_ID` through env injection. On successful exit with
a slice open, the orchestration layer auto-commits with trailers:
`Co-Authored-By`, `Spec-Slice`, `Peer`, `Session`. Never auto-pushes.

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

- **Seshat the Ghola** (`AGENTS.md`) — the memory-bearing orchestrator. Coordinates the full spec-first loop, delegates to Gholas, and reads from Honcho but does not write durable conclusions.
- **spec-writer** (`.pi/agents/spec-writer.md`) — produces a concrete, testable implementation spec from the delegated request.
- **test-writer** (`.pi/agents/test-writer.md`) — derives or updates tests from the spec before implementation begins.
- **implementer** (`.pi/agents/implementer.md`) — makes the smallest coherent production changes that satisfy the spec and tests.
- **validator** (`.pi/agents/validator.md`) — runs verification, reports pass/fail, and writes durable engineering lessons on PASS via `honcho_conclude`.
- **reviewer** (`.pi/agents/reviewer.md`) — performs a final engineering review and writes post-merge retrospective lessons via `honcho_conclude`.
- **Steward** (`.pi/agents/steward.md`) — product owner per project (Honcho workspace-scoped). Intakes Linear tickets, writes briefs, proposes BMad-doc edits (never applies), and writes durable `product:`-prefixed conclusions.
- **doc-scout** (`.pi/agents/doc-scout.md`) — fetches the latest official docs for a named library via the `latest-docs` skill and returns a synthesis with verbatim code blocks. No write, no edit, no bash. Core enforcement rule: training-data recall is not authoritative; only the cache-dated Markdown from the canonical vendor URL is.
