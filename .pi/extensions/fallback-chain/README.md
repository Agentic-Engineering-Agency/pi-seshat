# fallback-chain — Pi extension

Cross-provider fallback at the model-call layer. Registers a synthetic
provider `fallback` whose `streamSimple` walks a configured chain of
real provider/model pairs, transparently re-issuing the same call
against the next link when a primary fails with a fallback-worthy
error class.

SpecSafe slice: SPEC-20260426-007 (`specs/SPEC-20260426-007-cross-provider-fallback.md`).
Read the spec for the full rationale; this README is the operator's view.

## Theory

When you select `fallback/<chain-name>` via `/model`, every model call
goes through `runChain` instead of straight to a provider. For each
link in the chain, the wrapper calls the real `streamSimple()` from
`@mariozechner/pi-ai`, then watches the upstream event sequence:

- If a content event (`text_start`, `thinking_start`, or
  `toolcall_start`) arrives first, the wrapper is **committed** to that
  link. It forwards every subsequent event verbatim — including any
  later mid-stream error, which propagates as fatal. v1 does not
  attempt mid-stream retries; the user has already seen partial
  output, and silently re-issuing produces duplicated or contradictory
  continuations.
- If an `error` event arrives **before** any content event, the
  classifier (`chain.ts::classifyError`) buckets it into one of:
  - `fallback` — try the next link (HTTP 429, 5xx, 408, ECONNRESET,
    ENOTFOUND, ETIMEDOUT, or HTTP 400 with a quota/credit/balance
    message body).
  - `fatal` — propagate immediately (HTTP 401/403, schema-shaped 400,
    or any unrecognized error). Falling through on auth errors hides
    operator misconfiguration and silently spends another provider's
    budget.
  - `abort` — the user pressed Esc; never fall through.
- If the chain is exhausted, the wrapper synthesizes a single error
  event with a message like
  `fallback chain exhausted: anthropic/claude-opus-4-7 (http-429) →
  openai/gpt-5.5 (http-429) → google/gemini-2.5-pro (http-503)`.

Every fallback decision (success, fallback-and-advance, fatal, abort,
exhausted) is appended to a JSONL audit log — default
`.pi/.fallback-log.jsonl`, mode 0600, gitignored.

## Shape

```
.pi/extensions/fallback-chain/
  index.ts            # extension entry point — registers provider "fallback"
  chain.ts            # pure logic: classifyError, runChain
  config.ts           # parseConfig + resolveChain (env override aware)
  log.ts              # appendLog + redact (JSONL writer with key redaction)
  README.md           # this file
  test/
    chain.test.ts     # unit — 22 tests, scripted streams, no live LLM
    config.test.ts    # unit — 9 tests
    log.test.ts       # unit — 10 tests, redaction + file-mode + resilience
```

## Install / wire-up

The extension auto-loads from `.pi/extensions/` per Pi convention; no
settings change required for it to be picked up. Configuration lives
globally in `~/.pi/agent/models.json`:

```json
{
  "extensions": {
    "fallback-chain": {
      "chains": {
        "default": [
          { "provider": "anthropic", "model": "claude-opus-4-7" },
          { "provider": "openai",    "model": "gpt-5.5" },
          { "provider": "google",    "model": "gemini-2.5-pro" }
        ]
      },
      "logFile": ".pi/.fallback-log.jsonl"
    }
  }
}
```

For each named chain (`default`, `cheap`, `…`) the extension registers
a synthetic model `fallback/<name>`. Use it via:

```
pi --provider fallback --model default …
```

or, in interactive mode, select it from `/model`.

### Per-call override

Set `PI_FALLBACK_CHAIN="provider/model,provider/model,…"` to replace
the configured chain for one call. Read at call-time, never at module
load — the same pattern the Honcho extension uses for identity env
vars. This lets `specsafe-subagents` set a shorter chain per Ghola
without rewriting global config:

```
PI_FALLBACK_CHAIN="anthropic/claude-opus-4-7,openai/gpt-5.5" pi …
```

Empty string is treated as unset. Malformed entries throw a clear
error rather than silently fall through.

## Provider registration detail

The synthetic provider registers under api type `fallback-chain-api`.
This is deliberate: registering with `anthropic-messages` (or any
other built-in api type) would *replace* the built-in handler — and
then our chain calling `streamSimple()` on a real Anthropic model
would recurse back into us. Using a unique synthetic api id keeps
the chain wrapper out of the way of the real per-API handlers.

`baseUrl` and `apiKey` are set to placeholders because Pi's provider
config validator requires them when `models[]` is provided, but they
are never used: our `streamSimple` short-circuits the call before any
HTTP is performed.

## Edge cases handled

- **Mid-stream failure** (content event seen, then error) → fatal.
  Spec §3.3 contract: v1 is *not* a transparent retry layer.
- **Pre-stream auth error** (401/403) → fatal short-circuit.
  Subsequent links never invoked.
- **400 sub-classification.** Body matching `/extra usage|credit|
  balance|quota/i` is fallback-worthy (Anthropic Max overdraft surfaces
  as 400). Other 400s are fatal — schema/tool-validation errors will
  reproduce on every provider.
- **Abort propagation.** `signal.aborted === true` short-circuits at
  the start of every link iteration and on every classified error;
  the abort event is forwarded to the caller verbatim.
- **`done.message.provider/model` rewrite.** Spec §3.3: cost
  attribution and session JSONL must record the actually-serving
  provider, not `fallback`. The wrapper patches both fields on the
  upstream `done` event before forwarding it to the caller.
- **Empty chain** → synthesized error event, no log entry, no calls.
- **Single-link chain** behaves identically to calling the underlying
  provider directly, plus one log entry with `outcome: "served"`.
- **Log-write resilience.** `appendLog` *cannot* throw to its caller
  — failure goes to stderr only. Spec §3.5 requires this: a write to
  `.fallback-log.jsonl` that fails must not fail the model call.

## Redaction (load-bearing)

Every string field in the log entry is run through `redact()` before
serialization. Patterns currently stripped:

- `sk-ant-[A-Za-z0-9_-]+` (Anthropic API keys)
- `sk-[A-Za-z0-9]{20,}` (OpenAI-style keys)
- `Bearer [A-Za-z0-9._-]+` (case-insensitive bearer tokens)

Replacement is the literal string `[REDACTED]`. The redaction test in
`log.test.ts` AC10b is the security contract — do not weaken it.

## Deferred for v2

- **Mid-stream retry / replay.** Documented in spec §3.3 as a v2
  problem. Today, mid-stream failures propagate as-is.
- **Auto-tuning chain order** based on observed reliability.
- **Cost-aware routing** (this extension is fallback, not balancing).
- **Frontmatter-driven per-Ghola chain.** Forward-compatible — the env
  var contract means a future `specsafe-subagents` change can read
  `fallback-chain:` from agent frontmatter and set
  `PI_FALLBACK_CHAIN` without any change here.

## Risks / follow-ups

- **Lazy-resolution timing.** The wrapper captures the live
  `ModelRegistry` from the first `session_start` (or `agent_start`)
  event. If `streamSimple` is somehow invoked before either event
  fires, we throw a clear error rather than hang. So far this has
  not been observed; if it is, the fix is to capture the registry
  through a different lifecycle hook.
- **Subscription quota exhaustion.** Spec §5 Q2 notes that all default
  links are subscription-billed (Anthropic Meridian, OpenAI Codex
  OAuth, Google Antigravity OAuth) — there is no per-call cash
  exposure, but if all three pools simultaneously drain, the chain
  exhausts. The synthesized error message names every link tried, so
  this state is at least visible.
- **API-type collision.** If a future Pi release adds a built-in
  `fallback-chain-api` provider, this extension would conflict. Not
  expected — but worth flagging.
