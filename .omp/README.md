# `.omp/` — pi-seshat-on-Oh-My-Pi project-scoped extensions (Seshat v2)

Source-of-truth for the v1 migration: `specs/SPEC-20260426-008-oh-my-pi-migration.md`.
v2 upgrade design: `plans/2026-06-09-seshat-v2-omp-design.md`.

## Layout

| Subdir | Purpose | Discovery (omp v15, verified) |
|---|---|---|
| `extensions/` | **Auto-loaded** hook/tool factory modules (`*.ts`, default-export `(pi)=>void`) | `<repo>/.omp/extensions/*.ts` and `~/.omp/agent/extensions/*.ts` |
| `hooks/` | Source-of-truth hook implementations (imported by the `extensions/` shims) | NOT auto-discovered — see note below |
| `tools/` | Custom tools (`<name>/index.ts` per tool) | `.omp/tools/` and `~/.omp/agent/tools/` |
| `agents/` | Ghola persona definitions | `.omp/agents/*.md` and `~/.omp/agent/agents/*.md` |
| `skills/` | External-surface skills (`<name>/SKILL.md` + `bin/`) | `.omp/skills/` (also reads `~/.claude/skills/`) |
| `rules/` | Rules + **TTSR** stream rules (`*.mdc` frontmatter: `condition`/`astCondition`/`scope`/`interruptMode`) | `.omp/rules/` and `~/.omp/agent/rules/` |
| `lib/` | Pure, runtime-free logic (no `@oh-my-pi/*` import) so it is unit-testable | imported by extensions + tests |
| `test/` | Unit + migration tests | `bun test ./.omp/test/**/*.test.ts` |
| `RULES.md` | Sticky always-apply invariants (re-injected every turn, survive compaction) | `.omp/RULES.md` and `~/.omp/agent/RULES.md` |

> **Why `extensions/` exists (v2.0 fix):** omp v15 discovers extension modules
> from `<config>/extensions/*.ts`. The legacy `hookCapability` provider only
> models Claude-style `hooks/<hookType>/*` subdirs, so the flat `.omp/hooks/*.ts`
> factories from SPEC-008 were **never auto-loaded**. The `extensions/` shims
> re-export those factories from their source-of-truth `hooks/` location so they
> actually run. New enforcement code (`identity-gate.ts`) lives directly in
> `extensions/`.

## Deployment

Project-local is automatic (omp reads `<repo>/.omp/`). For **global** install
(every project), use the deploy skill — it symlinks each capability dir into
`~/.omp/agent/` and is dry-run by default:

```bash
bun run .omp/skills/deploy/bin/deploy.ts             # show the plan
bun run .omp/skills/deploy/bin/deploy.ts --i-approve # apply
```

Symlinks (not copies) eliminate the "did the runtime drift from the repo"
failure mode. Project `.omp/` still overrides the global links (project beats
user in omp discovery precedence).

## Coexistence

Vanilla Pi's `.pi/` directory is untouched; both runtimes coexist. Rollback
from `omp` to `pi` is a config edit in `AGENTS.md`.
