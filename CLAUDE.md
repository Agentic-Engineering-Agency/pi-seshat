# pi-seshat — project rules for Claude

These rules override generic defaults for work in this repository.
Luci's cross-project rules live at ~/.claude/CLAUDE.md.

## Non-negotiable

- **Always orchestrate, always verify.** Spawn subagents for non-trivial
  work; validate every subagent response with primary evidence before
  relaying. Subagent output is a draft, not a deliverable.
- **Always check latest official docs.** Before writing code against any
  library, dispatch to `doc-scout` or invoke `/skill:latest-docs show <lib>`.
  Training-data recall is not authoritative.
- **--i-approve is sacred.** No mutation to external systems (git push,
  Linear write, GitHub PR open, BMad-doc apply) runs without an explicit
  --i-approve token. Skills enforce; hand-rolled calls need manual gate.
- **Never push without explicit Luci approval.** The push skill enforces
  once invoked; ad-hoc pushes need the same human gate.

## Workflow

- Any non-trivial change follows SpecSafe: spec → tests → implement →
  verify → complete + archive.
- Tests precede implementation. Skip the test-writer step only for
  markdown/config-only slices; use §5 acceptance criteria as the
  verification contract.
- Commit trailers on Ghola-dispatched slices: `Co-Authored-By`,
  `Spec-Slice`, `Peer`, `Session`. Trailers are auto-generated on
  successful subagent exit.

## Skill boundaries

- Extensions for in-process state (Honcho calls, slice lifecycle).
- Skills for external CLI wrappers (gh, linear SDK, git push, BMad-doc
  edits, latest-docs fetchers). Skills NEVER write to in-process state.
- No MCP servers. The Pi README argues for CLIs over MCPs; we honor it.

## Memory discipline

- Engineering conclusions come from `validator` and `reviewer` peers.
- Product conclusions come from `steward` peer, prefixed `product:`
  (enforced both in persona and in code at
  `.pi/extensions/honcho/index.ts`).
- `seshat` and the other Gholas can call `honcho_remember` (scratch
  memory) but not `honcho_conclude`.

## Quality bar

Production engineering product, not prototype. If work is half-baked,
state so explicitly. Luci will redirect rather than rubber-stamp.

## Local hook activation

This repo ships pre-commit hooks in `.githooks/`. To activate them for
your clone (one-time):

```bash
git config core.hooksPath .githooks
```

The hook scans staged changes for obvious secret patterns (HONCHO_*,
LINEAR_*, GITHUB_TOKEN, ANTHROPIC_*, OPENAI_*, AWS_SECRET_*, private
key headers) and aborts the commit if any match. If you hit a false
positive, `git commit --no-verify` bypasses.
