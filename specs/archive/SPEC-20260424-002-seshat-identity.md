---
id: SPEC-20260424-002
slug: seshat-identity
slice: 2 of 6
title: Establish Seshat the Ghola orchestrator identity + update subagent markdowns
status: archived
author: seshat (drafted on behalf of luci)
created: 2026-04-24
depends_on: [SPEC-20260424-001]
linear: n/a
---

# SPEC-002 — Seshat Identity + Agent Markdown Updates

## 1. Goal

Transform the generic orchestrator described in `AGENTS.md` into **Seshat the Ghola**, and update the five existing subagent markdowns (`spec-writer`, `test-writer`, `implementer`, `validator`, `reviewer`) to (a) adopt the Ghola vocabulary, (b) invoke `honcho_*` tools at entry/exit, and (c) carry explicit `tools:` allowlists that reflect each role's permitted capabilities — including the conclusion-writer policy from Spec 001.

## 2. Why now

Spec 001 wires the memory plumbing; without Spec 002 the agents never call `honcho_recall` / `honcho_remember` because their prompts don't instruct them to. Memory exists but is unused. Also: Seshat's identity is how we differentiate this Pi install from vanilla Pi for anyone watching over the shoulder.

## 3. Scope

In scope:

- Rewrite `AGENTS.md` to establish Seshat the Ghola as the main persona. Describe the Seshat/Ghola/Steward mental model inline (≤200 words) so the orchestrator self-identifies correctly at every turn.
- Update `spec-writer.md`, `test-writer.md`, `implementer.md`, `validator.md`, `reviewer.md`:
  - Add `tools:` frontmatter line listing exactly the tools that agent may use (conclusion-writer policy enforced).
  - Add a short "Memory protocol" section to each body: one line for entry recall, one line for exit remember, and (for validator/reviewer) the conclusion rule.
  - Add Ghola framing in the opening paragraph (brief, not cosplay — one sentence).
- Add a top-level `README.md` section (amended, not replaced) listing Seshat, the Gholas, and the upcoming Steward so that a reader of the repo understands the cast.

Not in scope (later slices):

- Adding the `steward`, `doc-scout` agents — slices 4 and 6.
- Any new tools — slices 3–6.
- Theme/prompt-prefix chalk — optional post-v1.

## 4. Implementation constraints

- Keep each agent markdown under 60 lines. Pi loads these verbatim as system prompts; bloating them burns context.
- Every agent's `tools:` line MUST be explicit. No implicit allowlists.
- Ghola framing is a *descriptive* sentence, not roleplay — no second-person narration, no Dune quotes, no thematic ornamentation beyond "you are a Ghola awakened for this task."
- All prose in English.

### 4.1 Tool allowlists (per agent)

| Agent | Tools |
|---|---|
| `spec-writer` | `read,find,grep,ls,write,honcho_recall,honcho_search,honcho_remember` |
| `test-writer` | `read,find,grep,ls,write,edit,bash,honcho_recall,honcho_search,honcho_remember` |
| `implementer` | `read,find,grep,ls,write,edit,bash,honcho_recall,honcho_search,honcho_remember` |
| `validator` | `read,find,grep,ls,bash,honcho_recall,honcho_search,honcho_remember,honcho_conclude` |
| `reviewer` | `read,find,grep,ls,honcho_recall,honcho_search,honcho_remember,honcho_conclude` |

Seshat (orchestrator, defined in `AGENTS.md`) gets all tools including `subagent`, `specsafe_begin/end/status`, and full `honcho_*` *except* `honcho_conclude` — the orchestrator doesn't write durable lessons; its Gholas do.

### 4.2 Memory protocol per agent (text appended to each body)

Same pattern for all five, adapted per role:

> **Memory protocol**
> - On entry: call `honcho_recall` with a query about the task's topic to surface prior context. If the recall is empty or stale, proceed but flag the gap in your final response.
> - On exit: call `honcho_remember` with a one-paragraph summary of your conclusions or artifacts produced.
> - [validator only] On PASS: call `honcho_conclude` with any durable engineering lesson this slice revealed.
> - [reviewer only] In post-merge retrospective: call `honcho_conclude` with lessons about what went well and what didn't, including any anti-patterns to avoid.

## 5. Acceptance criteria

1. `AGENTS.md` names "Seshat the Ghola" within the first 40 words and retains the existing orchestrator rules (spec → tests → implement → validate → complete) unchanged in substance.
2. All 5 subagent markdowns have a non-empty `tools:` frontmatter line matching the table in 4.1.
3. Each subagent body contains a "Memory protocol" section with the three bullets (or four, for validator/reviewer).
4. Loading Pi from project root lists exactly 5 project-scoped agents in the startup message (unchanged count from baseline).
5. A trivial dispatch to any agent (`subagent({ agent: "spec-writer", task: "describe this repo" })`) succeeds with a slice open and produces both an entry recall and an exit remember message in the Honcho session — verifiable via `honcho_search({query:"describe this repo"})`.
6. `validator` invoked with `honcho_conclude` succeeds; any other agent invoking `honcho_conclude` returns isError (inherited from Spec 001's allowlist — but the *persona* must also not attempt it, enforced by system prompt).
7. `README.md` has an amended "Cast" section listing: Seshat the Ghola (orchestrator), the five Gholas (spec-writer, test-writer, implementer, validator, reviewer), and placeholders for Steward and doc-scout marked "TBD slices 4 & 6."

## 6. Open questions / risks

- **Q1 — RESOLVED 2026-04-24:** reviewer does NOT get `bash`. If it needs to run tests, it dispatches to `validator` via Seshat.
- **Q2** — Risk: over-prescribed memory protocol bloats subagent prompts. **Mitigation:** keep the protocol block to ≤6 lines total; measure token cost in the first validator run.

## 7. Handoff notes

- Implementer: edits only five `.md` files + `AGENTS.md` + `README.md`. No code. Changes land in a single commit per file when the auto-commit flow from Spec 001 runs.
- Validator: verify each markdown still parses as valid frontmatter (run `bun run -e 'import {parseFrontmatter} from "@mariozechner/pi-coding-agent"; ...'`).
