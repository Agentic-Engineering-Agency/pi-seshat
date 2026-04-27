# SPEC-20260427-010 — persona bash-or-rewrite repair

## 1. Goal

Close the contract gap in four Ghola personas (`spec-writer`, `reviewer`, `steward`, `doc-scout`) that instruct the model to invoke `/skill:latest-docs show <lib>` but do not grant `bash` in their `tools:` frontmatter. The actual skill-bin entry point is `bun run .omp/skills/<name>/bin/<name>.{ts,sh}`, which requires `bash`. Without it, the directive is unfulfillable.

## 2. Scope and non-goals

In scope:
- Add `bash` to the `tools:` frontmatter of the four personas listed above.
- Add a constrained-use instruction in each persona body that limits `bash` to skill-bin invocations and read-only inspection.
- Remove or amend the literal "no `bash`" text inside the two persona bodies that contain it (`steward.md`, `doc-scout.md`).

Non-goals:
- Do NOT add `edit` or `write` to any of the four personas.
- Do NOT touch the three already-bash-equipped personas (`test-writer`, `implementer`, `validator`).
- Do NOT redesign the skill-bin invocation mechanism or add a first-class `skill` tool.
- Do NOT rewrite the four personas to dispatch through a fifth agent.

This is a **markdown-only slice; test-writer step skipped per documented SpecSafe deviation**.

## 3. Constraints

- Persona frontmatter shape is `tools: read,find,grep,ls,...,bash` (comma-separated, no spaces around commas). Match the existing files exactly.
- The constrained-use clause must appear verbatim in all four persona bodies so an implementer can copy-paste it.
- Any external documentation (README.md cast section, AGENTS.md agent list) that claims the four personas are "no bash" must be either updated in this slice or explicitly referenced as belonging to slice 5 (README rewrite).

## 4. Decisions

1. **Chosen resolution: add `bash` + constrained-use instruction.**
   Rejected alternative: rewriting the four personas to dispatch doc-fetching through `test-writer`, `implementer`, or a new fifth agent that already has `bash`. That alternative multiplies the dispatch surface, increases latency, and weakens auditability — a persona that cannot execute its own stated directive is a bug; routing around it with another agent is a larger, less safe workaround.

2. **Exact constrained-use clause wording (apply verbatim in all four files):**
   > `bash` is permitted ONLY to invoke `bun run .omp/skills/<name>/bin/<name>.{ts,sh}` and standard read-only inspection (`ls`, `cat`, `pwd`). Any other use is a persona breach.

3. **Placement in each persona body:** insert the clause into the `## Hard constraints` section (or add a `## Hard constraints` section just before `## Memory protocol` for personas that lack one). This keeps the constraint adjacent to the existing "no `edit` / no `write`" rules and before the memory-protocol block where `honcho_remember`/`honcho_conclude` instructions live.
   - `spec-writer.md` — add `## Hard constraints` between `## Behavior rules` and `## Latest-docs directive`.
   - `reviewer.md` — add `## Hard constraints` between `## Behavior rules` and `## Latest-docs directive`.
   - `steward.md` — amend the existing `## Hard constraints` section (remove the old "no `bash`" sentence, insert the clause).
   - `doc-scout.md` — amend the existing `## Hard constraints` section (remove the old "no `bash`" sentence, insert the clause).

4. **External doc claims about the four personas being bash-less:**
   - README.md line 88 describes doc-scout as "No write, no edit, no bash."
   - AGENTS.md line 54 describes steward as "No edit, no bash."
   - AGENTS.md line 58 describes doc-scout as "No write, no edit, no bash."
   These three lines are out of scope for this slice; they belong to slice 5 (README.md + CLAUDE.md identity-model rewrite, SPEC-20260427-005). This spec explicitly flags them as a follow-up acceptance criterion in §5.v.

## 5. Acceptance criteria

1. `grep -E '^tools:' .omp/agents/spec-writer.md .omp/agents/reviewer.md .omp/agents/steward.md .omp/agents/doc-scout.md` shows `bash` present in all four `tools:` lines.
2. `grep -F 'bash is permitted ONLY to invoke' .omp/agents/spec-writer.md .omp/agents/reviewer.md .omp/agents/steward.md .omp/agents/doc-scout.md` returns four matches.
3. `git diff .omp/agents/test-writer.md .omp/agents/implementer.md .omp/agents/validator.md` is empty (the three already-bash-equipped personas are unchanged).
4. `grep -rl 'no \`bash\`' .omp/agents/*.md` returns empty (the literal "no `bash`" sentences in `steward.md` and `doc-scout.md` have been removed or rewritten).
5. Any external documentation claim that the four personas are bash-less (README.md line 88, AGENTS.md lines 54 and 58) is either updated in this slice or explicitly cross-referenced as a follow-up item in SPEC-20260427-005.

## 6. Open questions and risks

- **Discipline-only enforcement.** The constrained-use clause is a persona-prompt rule, not enforced by code. A misbehaving model could still use `bash` for arbitrary mutations. The `--i-approve` gate on `write`/`edit` remains the hard boundary for destructive operations; `bash` here is read-only + skill-bin invocation only by convention.
- **AGENTS.md drift on re-cut.** If AGENTS.md is auto-generated from persona frontmatter in a future slice, the "No edit, no bash" summaries will auto-correct. If it remains hand-written, the follow-up in slice 5 must remember to update lines 54 and 58.
- **`.pi/agents/` shadow copies.** README.md line 88 references `.pi/agents/doc-scout.md` (the vanilla path), not `.omp/agents/doc-scout.md`. Both paths exist during the migration. The slice-5 README rewrite should update the path reference as well as the claim.
