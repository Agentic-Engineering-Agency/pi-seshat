# Honcho tool — pi-seshat → Oh My Pi port notes

Faithful port of `.pi/extensions/honcho/index.ts` onto the OMP
`CustomToolFactory` surface.

## Behavioral parity

All four tools (`honcho_recall`, `honcho_search`, `honcho_remember`,
`honcho_conclude`) preserve the original semantics. Critical invariants:

- Allowlist (`validator`/`reviewer`/`steward` only) on `honcho_conclude`.
- `product:` prefix required for steward conclusions.
- `HONCHO_API_KEY` redacted from error text via `sanitizeErrorForDisplay`.
- Workspace-scope search is rejected with `not yet wired`.

## Adaptations forced by the OMP API

- **No agent-identity field on the tool context.** OMP's `CustomToolContext`
  (see `@oh-my-pi/pi-coding-agent/src/extensibility/custom-tools/types.ts`)
  exposes `sessionManager`, `modelRegistry`, `model`, `settings`, but no
  per-call agent identity. Same as vanilla Pi. Identity is therefore read
  from `process.env` at call time, exactly as in the source. Optional
  hydration from `~/.omp/agent/honcho.json` is added — file shape is
  identical to `~/.pi/agent/honcho.json`, so the two MAY be symlinked.
- **TypeBox injected via `pi.typebox`** instead of imported from the
  `typebox` package. Schemas are constructed inside the factory; the
  test-callable inner factory (`buildHonchoTools`) does not depend on
  TypeBox so unit tests stay framework-free.
- **`StringEnum` from `pi.pi`** is used instead of `Type.Union(...Literal)`
  for cross-provider (Google) compatibility, per OMP custom-tools README.
- **Factory returns an array of tools** (OMP supports
  `CustomTool | CustomTool[] | Promise<...>`); vanilla Pi registered them
  one-by-one via `pi.registerTool`.
- **Execute signature.** OMP uses
  `(toolCallId, params, onUpdate, ctx, signal)`; the source tests call the
  inner tools with the legacy
  `(id, params, signal, onUpdate, ctx)` ordering. The inner factory
  preserves the legacy ordering for test fidelity; the OMP-facing wrapper
  (`adapt(...)` inside the factory) translates to OMP's order.
- **Cost counter writes to `<cwd>/.pi/.honcho-state.json`** until the
  SpecSafe-session extension is itself ported (`slice-009`). Best-effort
  and silent on missing file. Drop / re-point when SpecSafe lands in
  `.omp/`.

## Test status

`bun test ./.omp/test/honcho.test.ts --test-name-pattern='\[unit\]'`
→ 14 pass, 4 skip (live), 0 fail. The live tests run when
`HONCHO_TESTS_LIVE=1` and a real `HONCHO_API_KEY` are present.
