# SPEC-20260427-013 — README and CLAUDE identity-model rewrite

## 1. Goal

Bring `README.md` and `CLAUDE.md` into factual agreement with the
slice-008.6 Honcho wiring documented in `AGENTS.md` and the user's
opening prompt. Remove stale references to the vanilla-Pi extension
paths, the `seshat` peer, and the per-spawn child-env-injection flow
that was deliberately not ported. This is a fidelity-restoration slice,
not a redesign.

## 2. Scope and non-goals

**In scope:**
- `README.md` — rewrite the "Honcho identity model" section (lines
  45–63), the "What's here" section (lines 16–30), and the "Cast"
  section (lines 79–89).
- `CLAUDE.md` — update the stale `.pi/extensions/honcho/index.ts` path
  (line 43) and remove the claim that `seshat` is a Honcho peer
  (line 44).
- `GETTING-STARTED.md` — grep for stale identity language; fix in
  scope if found, or explicitly defer.

**Non-goals:**
- NO new conventions, NO new sections, NO behavioral changes.
- Do NOT touch `AGENTS.md` — it is already the source of truth.
- Do NOT modify any spec file under `specs/` or `specs/archive/`.
- Do NOT introduce forwarding-address notes like "previously this said
  X" — clean cutover; write the current truth only.

This is a **markdown-only slice**; the test-writer step is skipped per
the documented SpecSafe deviation. §5 acceptance criteria are the
verification contract.

## 3. Constraints

- Every claim in the rewritten sections MUST be backed by either
  `AGENTS.md`, `MIGRATION.md`, or a code citation in `.omp/`.
- The rewrite MUST NOT introduce any forwarding-address note.
- `README.md` title (`# pi-seshat`) and `AGENTS.md` reference in the
  Cast section remain unchanged.
- The `seshat` name may appear in titles and in the Cast section as the
  orchestrator's moniker, but MUST NOT appear as a Honcho peer.

## 4. Decisions

1. **README.md "Honcho identity model" section** — Replace the stale
   paragraph with the slice-008.6 wiring verbatim:
   - Workspace = `oh-my-pi` (one workspace for all omp work, per
     `AGENTS.md` and the user's opening prompt).
   - Session = `luci-<basename-of-cwd>` (derived per-invocation by the
     `omp()` shell function, per `GETTING-STARTED.md` §1 and the user's
     prompt).
   - Peers = `luci` (human) plus one per Ghola (`validator`,
     `reviewer`, `steward`, `spec-writer`, `test-writer`,
     `implementer`, `doc-scout`). No `seshat` peer. Identity is
     declared via the `as_peer` parameter (slice-008.1 contract,
     `.omp/tools/honcho/index.ts:327-352`).

2. **README.md "What's here" section** — Update the three tiers to
   reflect the omp directory layout:
   - Agents → `.omp/agents/*.md`
   - Hooks / custom tools → `.omp/hooks/` (SpecSafe lifecycle,
     `--i-approve` gate, fallback audit), `.omp/tools/honcho/`
     (Honcho memory bridge), and `.omp/skills/` (six external-surface
     skills). Link to `.omp/hooks/PORT-NOTES.md` for the rationale.
   - Mention `.pi/extensions/` only as the vanilla-Pi rollback hatch
     (coexistence per `MIGRATION.md` A8).

3. **README.md "Cast" section** — Update every persona file path from
   `.pi/agents/<name>.md` to `.omp/agents/<name>.md`. Verify each
   target file exists:
   `spec-writer`, `test-writer`, `implementer`, `validator`,
   `reviewer`, `steward`, `doc-scout`.

4. **CLAUDE.md line 43** — Update the code citation from
   `.pi/extensions/honcho/index.ts` to `.omp/tools/honcho/index.ts`
   (the active `product:` prefix gate is at lines 343–347 of the
   ported tool).

5. **CLAUDE.md line 44** — Rewrite the peer list to remove `seshat`.
   The correct statement is that the five engineering Gholas
   (`spec-writer`, `test-writer`, `implementer`, `validator`,
   `reviewer`) and `doc-scout` can call `honcho_remember` but not
   `honcho_conclude`. `steward` is the product-owner peer that writes
   `product:`-prefixed conclusions.

6. **README.md per-spawn child-env-injection paragraph** — Drop lines
   56–63 (the paragraph beginning "Parent Pi opens a session..."
   through "...through env injection.") and replace with a single
   sentence pointing to `.omp/hooks/PORT-NOTES.md` for the rationale
   that per-spawn env injection was deliberately not ported.

## 5. Acceptance criteria

1. `grep -n 'one per project' README.md` returns empty.
2. `grep -n 'seshat' README.md` returns either empty or only the title
   line (`# pi-seshat`); the Cast section may retain "Seshat the
   Ghola" as the orchestrator's moniker but MUST NOT claim it is a
   Honcho peer.
3. `grep -n '\.pi/extensions/honcho' CLAUDE.md` returns empty.
4. Every persona link in the README Cast section resolves to a real
   file under `.omp/agents/` (verified by `ls .omp/agents/{spec-writer,
   test-writer,implementer,validator,reviewer,steward,doc-scout}.md`).
5. The rewritten "Honcho identity model" section in `README.md`
   contains the three identifiers verbatim: `workspace = oh-my-pi`,
   `session = luci-<basename-of-cwd>`, and the peer list naming
   `luci` plus one per Ghola.
6. `git diff AGENTS.md` is empty after this slice (AGENTS.md
   unchanged).
7. `grep -n 'seshat' CLAUDE.md` returns either empty or only the title
   line (`# pi-seshat`); no line claims `seshat` is a Honcho peer.
8. `GETTING-STARTED.md` has been grepped for stale identity language.
   If any stale claim is found, it is either fixed in this slice or
   explicitly deferred with a citation in §6.

## 6. Open questions and risks

- **GETTING-STARTED.md audit.** As of commits `db74650`, `4485c60`,
  `23c3c77` (2026-04-26), `GETTING-STARTED.md` already contains the
  correct slice-008.6 identity model (`workspace = oh-my-pi`,
  `session = luci-<basename-of-cwd>`, `as_peer` contract). The
  implementer MUST still grep it for stale language; if any is found,
  either fold the fix into this slice or open a follow-up spec
  `SPEC-20260427-014-getting-started-audit`.
- **External consumer breakage.** `README.md` may be referenced by
  linked Linear tickets or Notion notes. This risk is noted but does
  not block the rewrite — the old paths and identity model are
  factually wrong and leaving them in place is worse than breaking a
  stale external link.
