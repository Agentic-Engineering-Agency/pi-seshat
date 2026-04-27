# SPEC-20260427-016 — project bootstrap skill

## 1. Goal

Provide a single-shot CLI skill that initializes a foreign project (any directory outside pi-seshat itself) to participate in the pi-seshat Ghola/SpecSafe system. The skill creates directories, symlinks the `.omp/` tree from the pi-seshat repo, writes lightweight `AGENTS.md` and `CLAUDE.md` templates, appends `.gitignore` patterns, and writes an audit log. It is idempotent, dry-run-by-default, and refuses to run inside pi-seshat itself.

## 2. Scope and non-goals

**In scope:**

- One skill at `.omp/skills/bootstrap/` containing:
  - `bin/bootstrap.ts` — TypeScript CLI entry point
  - `SKILL.md` — usage contract for the model
  - `templates/AGENTS.md` — generic Seshat-orchestrator document (≤80 lines)
  - `templates/CLAUDE.md` — brief project-rules document (≤60 lines)
- Deterministic dry-run preview of every mutation before application.
- `--i-approve` gate for all mutations.
- `--force-symlink` escape hatch for `.omp/` conflicts.
- `--peer` and `--workspace` overrides for template substitution.
- Idempotency: re-running on an already-bootstrapped project is a no-op.
- Unit tests under `.omp/test/bootstrap.test.ts`.

**Explicitly not in scope:**

- NO auto-detection of Linear team/project (user-specific; requires another `--i-approve` gate).
- NO modification of the project's existing `.git/`, `package.json`, `tsconfig.json`, or any source file.
- NO dependency installation (no `bun install`).
- NO automatic SpecSafe slice creation (no `specsafe begin` invocation).
- NO `unbootstrap` command — the operation is intentionally one-way.
- NO MCP server wrapper.

## 3. Constraints

- **Language:** TypeScript, executable via `bun run .omp/skills/bootstrap/bin/bootstrap.ts`. Shebang: `#!/usr/bin/env -S bun run`.
- **Invocation context:** The skill is invoked from the *target* project's cwd, NOT from inside the pi-seshat repository. It must detect and refuse pi-seshat-self-invocation.
- **PI_SESHAT_ROOT resolution:** The pi-seshat repo root is derived from the running `bootstrap.ts` file path (`path.resolve(__dirname, "../../../..")` or equivalent). This path is used both for the `.omp/` symlink target and for the `templates/` directory.
- **Template placeholders:** `{{PROJECT_NAME}}`, `{{HONCHO_WORKSPACE}}`, `{{HONCHO_PEER}}`. Replaced by naive string substitution (no templating engine).
- **File modes:** `.pi/.bootstrap-log.jsonl` MUST be created with mode `0o600`.
- **Idempotency contract:**
  - Directories: `mkdirSync` with `recursive: true` (harmless repeat).
  - Symlink: skip if already correct; error if wrong kind unless `--force-symlink`.
  - `AGENTS.md` / `CLAUDE.md`: skip if file already exists (preserve user content).
  - `.gitignore`: append only patterns not already present.
  - Audit log: append a new line on every `--i-approve` invocation (log is append-only by design).
- **Exit codes:**
  - `0` — success or successful dry-run.
  - `1` — refuse-condition (pi-seshat self, existing-file conflict, write failure).
  - `2` — invalid flag or argument.

## 4. Decisions

1. **Refuse to run inside pi-seshat itself.** Detection: check whether `<cwd>/.omp/skills/bootstrap/` exists and is a regular directory (not a symlink). In the source repo this path is a real directory containing `bin/bootstrap.ts`. Rejection message must contain the substring `pi-seshat self`. Rationale: bootstrap is exclusively for foreign projects; running it on its own repo would create a circular `.omp` symlink and corrupt the source tree.

2. **Dry-run-by-default with `--i-approve` gate.** Rejected auto-apply on second run because it breaks the audit invariant (the operator must explicitly witness every mutation). The preview lists each of the six actions with its target path and a one-line description. Rationale: matches the `--i-approve` idiom used by `latest-docs register`, `push`, `bmad-doc apply`, and the i-approve hook.

3. **Symlink `<cwd>/.omp` → `<PI_SESHAT_ROOT>/.omp`.** Rejected copying the `.omp/` tree because it would duplicate ~20 files and immediately drift when pi-seshat updates. Rejected hard-linking because it fails across filesystem boundaries. A symlink means foreign projects automatically inherit skill, agent, and hook updates when pi-seshat is pulled. Rationale: the `.omp/` tree is read-only from the foreign project's perspective; symlink is the simplest zero-drift mechanism.

4. **Template skip-if-exists semantics.** `AGENTS.md` and `CLAUDE.md` are skipped if they already exist, even if they were written by a previous bootstrap. Rationale: once the user has these files, they will edit them with project-specific content; overwriting would destroy that work. The symlink to `.omp/agents/` means the orchestrator instructions remain available even if the local `AGENTS.md` diverges.

5. **`.gitignore` idempotent append.** The nine patterns are appended only if not already present anywhere in the file (checked line-by-line, exact match). Rationale: re-running bootstrap must not duplicate patterns. The patterns cover all pi-seshat audit-log and cache files so that `.pi/` contents stay out of version control.

6. **No templating engine — naive string replace.** Rejected `mustache`/`handlebars` because the template surface is three placeholders and adding a dependency violates the "no dependency installation" non-goal. Rejected ESM template literals because templates are read from disk as plain text. Rationale: three `String.prototype.replaceAll` calls are sufficient and zero-dependency.

7. **Audit log at `.pi/.bootstrap-log.jsonl`.** Each `--i-approve` run appends one JSON line with shape `{ ts, action: "bootstrap", cwd, piSeshatRoot, appliedActions: string[], approver }`. Mode `0o600`. Rationale: provides a forensic trail of when a project was bootstrapped and from which pi-seshat revision; mirrors `.pi/.docs-registry-log.jsonl` and other `.pi/*.jsonl` audit files.

8. **Test seam: exported `dispatch(argv, context)` function.** The CLI entry point delegates to an exported `dispatch` function that receives an injected `context` object containing `cwd`, `env`, `fs`, `stdout`, `stderr`, `exit`, and `realpath`. Unit tests stub this context so no real filesystem mutations occur outside `fs.mkdtempSync` fixture directories. Rationale: matches the env-doctor test pattern and permits 100% black-box testing without touching the operator's real projects.

## 5. Acceptance criteria

1. Dry-run on a clean fixture project prints a 6-action preview (directories, symlink, AGENTS.md, CLAUDE.md, `.gitignore`, audit-log), exits 0, and modifies zero files.
2. Apply (`--i-approve`) on the same fixture creates `.pi/`, `specs/`, `specs/briefs/`, `specs/archive/` — all real directories.
3. Apply creates `<cwd>/.omp` as a symlink whose `fs.realpathSync` equals `<PI_SESHAT_ROOT>/.omp/`.
4. Apply writes `<cwd>/AGENTS.md` containing the `PROJECT_NAME` of the fixture (substituted from `path.basename(cwd)`).
5. Apply writes `<cwd>/CLAUDE.md`.
6. Apply appends all nine `.gitignore` patterns; running it again does NOT duplicate them.
7. Audit log file exists at `<cwd>/.pi/.bootstrap-log.jsonl` with mode `0600` and contains one JSON line whose `action` is `"bootstrap"` and `approver` is `"luci"`.
8. Re-running `--i-approve` on an already-bootstrapped fixture is a no-op (idempotent): state on disk is unchanged except for a new audit-log line, and the dry-run preview on a third run is empty.
9. Refusing to run inside pi-seshat itself: when invoked with `cwd === PI_SESHAT_ROOT`, exits 1 with stderr containing `pi-seshat self`.
10. Refusing on `.omp/` existing-file conflict: when `<cwd>/.omp/` is a regular directory (not a symlink, not absent), exits 1; with `--force-symlink` the run succeeds and replaces the directory with the correct symlink.
11. `AGENTS.md` and `CLAUDE.md` have skip-if-exists semantics: re-running does not overwrite if the files already exist, even if the user has modified them.
12. Every acceptance criterion (1–11) has at least one dedicated unit test under `.omp/test/bootstrap.test.ts` using stubbed `context.fs`, `context.stdout`, and `context.stderr`.

**Code-bearing slice; test-writer step required.**

## 6. Open questions and risks

- **(a) pi-seshat absolute path baked into the symlink.** The symlink target is the absolute path of the pi-seshat repo at bootstrap time. If the pi-seshat repository is later moved (e.g. `mv ~/Code/Misc/pi ~/Code/Misc/pi-old`), every bootstrapped project's `.omp` symlink will dangle. The fix is to re-run bootstrap with `--force-symlink` from each affected project. Document this limitation in `SKILL.md`. There is no auto-heal mechanism because the foreign project cannot know where pi-seshat moved.

- **(b) AGENTS.md template drift over time.** As pi-seshat evolves (new personas, new skills, new workflow steps), the generic `templates/AGENTS.md` may become stale. A bootstrapped project that already has an `AGENTS.md` will never receive updates because of skip-if-exists semantics. Template versioning is out of scope for this slice; the mitigation is to flag template drift during coherence-skill runs or periodic manual audits.

- **(c) Bootstrap is one-way — there is no `unbootstrap`.** This is intentional: removing the symlink and deleting the generated files is trivial for a human (`rm -rf .omp AGENTS.md CLAUDE.md .pi/`), but automating it risks deleting user-edited content. The skill does not create an undo log. If an operator needs to decommission pi-seshat from a project, manual cleanup is the only path.
