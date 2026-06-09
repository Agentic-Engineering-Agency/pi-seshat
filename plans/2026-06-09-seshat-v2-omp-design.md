# Seshat v2 — Oh-My-Pi-native Agentic Development System

- **Date:** 2026-06-09
- **Author:** Luci + Seshat (design pass)
- **Status:** APPROVED — implementing
- **Supersedes-in-spirit:** SPEC-20260426-008 (oh-my-pi migration), SPEC-008.1 (persona-prompt identity)
- **Target runtime:** `@oh-my-pi/pi-coding-agent` v15.10.9 (`omp`)
- **Deploy scope:** project-local (`<repo>/.omp/`) **and** global (`~/.omp/agent/`)
- **Memory:** Honcho (kept; per Luci's decision)

---

## 0. Why v2 (problem statement)

The migrated `.omp/` tree (SPEC-008) is mature but carries three load-bearing
defects, all confirmed against the **installed** omp v15 source:

1. **The hooks never auto-load.** omp v15 discovers *extension modules* from
   `<config>/extensions/*.ts`, and the legacy `hookCapability` provider only
   models Claude-style `hooks/<hookType>/*` subdirs — **not** flat
   `.omp/hooks/*.ts`. So `specsafe-session`, `specsafe-subagents`, `i-approve`,
   and `fallback-audit` are dormant. `.omp/README.md:9` claims otherwise; it is
   wrong for v15. (Source: `src/discovery/builtin.ts:430-595`,
   `src/discovery/helpers.ts:520`, `src/extensibility/hooks/loader.ts`.)

2. **Identity is model-trusted (008.1 weak spot).** `honcho_conclude`'s
   `as_peer` allowlist can be lied about by the model. omp v15 *still* exposes
   **no per-agent identity** to tools or hooks (`CustomToolContext` has no agent
   field; `AgentStartEvent` carries no name). So full process-trust remains
   infeasible — but we can move from "prose-only trust" to **code-enforced
   defense-in-depth** via TTSR rules + a `tool_call` interceptor + content
   invariants + an append-only audit.

3. **A verification carve-out leaves docs/config unverified.** The current rule
   "skip test-writer for markdown/config-only slices" means a whole class of
   change ships with *no machine check at all*.

## 1. Decisions (locked)

| # | Decision |
|---|----------|
| D1 | Upgrade the existing `pi-seshat/.omp` in place; deploy both **local** and **global**. |
| D2 | Keep **Honcho** as durable memory. Native omp memory is out of scope for v2 (optional cache later). |
| D3 | **Universal verification contract:** *every* mission carries machine-checked `acceptance_criteria` (`check_command` + `severity`). Code → strict RED-GREEN-REFACTOR. Docs/config → a non-test `check_command` (lint/build/link-check) instead of the old "skip". Nothing ships unverified. |
| D4 | **Scale levels 0–4** (BMAD-style) are the cost dial that decides roster depth + review rigor per mission. |
| D5 | **Roster:** keep the 8 existing Gholas; add `architect`, `security-reviewer`, `docs-writer`, `release-steward`; split review into **stage-1 spec-compliance** (`reviewer`) and **stage-2 code-quality** (`reviewer-code`). |
| D6 | **Identity:** code-enforce peer invariants with TTSR + a `tool_call` interceptor + audit. Honest about the residual (model can still spoof in pathological cases); documented, not hidden. |
| D7 | Emit **Ultimate-Harness-compatible** artifacts (`uh.mission.v0` packet + verification + promotion + audit) so omp can become a UH runtime adapter later. |

## 2. omp seams this design stands on (verified)

| Capability | Project path | Global path | Verified at |
|---|---|---|---|
| Subagents | `.omp/agents/*.md` | `~/.omp/agent/agents/*.md` | `src/task/discovery.ts:1-129` |
| Extension modules (hooks+tools+commands in one) | `.omp/extensions/*.ts` | `~/.omp/agent/extensions/*.ts` | `src/discovery/builtin.ts:430-528`, `helpers.ts:520` |
| Custom tools | `.omp/tools/<name>/index.ts` | `~/.omp/agent/tools/…` | `builtin.ts:697-711` |
| Skills | `.omp/skills/<name>/SKILL.md` | `~/.omp/agent/skills/…` (also `~/.claude/skills`) | discovery |
| Rules / **TTSR** | `.omp/rules/*.{md,mdc}` | `~/.omp/agent/rules/…` | `builtin.ts:333-388`, `capability/rule.ts:41` |
| Sticky always-apply rule | `.omp/RULES.md` | `~/.omp/agent/RULES.md` | `builtin.ts:349-363` |
| Slash commands | `.omp/commands/*.md` | `~/.omp/agent/commands/…` | `builtin.ts:301-323` |
| Explicit extension registration | `.omp/settings.json` `extensions:[]` | `~/.omp/agent/settings.json` | `builtin.ts:461-482` |

**TTSR rule frontmatter** (`capability/rule.ts:41-63`): `condition: string[]`
(regex, abort+inject mid-stream), `astCondition: string[]` (ast-grep, edit/write
streams), `scope: string[]` (e.g. `text`, `thinking`, `tool:edit(*.ts)`),
`interruptMode: never|prose-only|tool-only|always`, plus `globs`, `alwaysApply`,
`description`.

## 3. Architecture

```
                         ┌──────────────────────────────┐
   Luci (human) ───────► │  Seshat (orchestrator, AGENTS.md)  │
                         │  scale-classify → plan → dispatch  │
                         └───────────────┬────────────────────┘
   durable record                       │ task()
   Honcho ◄── recall/remember/conclude  ▼
                ┌───────────────────────────────────────────────┐
   STATE.md ◄── │ Gholas (fresh-context subagents, .omp/agents) │
   CONTEXT.md   │ steward · architect · spec-writer · doc-scout │
                │ test-writer · implementer · validator ·        │
                │ reviewer(spec) · reviewer-code · security ·    │
                │ docs-writer · release-steward                  │
                └───────────────────────────┬───────────────────┘
   enforcement plane (auto-loaded extensions + TTSR rules):
     • identity-gate.ts  (as_peer interceptor + audit)
     • tdd-iron-law.mdc  (RED-before-GREEN, in-stream)
     • identity-peer-gate.mdc (conclude/remember as_peer, in-stream)
     • i-approve.ts (mutation gate) · specsafe-* (slice + auto-commit) · fallback-audit
   verification plane (skills):
     • verify  (acceptance_criteria runner: check_command + severity:block)
     • state   (STATE.md / CONTEXT.md durable context, O_EXCL lock)
     • mission (uh.mission.v0 read/emit — UH adapter contract)
```

### 3.1 The mission lifecycle (SpecSafe v2)

`classify → spec → (docs) → tests(RED) → implement(GREEN) → refactor → verify →
review(spec) → review(code) → [security] → [docs] → promote → archive`.

- **classify** picks a **scale level** that prunes the chain:
  - **L0 trivial** (typo/comment): spec-in-commit, `verify` only.
  - **L1 small**: spec-writer + implementer + verify + reviewer.
  - **L2 standard**: full TDD chain + reviewer + reviewer-code.
  - **L3 complex**: + architect (up front) + security-reviewer.
  - **L4 enterprise**: + release-steward + promotion record + UH mission packet.
- **Universal verification (D3):** every level runs `verify`. Code levels gate
  on RED→GREEN; doc/config levels gate on a non-test `check_command`.

### 3.2 Identity enforcement (retires 008.1 weak spot) — three honest layers

1. **TTSR `identity-peer-gate.mdc`** — regex `condition` fires mid-stream when a
   `honcho_conclude`/`honcho_remember` tool call is being written without a
   valid `as_peer`, aborting + injecting a correction *before* the call lands.
2. **`identity-gate.ts` `tool_call` interceptor** — re-validates `as_peer`
   against `CONCLUSION_WRITERS`, cross-checks against `SESHAT_EXPECTED_PEER`
   (exported per-dispatch when available), enforces the `steward → product:`
   content invariant, and appends every decision to an append-only audit log.
   Blocks on violation (`{block:true,reason}`).
3. **Content invariants** — `product:` prefix for steward; `CONCLUSION_WRITERS`
   allowlist unchanged in the Honcho tool.

**Residual (documented, not hidden):** omp v15 still gives tools no trusted
agent name, so a single-agent session that *names itself* a conclusion-writer
can still pass layer 2 unless `SESHAT_EXPECTED_PEER` is set by the dispatcher.
The TTSR + audit layers make spoofing loud and reviewable. Follow-up trigger:
adopt `ctx.activeAgent?.name` the moment upstream ships it.

## 4. Deliverables (files)

```
plans/2026-06-09-seshat-v2-omp-design.md          (this doc)
.omp/settings.json                                 register extensions (project)
.omp/extensions/                                   ← auto-loaded modules
  specsafe-session.ts · specsafe-subagents.ts      (re-export shims of ../hooks/*)
  i-approve.ts · fallback-audit.ts                 (re-export shims)
  identity-gate.ts                                  (NEW v2.1)
.omp/lib/peer-policy.ts                             (NEW pure logic, testable)
.omp/rules/
  identity-peer-gate.mdc · tdd-iron-law.mdc         (TTSR)
  typescript.mdc                                    (path-scoped)
.omp/RULES.md                                       sticky orchestrator invariants
.omp/agents/
  architect.md · security-reviewer.md · docs-writer.md · release-steward.md
  reviewer-code.md                                  (stage-2)
  (spec-writer/test-writer/implementer/validator/reviewer/steward/doc-scout upgraded)
.omp/skills/
  verify/    (acceptance_criteria runner + scale levels)
  state/     (STATE.md / CONTEXT.md durable context)
  mission/   (uh.mission.v0 packet read/emit)
  deploy/    (global+local symlink installer + verifier)
.omp/test/   unit tests for peer-policy, verify, state, mission, deploy
AGENTS.md    orchestrator upgraded (scale levels + new roster + v2 lifecycle)
```

## 5. Cross-harness mechanics adopted

- **Superpowers:** TDD Iron Law (RED before GREEN, enforced in-stream), two-stage
  "distrust-the-implementer" review, worktree-per-task.
- **GSD:** fresh-context subagents; durable `STATE.md`/`CONTEXT.md`; O_EXCL lock.
- **BMAD:** scale levels 0–4; dedicated Test-Architect-style `verify`; planning on
  subscription models.
- **OpenSpec/Spec-Kit:** delta-spec + archive-merge; machine `acceptance_criteria`
  as the analyze/checklist gate.
- **Ultimate Harness:** `uh.mission.v0` packet, verification + promotion + audit
  artifacts so omp slots in as a runtime adapter.
- **Anthropic guidance:** orchestrator-workers, distilled (<2k) subagent returns,
  tool minimalism, context-rot defense, 3-level skill disclosure.

## 6. Verification of this work

- `bun run typecheck` clean (new pure-logic + skill bins typecheck).
- `bun test .omp/test/` green (peer-policy, verify, state, mission, deploy units).
- `omp` boots with the project `.omp/` and lists the new agents/rules/extensions.

## 7. Residual risks / follow-ups

- Per-agent identity API (upstream) → upgrade layer 2 to process-trust.
- `task` subprocess env injection seam → would let us export `SESHAT_EXPECTED_PEER`
  per dispatch automatically; today the orchestrator sets it.
- Native memory migration (optional) deferred per D2.
