/**
 * Tests for the fallback-chain extension's pure logic (chain.ts).
 *
 * SpecSafe slice: SPEC-20260426-007 — cross-provider-fallback
 *
 * Test types:
 *   [unit] — no network, no subprocesses, no live LLM calls. Streams are
 *            constructed by hand using `createAssistantMessageEventStream`
 *            from "@mariozechner/pi-ai".
 *
 * The runChain function and classifyError function imported below DO NOT
 * EXIST YET. The implementer creates them. This file's job is to encode
 * the spec's §4 acceptance criteria as failing tests up front (TDD red).
 *
 * Imports are resolved dynamically inside test bodies so that `bun run
 * typecheck` does not error on the missing module while still letting
 * `bun test` fail loudly until the implementer ships chain.ts.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Local type-shim for the not-yet-implemented module surface.
// Keeps tsc happy until ../chain.ts exists.
// ---------------------------------------------------------------------------

type ErrorClass = "fallback" | "fatal" | "abort";

interface ChainLink {
	provider: string;
	model: string;
}

interface LogEntryLink {
	provider: string;
	model: string;
	outcome: "served" | "fallback" | "fatal" | "abort" | "exhausted";
	errorClass?: string;
	errorMessage?: string;
	latencyMs?: number;
}

interface LogEntry {
	ts: string;
	chain: string;
	links: LogEntryLink[];
	sessionId: string | null;
	peerId: string | null;
	sliceId: string | null;
}

interface ResolveModelArgs {
	provider: string;
	model: string;
}

type CallStreamSimpleFn = (
	model: { provider: string; modelId: string; api: string },
	context: unknown,
	options?: unknown,
) => AssistantMessageEventStream;

interface RunChainArgs {
	chain: ChainLink[];
	chainName: string;
	resolveModel: (args: ResolveModelArgs) => { provider: string; modelId: string; api: string };
	callStreamSimple: CallStreamSimpleFn;
	classify: (err: unknown) => ErrorClass;
	log: (entry: LogEntry) => void;
	signal?: AbortSignal;
}

type RunChainFn = (
	args: RunChainArgs,
	context: unknown,
	options?: unknown,
) => AssistantMessageEventStream;

type ClassifyErrorFn = (err: unknown) => ErrorClass;

// Lazy module accessor. Throws at call-time if the impl module is absent —
// which is exactly what we want until the implementer creates ../chain.ts.
async function loadChainModule(): Promise<{
	runChain: RunChainFn;
	classifyError: ClassifyErrorFn;
}> {
	// Dynamic import via a runtime-computed specifier so tsc cannot resolve
	// the target at typecheck time. The implementer creates ../chain.ts;
	// until then `bun test` fails at this `import()`, which is the correct
	// TDD red signal. `bun run typecheck` stays green for the rest of the
	// codebase.
	const spec = "../chain.ts";
	// biome-ignore lint/suspicious/noExplicitAny: deferred import shim
	const mod = (await import(/* @vite-ignore */ spec)) as any;
	return { runChain: mod.runChain, classifyError: mod.classifyError };
}

// ---------------------------------------------------------------------------
// Helpers — hand-built streams scripted per scenario.
// ---------------------------------------------------------------------------

function blankAssistantMessage(provider = "?", modelId = "?"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		stopReason: "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		provider,
		model: modelId,
		// biome-ignore lint/suspicious/noExplicitAny: pi-ai AssistantMessage shape varies by version
	} as any;
}

interface ScriptedError {
	status?: number;
	message?: string;
	body?: string;
	aborted?: boolean;
}

function makeErrorEventStream(
	provider: string,
	modelId: string,
	err: ScriptedError,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const errMsg = blankAssistantMessage(provider, modelId);
	// biome-ignore lint/suspicious/noExplicitAny: stopReason field
	(errMsg as any).stopReason = err.aborted ? "aborted" : "error";
	// biome-ignore lint/suspicious/noExplicitAny: errorMessage field
	(errMsg as any).errorMessage = err.message ?? `HTTP ${err.status}`;
	// Embed status/body so classify() (called by runChain) can read them.
	const carrier: Record<string, unknown> = {
		status: err.status,
		message: err.message ?? `HTTP ${err.status}`,
		body: err.body,
		aborted: err.aborted,
	};
	// biome-ignore lint/suspicious/noExplicitAny: attach raw err for classifier
	(errMsg as any).rawError = carrier;

	// Spec §3.3: the underlying provider emits `start` then `error` for
	// pre-stream failures. The wrapper must classify based on the error
	// content carried in the error event's message.
	stream.push({ type: "start", partial: blankAssistantMessage(provider, modelId) } as AssistantMessageEvent);
	stream.push({
		type: "error",
		reason: err.aborted ? "aborted" : "error",
		error: errMsg,
	} as AssistantMessageEvent);
	stream.end(errMsg);
	return stream;
}

function makeSuccessEventStream(
	provider: string,
	modelId: string,
	text: string,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const partial = blankAssistantMessage(provider, modelId);
	stream.push({ type: "start", partial } as AssistantMessageEvent);
	stream.push({ type: "text_start", contentIndex: 0, partial } as AssistantMessageEvent);
	stream.push({
		type: "text_delta",
		contentIndex: 0,
		delta: text,
		partial,
	} as AssistantMessageEvent);
	stream.push({
		type: "text_end",
		contentIndex: 0,
		content: text,
		partial,
	} as AssistantMessageEvent);
	const final: AssistantMessage = {
		...blankAssistantMessage(provider, modelId),
		content: [{ type: "text", text }],
		// biome-ignore lint/suspicious/noExplicitAny: partial AssistantMessage shape
	} as any;
	stream.push({ type: "done", reason: "stop", message: final } as AssistantMessageEvent);
	stream.end(final);
	return stream;
}

function makeMidStreamErrorStream(
	provider: string,
	modelId: string,
	textBeforeError: string,
	err: ScriptedError,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const partial = blankAssistantMessage(provider, modelId);
	stream.push({ type: "start", partial } as AssistantMessageEvent);
	stream.push({ type: "text_start", contentIndex: 0, partial } as AssistantMessageEvent);
	stream.push({
		type: "text_delta",
		contentIndex: 0,
		delta: textBeforeError,
		partial,
	} as AssistantMessageEvent);
	const errMsg = blankAssistantMessage(provider, modelId);
	// biome-ignore lint/suspicious/noExplicitAny: stopReason field
	(errMsg as any).stopReason = "error";
	// biome-ignore lint/suspicious/noExplicitAny: errorMessage field
	(errMsg as any).errorMessage = err.message ?? `HTTP ${err.status}`;
	// biome-ignore lint/suspicious/noExplicitAny: attach raw err
	(errMsg as any).rawError = { status: err.status, message: err.message, body: err.body };
	stream.push({ type: "error", reason: "error", error: errMsg } as AssistantMessageEvent);
	stream.end(errMsg);
	return stream;
}

// ---------------------------------------------------------------------------
// Test harness state
// ---------------------------------------------------------------------------

interface CallRecord {
	provider: string;
	modelId: string;
}

interface Harness {
	calls: CallRecord[];
	logs: LogEntry[];
	scripts: AssistantMessageEventStream[];
	resolveModel: RunChainArgs["resolveModel"];
	callStreamSimple: CallStreamSimpleFn;
	log: (entry: LogEntry) => void;
}

function makeHarness(scripts: AssistantMessageEventStream[]): Harness {
	const calls: CallRecord[] = [];
	const logs: LogEntry[] = [];
	let i = 0;
	return {
		calls,
		logs,
		scripts,
		resolveModel: ({ provider, model }) => ({ provider, modelId: model, api: "anthropic-messages" }),
		callStreamSimple: (model) => {
			calls.push({ provider: model.provider, modelId: model.modelId });
			const next = scripts[i++];
			if (!next) {
				throw new Error(`harness ran out of scripted streams at call #${i}`);
			}
			return next;
		},
		log: (entry) => {
			logs.push(entry);
		},
	};
}

async function drain(stream: AssistantMessageEventStream): Promise<{
	events: AssistantMessageEvent[];
	final: AssistantMessage;
}> {
	const events: AssistantMessageEvent[] = [];
	for await (const ev of stream) {
		events.push(ev);
	}
	const final = await stream.result();
	return { events, final };
}

const ctx = { messages: [], systemPrompt: "" };

// ---------------------------------------------------------------------------
// AC 1 — Happy path
// ---------------------------------------------------------------------------

describe("[unit] runChain — AC1 happy path", () => {
	test("AC1: single-link chain emits primary's events verbatim, done.message.provider matches, log entry outcome=served", async () => {
		const { runChain } = await loadChainModule();
		const harness = makeHarness([makeSuccessEventStream("anthropic", "claude-opus-4-7", "hello")]);
		const out = runChain(
			{
				chain: [{ provider: "anthropic", model: "claude-opus-4-7" }],
				chainName: "default",
				resolveModel: harness.resolveModel,
				callStreamSimple: harness.callStreamSimple,
				classify: (e) => {
					// biome-ignore lint/suspicious/noExplicitAny: synthetic err
					const c = (e as any)?.rawError ?? {};
					if (c.aborted) return "abort";
					return "fatal";
				},
				log: harness.log,
			},
			ctx,
		);
		const { events } = await drain(out);
		const done = events.find((e) => e.type === "done");
		expect(done).toBeDefined();
		expect(done && done.type === "done" && done.message.provider).toBe("anthropic");
		expect(done && done.type === "done" && done.message.model).toBe("claude-opus-4-7");
		expect(harness.calls).toHaveLength(1);
		expect(harness.logs).toHaveLength(1);
		expect(harness.logs[0]?.links[0]?.outcome).toBe("served");
	});
});

// ---------------------------------------------------------------------------
// AC 2 — Single fallback
// ---------------------------------------------------------------------------

describe("[unit] runChain — AC2 single fallback", () => {
	test("AC2: chain [A,B] where A 429s pre-stream falls to B, log lists A:fallback then B:served", async () => {
		const { runChain, classifyError } = await loadChainModule();
		const scripts = [
			makeErrorEventStream("anthropic", "claude-opus-4-7", { status: 429, message: "rate limited" }),
			makeSuccessEventStream("openai", "gpt-5.5", "hello from B"),
		];
		const harness = makeHarness(scripts);
		const out = runChain(
			{
				chain: [
					{ provider: "anthropic", model: "claude-opus-4-7" },
					{ provider: "openai", model: "gpt-5.5" },
				],
				chainName: "default",
				resolveModel: harness.resolveModel,
				callStreamSimple: harness.callStreamSimple,
				classify: classifyError,
				log: harness.log,
			},
			ctx,
		);
		const { events } = await drain(out);
		const done = events.find((e) => e.type === "done");
		expect(done && done.type === "done" && done.message.provider).toBe("openai");
		expect(done && done.type === "done" && done.message.model).toBe("gpt-5.5");
		expect(harness.calls).toHaveLength(2);
		const links = harness.logs.at(-1)?.links ?? [];
		expect(links).toHaveLength(2);
		expect(links[0]?.outcome).toBe("fallback");
		expect(links[0]?.provider).toBe("anthropic");
		expect(links[1]?.outcome).toBe("served");
		expect(links[1]?.provider).toBe("openai");
	});
});

// ---------------------------------------------------------------------------
// AC 3 — Multi-step fallback
// ---------------------------------------------------------------------------

describe("[unit] runChain — AC3 multi-step", () => {
	test("AC3: chain [A,B,C] where A:429, B:503, C:success — caller sees C, log has 3 entries", async () => {
		const { runChain, classifyError } = await loadChainModule();
		const scripts = [
			makeErrorEventStream("anthropic", "claude-opus-4-7", { status: 429, message: "rate limited" }),
			makeErrorEventStream("openai", "gpt-5.5", { status: 503, message: "service unavailable" }),
			makeSuccessEventStream("google", "gemini-2.5-pro", "hello from C"),
		];
		const harness = makeHarness(scripts);
		const out = runChain(
			{
				chain: [
					{ provider: "anthropic", model: "claude-opus-4-7" },
					{ provider: "openai", model: "gpt-5.5" },
					{ provider: "google", model: "gemini-2.5-pro" },
				],
				chainName: "default",
				resolveModel: harness.resolveModel,
				callStreamSimple: harness.callStreamSimple,
				classify: classifyError,
				log: harness.log,
			},
			ctx,
		);
		const { events } = await drain(out);
		const done = events.find((e) => e.type === "done");
		expect(done && done.type === "done" && done.message.provider).toBe("google");
		expect(harness.calls).toHaveLength(3);
		const links = harness.logs.at(-1)?.links ?? [];
		expect(links.map((l) => l.outcome)).toEqual(["fallback", "fallback", "served"]);
	});
});

// ---------------------------------------------------------------------------
// AC 4 — Exhausted
// ---------------------------------------------------------------------------

describe("[unit] runChain — AC4 exhausted", () => {
	test("AC4: chain [A,B,C] all 429 — single error event with all 3 link names + error classes; log terminal outcome=exhausted", async () => {
		const { runChain, classifyError } = await loadChainModule();
		const scripts = [
			makeErrorEventStream("anthropic", "claude-opus-4-7", { status: 429, message: "rate limited" }),
			makeErrorEventStream("openai", "gpt-5.5", { status: 429, message: "rate limited" }),
			makeErrorEventStream("google", "gemini-2.5-pro", { status: 429, message: "rate limited" }),
		];
		const harness = makeHarness(scripts);
		const out = runChain(
			{
				chain: [
					{ provider: "anthropic", model: "claude-opus-4-7" },
					{ provider: "openai", model: "gpt-5.5" },
					{ provider: "google", model: "gemini-2.5-pro" },
				],
				chainName: "default",
				resolveModel: harness.resolveModel,
				callStreamSimple: harness.callStreamSimple,
				classify: classifyError,
				log: harness.log,
			},
			ctx,
		);
		const { events } = await drain(out);
		const errEvents = events.filter((e) => e.type === "error");
		expect(errEvents).toHaveLength(1);
		const errEvent = errEvents[0];
		// biome-ignore lint/suspicious/noExplicitAny: errorMessage on AssistantMessage
		const errText: string = (errEvent && errEvent.type === "error" && (errEvent.error as any).errorMessage) || "";
		expect(errText).toContain("anthropic");
		expect(errText).toContain("openai");
		expect(errText).toContain("google");
		expect(errText).toContain("exhausted");
		const lastEntry = harness.logs.at(-1);
		const lastLink = lastEntry?.links.at(-1);
		// Terminal outcome: per spec §3.5 the terminal is one of served/fatal/abort/exhausted.
		// AC 4 specifies the terminal outcome is "exhausted".
		const hasExhausted =
			lastEntry?.links.some((l) => l.outcome === "exhausted") || lastLink?.outcome === "exhausted";
		expect(hasExhausted).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// AC 5 — Auth short-circuit (403)
// ---------------------------------------------------------------------------

describe("[unit] runChain — AC5 auth short-circuit", () => {
	test("AC5: chain [A,B] where A 403 is fatal — caller sees 403 propagated, B never invoked, log outcome=fatal", async () => {
		const { runChain, classifyError } = await loadChainModule();
		const scripts = [
			makeErrorEventStream("anthropic", "claude-opus-4-7", { status: 403, message: "forbidden" }),
			// B's stream is provided so the harness doesn't crash if accidentally reached;
			// the assertion below proves it's untouched.
			makeSuccessEventStream("openai", "gpt-5.5", "should not happen"),
		];
		const harness = makeHarness(scripts);
		const out = runChain(
			{
				chain: [
					{ provider: "anthropic", model: "claude-opus-4-7" },
					{ provider: "openai", model: "gpt-5.5" },
				],
				chainName: "default",
				resolveModel: harness.resolveModel,
				callStreamSimple: harness.callStreamSimple,
				classify: classifyError,
				log: harness.log,
			},
			ctx,
		);
		const { events } = await drain(out);
		const errEvents = events.filter((e) => e.type === "error");
		expect(errEvents).toHaveLength(1);
		// B must never be invoked.
		expect(harness.calls).toHaveLength(1);
		expect(harness.calls[0]?.provider).toBe("anthropic");
		const links = harness.logs.at(-1)?.links ?? [];
		expect(links).toHaveLength(1);
		expect(links[0]?.outcome).toBe("fatal");
	});
});

// ---------------------------------------------------------------------------
// AC 6 — Mid-stream failure
// ---------------------------------------------------------------------------

describe("[unit] runChain — AC6 mid-stream failure", () => {
	test("AC6: chain [A,B] where A emits text_delta then errors — caller sees A's events including error, B never invoked", async () => {
		const { runChain, classifyError } = await loadChainModule();
		const scripts = [
			makeMidStreamErrorStream("anthropic", "claude-opus-4-7", "hi", { status: 500, message: "server error" }),
			makeSuccessEventStream("openai", "gpt-5.5", "should not happen"),
		];
		const harness = makeHarness(scripts);
		const out = runChain(
			{
				chain: [
					{ provider: "anthropic", model: "claude-opus-4-7" },
					{ provider: "openai", model: "gpt-5.5" },
				],
				chainName: "default",
				resolveModel: harness.resolveModel,
				callStreamSimple: harness.callStreamSimple,
				classify: classifyError,
				log: harness.log,
			},
			ctx,
		);
		const { events } = await drain(out);
		// Caller saw text_delta before the error
		const sawDelta = events.some((e) => e.type === "text_delta");
		expect(sawDelta).toBe(true);
		const sawError = events.some((e) => e.type === "error");
		expect(sawError).toBe(true);
		// B is never invoked because the error happened mid-stream → fatal per §3.2.
		expect(harness.calls).toHaveLength(1);
		const links = harness.logs.at(-1)?.links ?? [];
		expect(links.at(-1)?.outcome).toBe("fatal");
	});
});

// ---------------------------------------------------------------------------
// AC 7 — Abort
// ---------------------------------------------------------------------------

describe("[unit] runChain — AC7 abort", () => {
	test("AC7: chain [A,B] where A signals abort — caller sees abort, B never invoked, log outcome=abort", async () => {
		const { runChain, classifyError } = await loadChainModule();
		const scripts = [
			makeErrorEventStream("anthropic", "claude-opus-4-7", { aborted: true, message: "user aborted" }),
			makeSuccessEventStream("openai", "gpt-5.5", "should not happen"),
		];
		const harness = makeHarness(scripts);
		const out = runChain(
			{
				chain: [
					{ provider: "anthropic", model: "claude-opus-4-7" },
					{ provider: "openai", model: "gpt-5.5" },
				],
				chainName: "default",
				resolveModel: harness.resolveModel,
				callStreamSimple: harness.callStreamSimple,
				classify: classifyError,
				log: harness.log,
			},
			ctx,
		);
		const { events } = await drain(out);
		const errEvents = events.filter((e) => e.type === "error");
		expect(errEvents).toHaveLength(1);
		expect(errEvents[0] && errEvents[0].type === "error" && errEvents[0].reason).toBe("aborted");
		expect(harness.calls).toHaveLength(1);
		const links = harness.logs.at(-1)?.links ?? [];
		expect(links.at(-1)?.outcome).toBe("abort");
	});
});

// ---------------------------------------------------------------------------
// AC 11 — 400 sub-classification (classifyError direct tests)
// ---------------------------------------------------------------------------

describe("[unit] classifyError — AC11 400 sub-classification", () => {
	test("AC11a: 400 with body /extra usage|credit|balance|quota/i is fallback", async () => {
		const { classifyError } = await loadChainModule();
		expect(classifyError({ status: 400, body: "out of extra usage credits, please upgrade" })).toBe("fallback");
		expect(classifyError({ status: 400, body: "balance exceeded" })).toBe("fallback");
		expect(classifyError({ status: 400, body: "quota reached" })).toBe("fallback");
		expect(classifyError({ status: 400, body: "Out Of Credit" })).toBe("fallback");
	});

	test("AC11b: 400 schema-error is fatal", async () => {
		const { classifyError } = await loadChainModule();
		expect(classifyError({ status: 400, body: "tool schema invalid" })).toBe("fatal");
		expect(classifyError({ status: 400, body: "messages: invalid role" })).toBe("fatal");
	});
});

// ---------------------------------------------------------------------------
// AC 12 — No-op when chain has one link (mirrors AC1 with explicit assertion)
// ---------------------------------------------------------------------------

describe("[unit] runChain — AC12 no-op single-link", () => {
	test("AC12: chain length 1 with successful primary, exactly one log entry with outcome=served, events forwarded verbatim", async () => {
		const { runChain, classifyError } = await loadChainModule();
		const scripts = [makeSuccessEventStream("anthropic", "claude-opus-4-7", "hi")];
		const harness = makeHarness(scripts);
		const out = runChain(
			{
				chain: [{ provider: "anthropic", model: "claude-opus-4-7" }],
				chainName: "default",
				resolveModel: harness.resolveModel,
				callStreamSimple: harness.callStreamSimple,
				classify: classifyError,
				log: harness.log,
			},
			ctx,
		);
		const { events } = await drain(out);
		// At minimum the caller must see start, text_start, text_delta, text_end, done.
		expect(events.some((e) => e.type === "start")).toBe(true);
		expect(events.some((e) => e.type === "text_delta")).toBe(true);
		expect(events.some((e) => e.type === "done")).toBe(true);
		expect(harness.calls).toHaveLength(1);
		expect(harness.logs).toHaveLength(1);
		expect(harness.logs[0]?.links).toHaveLength(1);
		expect(harness.logs[0]?.links[0]?.outcome).toBe("served");
	});
});

// ---------------------------------------------------------------------------
// Bonus — classifier coverage of every row of §3.2
// ---------------------------------------------------------------------------

describe("[unit] classifyError — §3.2 table coverage", () => {
	const cases: Array<[string, unknown, ErrorClass]> = [
		["HTTP 429 → fallback", { status: 429, message: "rate limited" }, "fallback"],
		["HTTP 500 → fallback", { status: 500, message: "internal server error" }, "fallback"],
		["HTTP 502 → fallback", { status: 502, message: "bad gateway" }, "fallback"],
		["HTTP 503 → fallback", { status: 503, message: "unavailable" }, "fallback"],
		["HTTP 408 → fallback", { status: 408, message: "request timeout" }, "fallback"],
		["ECONNRESET → fallback", { code: "ECONNRESET", message: "socket hang up" }, "fallback"],
		["ENOTFOUND → fallback", { code: "ENOTFOUND", message: "dns failure" }, "fallback"],
		["HTTP 401 → fatal", { status: 401, message: "unauthorized" }, "fatal"],
		["HTTP 403 → fatal", { status: 403, message: "forbidden" }, "fatal"],
		["aborted → abort", { aborted: true, message: "user esc" }, "abort"],
		["unknown → fatal", { weird: true }, "fatal"],
	];
	for (const [label, err, expected] of cases) {
		test(`classifyError: ${label}`, async () => {
			const { classifyError } = await loadChainModule();
			expect(classifyError(err)).toBe(expected);
		});
	}
});

// ---------------------------------------------------------------------------
// Bonus — defensive runChain behaviors
// ---------------------------------------------------------------------------

describe("[unit] runChain — defensive", () => {
	test("empty chain throws or emits a clear error", async () => {
		const { runChain, classifyError } = await loadChainModule();
		const harness = makeHarness([]);
		let threwSync = false;
		// biome-ignore lint/suspicious/noExplicitAny: out may be undefined if it throws sync
		let out: any;
		try {
			out = runChain(
				{
					chain: [],
					chainName: "default",
					resolveModel: harness.resolveModel,
					callStreamSimple: harness.callStreamSimple,
					classify: classifyError,
					log: harness.log,
				},
				ctx,
			);
		} catch {
			threwSync = true;
		}
		if (threwSync) {
			expect(harness.calls).toHaveLength(0);
			return;
		}
		const { events } = await drain(out);
		expect(events.some((e) => e.type === "error")).toBe(true);
		expect(harness.calls).toHaveLength(0);
	});
});

// Sanity: harness factory itself should work without runChain present
beforeEach(() => {
	// no-op — keeps bun:test's lifecycle hooks referenced so the suite shape
	// matches honcho.test.ts conventions.
});
