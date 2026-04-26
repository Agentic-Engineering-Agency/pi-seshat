---
id: SPEC-20260426-007
slug: cross-provider-fallback
slice: 7 of N
title: Cross-provider fallback chain at the model-call layer
status: archived
author: opus-spec-writer (drafted on behalf of luci)
created: 2026-04-26
depends_on: [SPEC-20260424-001, SPEC-20260424-002]
linear: n/a
---

# SPEC-007 — Cross-provider fallback chain

## 1. Goal

- When a primary model call fails with a fallback-worthy error class, transparently re-issue the call against the next model in a configured chain — same context, same tools, same options.
- Default chain order: Anthropic Opus → OpenAI GPT-5 → Google Gemini. **Every link is subscription-backed** (Anthropic Max via Meridian + pi-scrub; OpenAI Plus/Pro via Pi's `/login` Codex OAuth; Google via Pi's `/login` Antigravity OAuth). Direct API keys are explicitly out of scope for the default chain per Luci's Subscription Optimizer constraint. Kimi is excluded from the fallback chain because Moonshot offers no comparable subscription product; Kimi-as-primary for individual Gholas is governed by a separate slice (per-Ghola routing) and unaffected by this one.
- Constrain v1 to **pre-stream** failures (provider rejected before the first content event). Mid-stream failures propagate unchanged.
- Surface every fallback decision in a forensic JSONL audit log so reliability analysis is tractable. Cost circuit-breaker is not needed in v1: every link is flat-rate-billed via subscription, so worst-case spend is bounded by subscription quota (already a sunk cost) rather than per-call API charges.
- Keep the implementation behind Pi's public extension API. No fork, no patch of Pi internals, no new runtime deps beyond what each underlying provider already needs.

## 2. Scope

In scope:

- New extension `.pi/extensions/fallback-chain/` with:
  - `index.ts` — registers a synthetic provider `fallback` whose `streamSimple` walks the chain.
  - `chain.ts` — pure logic: parse config, classify errors, select next link.
  - `config.ts` — read/merge config from `~/.pi/agent/models.json` + per-Ghola override env.
  - `log.ts` — append-only JSONL writer (same idiom as `.push-log.jsonl`).
  - `README.md` — model-facing usage doc.
- New synthetic models registered under provider `fallback`, one per chain shape (default: `fallback/default-chain`). Pi `/model` shows them like any other model.
- Audit log file `.pi/.fallback-log.jsonl` (mode 0600, gitignored).
- Default chain definition in `~/.pi/agent/models.json` under key `extensions.fallback-chain`.
- `bun test` suite under `.pi/extensions/fallback-chain/test/` exercising chain.ts and config.ts with a mock `streamSimple` factory injected via constructor.

Not in scope:

- Mid-stream resume / replay (deferred to v2; see §5).
- Auto-tuning chain order based on observed reliability (v2).
- Retries within the same provider — Pi's own provider-retry settings cover that and we do not re-implement.
- Cost-aware routing (route the cheap call to GPT-5 when Opus is healthy). This is fallback, not balancing.
- New skill commands. Operator inspection of the log goes through plain `cat`/`jq` for v1.
- Replacing the Anthropic, OpenAI, or Google built-in providers. We register a *new* provider, never override existing ones.

## 3. Implementation constraints

### 3.1 Where to intercept — decision

**Custom synthetic provider via `pi.registerProvider("fallback", { streamSimple, ... })`.** The `streamSimple` we register *delegates* to `streamSimple()` from `@mariozechner/pi-ai` (the top-level resolver) with each link's `Model` object in turn.

Evidence the delegation works:

- `node_modules/@mariozechner/pi-ai/dist/stream.d.ts:6` — `streamSimple<TApi>(model, context, options)` is publicly exported and resolves the per-API handler via `getApiProvider(model.api)` (`stream.js:19-21`).
- `node_modules/@mariozechner/pi-coding-agent/dist/core/sdk.js:194` — Pi itself calls this same function. So calling it from inside our `streamSimple` handler is exactly what Pi does internally; there is no privileged execution path we'd be bypassing.
- `ctx.modelRegistry.find(provider, modelId)` (`extensions.md:846`, example at `extensions.md:1480`) returns the resolved `Model<Api>` for any registered link, including built-ins and other extension-registered providers.

The other two options were rejected:

- **`pi.on("before_provider_request")` / `after_provider_response` rewrite** — these hooks mutate the payload and inspect status, but neither lets a handler abort the in-flight call and substitute a new provider's stream. `before_provider_request` runs *after* the payload is built for the originally selected model (`extensions.md:582`); switching providers there means re-serializing for a different API, which we would have to re-implement. `after_provider_response` fires after the HTTP response object exists; the stream body has already started consuming. Neither hook composes into "retry the whole call against a different provider."
- **Subprocess `pi --print --provider X --model Y`** — kills streaming, kills tool-use threading, doubles cold-start latency, and re-implements session/context plumbing. Rejected.

Trade-off accepted: the user explicitly selects the synthetic `fallback/default-chain` model via `/model`. Gholas that want fallback set this in their agent body's `model:` field; Gholas that want hard-pinned routing pick a concrete provider/model. This is a feature: the chain is opt-in per-call.

### 3.2 Error classification — decision

Three buckets. Classification lives in `chain.ts::classifyError(err)` and returns one of `"fallback" | "fatal" | "abort"`.

| Condition | Bucket | Rationale |
|---|---|---|
| HTTP 429 (rate limit / quota) | `fallback` | Different provider, different quota. |
| HTTP 5xx | `fallback` | Provider-side fault; siblings may be healthy. |
| HTTP 408 / network timeout / `ECONNRESET` / `ENOTFOUND` after Pi's own retry budget exhausts | `fallback` | Transport failure, not request failure. |
| HTTP 401 / 403 | `fatal` | Operator misconfiguration. Falling through hides the bug and silently spends another provider's budget. |
| HTTP 400 with body matching `/extra usage|credit|balance|quota/i` | `fallback` | Anthropic Max overdraft and similar surface as 400. |
| HTTP 400 otherwise (schema / tool / message validation) | `fatal` | Same payload will fail on the next provider for the same reason; cascade hides the real bug. |
| `signal.aborted === true` (user pressed Esc) | `abort` | Propagate immediately; never fall through. |
| Any error after a content event has been emitted on the primary's stream | `fatal` (mid-stream rule, see §3.3) | v1 cannot resume cleanly. |
| Anything else | `fatal` | Default-deny. New error classes get triaged into the table explicitly. |

Implementation: the classifier reads `err.status` (the standard pi-ai error shape — see `pi-ai/dist/utils/http-error.js`) and falls back to message-pattern matching only for the 400-body case.

### 3.3 Stream behavior — decision

**v1: pre-stream-only fallback.**

The wrapper's `streamSimple` does this:

1. For each link in the configured chain, call `streamSimple(link.model, context, options)`.
2. Buffer events from the underlying stream until either:
   - A content event arrives (`text_start`, `thinking_start`, or `toolcall_start`) — we are committed to this link. Forward all subsequent events to our caller verbatim, including any later `error` event (which propagates as fatal).
   - An `error` event arrives before any content event — classify it. If `"fallback"`, drop the buffered `start` event silently, append a log entry, advance to the next link, and re-issue. If `"fatal"`, forward the error to our caller. If `"abort"`, forward.
3. If the chain is exhausted, emit a synthesized `error` event whose `errorMessage` lists every link tried and the per-link error class. Format:
   `fallback chain exhausted: anthropic/claude-opus-4-7 (429) → openai/gpt-5 (429) → google/gemini-2.5-pro (timeout)`.

The `start` event Pi expects (`custom-provider.md:399`) is emitted by the wrapper *itself* at the top, with a `partial` shaped from the first link's `model` metadata. We patch the `model` / `provider` fields of the final `done` event's `message` to point at the link that actually served the response, so cost attribution and session JSONL stay accurate.

Mid-stream failure (`error` after a content event) is a documented v2 problem: the user has already seen partial output, the assistant message in `ctx.sessionManager` is half-written, and silently retrying produces a duplicated or contradictory continuation. v1 propagates the error as-is and lets the user retry manually.

### 3.4 Configuration — decision

**Layered: global default in `~/.pi/agent/models.json`, per-Ghola override via env var, no project-local file.**

Global shape:

```json
{
  "extensions": {
    "fallback-chain": {
      "chains": {
        "default": [
          { "provider": "anthropic", "model": "claude-opus-4-7" },
          { "provider": "openai",    "model": "gpt-5.5" },
          { "provider": "google",    "model": "gemini-2.5-pro" }
        ],
        "cheap": [
          { "provider": "openai",   "model": "gpt-5-mini" },
          { "provider": "google",   "model": "gemini-2.5-flash" }
        ]
      },
      "logFile": ".pi/.fallback-log.jsonl"
    }
  }
}
```

The extension factory reads this on load, registers one synthetic model per chain key (`fallback/default`, `fallback/cheap`, etc.), and uses `ctx.modelRegistry.find(link.provider, link.model)` at call time to resolve each link.

Per-Ghola override: env var `PI_FALLBACK_CHAIN` (comma-separated `provider/model` pairs) seen at `streamSimple` invocation time replaces the configured chain for that one call. Read at call time, never at module load — same convention as the Honcho extension's identity env vars (SPEC-001 §5.2). This lets `specsafe-subagents` set a shorter chain per Ghola without rewriting config.

The Honcho/secrets convention (env-only, never written to log or state) applies. The chain config itself is non-sensitive and lives plainly in `models.json`.

Project-local files were rejected: pi-seshat's pattern (see `.pi/extensions/honcho/`, `.pi/.honcho-state.json`) is global-config + per-call env. A `.pi/fallback-chain.json` would create a third config surface for no benefit.

### 3.5 Telemetry — decision

**Both: JSONL log file + a one-line note in the message metadata.**

JSONL append, one entry per fallback decision (success *or* exhaustion). Path from config (`.pi/.fallback-log.jsonl` default), mode 0600, gitignored, append-only.

```jsonl
{"ts":"2026-04-26T18:33:21Z","chain":"default","links":[{"provider":"anthropic","model":"claude-opus-4-7","outcome":"fallback","errorClass":"http-429","errorMessage":"..."},{"provider":"openai","model":"gpt-5.5","outcome":"served","latencyMs":4231}],"sessionId":"<env HONCHO_SESSION_ID|null>","peerId":"<env HONCHO_PEER_ID|null>","sliceId":"<env SPECSAFE_SLICE_ID|null>"}
```

`outcome` ∈ `{"served","fallback","fatal","abort","exhausted"}`. The terminal entry's outcome is `served` (success), `fatal` (propagated non-fallback error), `abort` (user cancel), or `exhausted` (chain ran out).

Message metadata: the wrapper sets `output.message.provider` and `output.message.model` to the link that actually served the response. Pi's session JSONL records this faithfully, so `/skill:memory cost` and any future cost-attribution skill see real provider for the turn (not `fallback`).

Log writes go through the same append-with-fsync helper used by `.push-log.jsonl` (SPEC-003 §3.1). Failure to write the log MUST NOT fail the model call — log to stderr and continue.

### 3.6 Testability — decision

`chain.ts` exposes a pure `runChain({ chain, resolveModel, callStreamSimple, classify, log, signal }, context, options)` function. The extension's `index.ts` is a thin wrapper that injects the real `streamSimple` from `@mariozechner/pi-ai`, the real `ctx.modelRegistry.find`, and the real log writer.

Tests construct `runChain` with:

- `callStreamSimple` — a mock that returns a hand-built `AssistantMessageEventStream` (see `custom-provider.md:368` for the construction pattern). Stream contents are scripted per test: error-before-start, error-after-content, success.
- `resolveModel` — a stub returning fake `Model<Api>` objects.
- `classify` — the production classifier in most tests; an injected stub for "what if classifier returns X" coverage.
- `log` — an in-memory array; the test asserts on JSON shape directly.

Same factory-injection pattern as `.pi/extensions/linear/` and `.pi/extensions/latest-docs/` (referenced in the project CLAUDE.md). No live LLM calls in unit tests. A separate `test/integration.live.test.ts` (gated behind `PI_LIVE_TESTS=1`) does one happy-path call against Anthropic to prove the wiring; this is opt-in and not part of CI.

### 3.7 Cost / billing routing

The chain config stores `provider`/`model` only. Whether `anthropic` resolves to Meridian + pi-scrub or to a direct API key is a property of the existing provider registration; the fallback extension does not care and does not duplicate that wiring. Per Luci's "subscription-routed where possible" rule (project CLAUDE.md), the default chain's first link MUST be the subscription-backed Anthropic provider. See §5 Q1 for the still-open billing question on subsequent links.

## 4. Acceptance criteria

Each is verifiable in unit test or by the named manual smoke. Failure of any single AC blocks the slice from PASS.

1. **Happy path.** With chain `[A, B, C]` where `A` returns a normal stream (start → text_delta → done), the wrapper emits exactly the same events to its caller. `done.message.provider` and `done.message.model` equal `A`. The log entry has one link with `outcome: "served"`. (Unit, mocked.)
2. **Single fallback.** With chain `[A, B, C]` where `A` errors with HTTP 429 *before* any content event and `B` returns a normal stream, the wrapper emits B's stream to the caller. The log entry has two links: `A: fallback (http-429)`, `B: served`. `done.message.provider === B.provider`. (Unit.)
3. **Multi-step fallback.** With chain `[A, B, C]` where `A` 429s, `B` 503s, `C` succeeds — caller sees `C`'s stream, log lists three links. (Unit.)
4. **All-fail / exhausted.** With chain `[A, B, C]` where all three return fallback-worthy errors, caller sees a single `error` event whose `errorMessage` names all three links and their error classes in order. Log terminal outcome is `exhausted`. (Unit.)
5. **Auth-error short-circuit.** With chain `[A, B]` where `A` returns HTTP 403, caller sees the 403 error propagated unchanged. `B` is never invoked (assert mock call count). Log entry: one link, outcome `fatal`. (Unit.)
6. **Mid-stream failure.** With chain `[A, B]` where `A` emits `start`, then `text_start`, then `text_delta("hi")`, then errors with 500, caller sees A's events through `text_delta` followed by A's error event. `B` is never invoked. Log terminal outcome `fatal`. (Unit.)
7. **Abort.** With chain `[A, B]` where `A` errors with `signal.aborted = true`, caller sees the abort event; `B` is never invoked; log terminal outcome `abort`. (Unit.)
8. **Configuration round-trip.** Given a `models.json` with two named chains, the extension registers `fallback/<chain-name>` for each at startup. `pi --list-models` (or equivalent registry probe) shows both. (Unit + manual smoke.)
9. **Per-Ghola override.** With config chain `[A, B, C]` and env `PI_FALLBACK_CHAIN="X/x,Y/y"`, the wrapper uses `[X/x, Y/y]` for that one call. Removing the env reverts to `[A, B, C]` on the next call. (Unit.)
10. **Telemetry log shape.** Every JSONL line parses as JSON, has fields `ts` (ISO-8601 UTC), `chain` (string), `links` (non-empty array), and the four identity fields (`sessionId`, `peerId`, `sliceId`, each string-or-null). No field contains an API key, refresh token, or `Authorization` header value. (Unit asserts redaction; tests run a synthetic 401 whose body contains `sk-ant-...` and verify it is stripped.)
11. **400 sub-classification.** A 400 with body `"...out of extra usage credits..."` triggers fallback; a 400 with body `"tool schema invalid"` is fatal. (Unit, two cases.)
12. **No-op when chain has one link.** A chain of length 1 behaves identically to calling the underlying provider directly; the wrapper adds at most one log entry. (Unit.)
13. **Lint + typecheck.** Biome `check`, Biome `format --check`, and `bun tsc --noEmit` pass on all new files. Pre-commit secret scanner (`.githooks/`, project CLAUDE.md) does not flag the extension. (Manual / CI.)

## 5. Open questions / risks

### Resolved (decisions Luci made on 2026-04-26 before implementer dispatch)

- **Q1 — Billing — RESOLVED.** Subscription routing for every link in the default chain. Anthropic via Meridian + pi-scrub (already wired). OpenAI via Pi's `/login` Codex OAuth (ChatGPT Plus/Pro). Google via Pi's `/login` Antigravity OAuth. Direct API keys are not used in the default chain. The implementation does not need to handle API-key auth for these providers — Pi's existing provider registrations carry the OAuth machinery; the fallback wrapper just resolves provider/model and delegates.
- **Q2 — Worst-case spend — RESOLVED MOOT.** Subscription-only billing means every call is flat-rate against quota Luci already pays for. No per-call cash exposure. Circuit breaker (`maxSpendPerCallUSD`) is removed from scope; the analogous concern (subscription-quota exhaustion) is handled by the chain itself — when one link's quota is drained, the next link absorbs traffic. If all three subscription pools simultaneously drain, the chain exhausts and the user sees a clear error (AC 4).
- **Q3 — Correlated failure jitter — DEFERRED to v2.** Per Luci: "not all agents run at the same time." Slice-by-slice serial dispatch (the SpecSafe loop) means a single Ghola is in flight at any given moment, not seven simultaneously. Thundering-herd risk is structurally low given the orchestration pattern. Revisit only if empirical observation shows otherwise.
- **Q4 — Per-Ghola chain location — KEEP env-var contract from §3.4.** Env var `PI_FALLBACK_CHAIN` read at call-time. Forward-compatible with a future frontmatter approach if `specsafe-subagents` later parses `fallback-chain:` from agent frontmatter and sets the env var. No work needed in this slice.
- **Q5 — Model-registry timing — KEEP lazy resolution from §3.4.** Chain config stores provider/model strings; resolution happens at call-time via `ctx.modelRegistry.find(...)`. Implementer must verify with a single-turn smoke test as TDD step 0 before writing the wrapper. If lazy resolution doesn't work for any reason, escalate before proceeding.
- **Q6 — `done` event message rewrite — KEEP per §3.3.** Patching `output.message.provider/model` to the actually-serving link is required for cost-attribution accuracy. Implementer verifies with a single-link-chain smoke that ends in real Anthropic — assert the session JSONL records `"anthropic"` (not `"fallback"`) on the served message. Escalate before full implementation if anything reads `"fallback"` as a sentinel.

### Remaining for implementer to surface during execution

- **Kimi-as-primary status.** Slice 7 governs the fallback chain only. Luci's earlier per-Ghola assignments (spec-writer / validator / doc-scout on Kimi K2.6) live in a separate slice (per-Ghola routing, slice 8 candidate). For slice 7, Kimi appears nowhere — neither in the default chain nor as any agent's pinned model. The implementer must not introduce Kimi into the chain or the extension's logic.

## 6. Handoff notes to test-writer

- Do not call live providers in the default suite. Construct `AssistantMessageEventStream` instances by hand using the pattern in `custom-provider.md:368-420`. Every test scenario in §4 maps to a scripted stream.
- The classifier (§3.2) deserves dedicated unit coverage independent of `runChain` — one test per row of the table, parameterized.
- The redaction test (AC 10) is load-bearing security. Synthesize an error whose stringification embeds an API-key-shaped token; assert the JSONL line does not contain it.
- The mid-stream test (AC 6) is the contract that v1 is *not* a transparent retry layer. Make it explicit and ugly so a future implementer doesn't soften it without thinking.
- Live integration test (`test/integration.live.test.ts`) gated behind `PI_LIVE_TESTS=1`. Skips loudly if the env is unset. Hits Anthropic only; budget one trivial call.

## 7. Handoff notes to implementer

- Read this entire spec, then `node_modules/@mariozechner/pi-coding-agent/examples/extensions/custom-provider-anthropic/index.ts` for the streamSimple construction pattern, then `node_modules/@mariozechner/pi-ai/dist/stream.js` to see the public `streamSimple` resolver you'll be re-calling.
- Probe Q5 and Q6 *before* writing the wrapper. Each is a single-turn empirical check; both must be green before the synthetic provider's `streamSimple` is implementable.
- Implement order: `chain.ts` (pure logic, fully unit-tested) → `config.ts` → `log.ts` → `index.ts` (the thin wrapper). Each layer testable in isolation.
- No new runtime deps. The extension uses Node built-ins (`fs`, `path`) plus types from `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent`. If a dep is tempting, stop and ask.
- Do not log API keys. Do not log full HTTP error bodies — keep `errorMessage` to the first 200 chars after redaction.
- Eat the dog food: this slice itself must be commit-trailered via `specsafe-subagents` (SPEC-001 §5.5). If you find yourself tempted to commit without trailers, stop and dispatch through Seshat.
