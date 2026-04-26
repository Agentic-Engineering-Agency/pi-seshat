/**
 * Cross-provider fallback chain — pure logic.
 *
 * SpecSafe slice: SPEC-20260426-007 — cross-provider-fallback
 *
 * Two exports:
 *   - classifyError(err): bucket an error per spec §3.2.
 *   - runChain(args, context, options): walk a chain of provider/model
 *     links, falling through pre-stream errors that classify as
 *     "fallback", forwarding committed streams verbatim, and emitting a
 *     synthesized exhaustion error if no link succeeds.
 *
 * The runChain function takes injected dependencies (resolveModel,
 * callStreamSimple, classify, log) so unit tests can drive it without
 * live providers — the wrapper in index.ts injects the real ones.
 */

import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ErrorClass = "fallback" | "fatal" | "abort";

export interface ChainLink {
	provider: string;
	model: string;
}

export interface LogEntryLink {
	provider: string;
	model: string;
	outcome: LinkOutcome;
	errorClass?: string;
	errorMessage?: string;
	latencyMs?: number;
}

export type LinkOutcome = "served" | "fallback" | "fatal" | "abort" | "exhausted";

export interface LogEntry {
	ts: string;
	chain: string;
	links: LogEntryLink[];
	sessionId: string | null;
	peerId: string | null;
	sliceId: string | null;
}

export interface ResolvedModel {
	provider: string;
	modelId: string;
	api: string;
}

export type CallStreamSimpleFn = (
	model: ResolvedModel,
	context: unknown,
	options?: unknown,
) => AssistantMessageEventStream;

export interface RunChainArgs {
	chain: ChainLink[];
	chainName: string;
	resolveModel: (args: { provider: string; model: string }) => ResolvedModel;
	callStreamSimple: CallStreamSimpleFn;
	classify: (err: unknown) => ErrorClass;
	log: (entry: LogEntry) => void;
	signal?: AbortSignal;
}

export type RunChainFn = (args: RunChainArgs, context: unknown, options?: unknown) => AssistantMessageEventStream;

// ---------------------------------------------------------------------------
// classifyError — implements §3.2 table.
// ---------------------------------------------------------------------------

const FALLBACK_400_BODY = /extra usage|credit|balance|quota/i;

function readField<T = unknown>(obj: unknown, key: string): T | undefined {
	if (obj && typeof obj === "object" && key in obj) {
		return (obj as Record<string, unknown>)[key] as T;
	}
	return undefined;
}

export function classifyError(err: unknown): ErrorClass {
	if (err == null) return "fatal";

	// Unwrap a `rawError` carrier if present (the test harness embeds
	// status/body/aborted on rawError; production may pass the err
	// object directly). Both shapes are valid.
	const raw = readField(err, "rawError") ?? err;

	const aborted = readField<boolean>(raw, "aborted") || readField<boolean>(err, "aborted");
	if (aborted === true) return "abort";

	const status = readField<number>(raw, "status") ?? readField<number>(err, "status");
	const code = readField<string>(raw, "code") ?? readField<string>(err, "code");
	const body = readField<string>(raw, "body") ?? readField<string>(err, "body") ?? "";

	if (typeof status === "number") {
		if (status === 429 || status === 408) return "fallback";
		if (status >= 500 && status < 600) return "fallback";
		if (status === 401 || status === 403) return "fatal";
		if (status === 400) {
			if (typeof body === "string" && FALLBACK_400_BODY.test(body)) return "fallback";
			return "fatal";
		}
	}

	if (typeof code === "string") {
		if (code === "ECONNRESET" || code === "ENOTFOUND" || code === "ETIMEDOUT") return "fallback";
	}

	return "fatal";
}

// ---------------------------------------------------------------------------
// runChain — walks the chain.
// ---------------------------------------------------------------------------

const CONTENT_EVENT_TYPES = new Set<string>(["text_start", "thinking_start", "toolcall_start"]);

function nowIso(): string {
	return new Date().toISOString();
}

function envOrNull(name: string): string | null {
	const v = process.env[name];
	return v && v.length > 0 ? v : null;
}

function blankAssistantMessage(provider: string, modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		stopReason: "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		provider,
		model: modelId,
	} as any;
}

function classifyForRun(
	classify: (err: unknown) => ErrorClass,
	signal: AbortSignal | undefined,
	errEvent: AssistantMessageEvent & { type: "error" },
): ErrorClass {
	if (signal?.aborted === true) return "abort";
	if (errEvent.reason === "aborted") return "abort";
	return classify(errEvent.error as any);
}

function statusOrCode(err: unknown): string {
	const raw = readField(err, "rawError") ?? err;
	const status = readField<number>(raw, "status");
	if (typeof status === "number") return `http-${status}`;
	const code = readField<string>(raw, "code");
	if (typeof code === "string") return code.toLowerCase();
	const aborted = readField<boolean>(raw, "aborted");
	if (aborted === true) return "aborted";
	return "unknown";
}

function shortMessage(err: unknown, maxLen = 200): string {
	const raw = readField(err, "rawError") ?? err;
	const m = readField<string>(raw, "message") ?? readField<string>(err, "message") ?? "";
	const s = String(m);
	return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

export function runChain(args: RunChainArgs, context: unknown, options?: unknown): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();

	if (!Array.isArray(args.chain) || args.chain.length === 0) {
		const errMsg = blankAssistantMessage("fallback", args.chainName);
		(errMsg as any).errorMessage = "fallback chain is empty";
		(errMsg as any).stopReason = "error";
		// Synthesize a single error event.
		queueMicrotask(() => {
			out.push({ type: "error", reason: "error", error: errMsg } as AssistantMessageEvent);
			out.end(errMsg);
		});
		// Log nothing; nothing was attempted.
		return out;
	}

	const sessionId = envOrNull("HONCHO_SESSION_ID");
	const peerId = envOrNull("HONCHO_PEER_ID");
	const sliceId = envOrNull("SPECSAFE_SLICE_ID");

	(async () => {
		const linkLogs: LogEntryLink[] = [];
		// Emit the wrapper's `start` event using the first link's metadata.
		const firstLink = args.chain[0]!;
		out.push({
			type: "start",
			partial: blankAssistantMessage(firstLink.provider, firstLink.model),
		} as AssistantMessageEvent);

		try {
			for (let i = 0; i < args.chain.length; i++) {
				const link = args.chain[i]!;
				const isLast = i === args.chain.length - 1;
				const startedAt = Date.now();

				// User-cancel check before kicking off the next link.
				if (args.signal?.aborted === true) {
					linkLogs.push({
						provider: link.provider,
						model: link.model,
						outcome: "abort",
						errorClass: "aborted",
						errorMessage: "signal aborted",
					});
					const errMsg = blankAssistantMessage(link.provider, link.model);
					(errMsg as any).stopReason = "aborted";
					(errMsg as any).errorMessage = "user aborted";
					out.push({ type: "error", reason: "aborted", error: errMsg } as AssistantMessageEvent);
					out.end(errMsg);
					emitLog(args, linkLogs, sessionId, peerId, sliceId);
					return;
				}

				let resolved: ResolvedModel;
				try {
					resolved = args.resolveModel({ provider: link.provider, model: link.model });
				} catch (resolveErr) {
					// Unresolvable link → fatal for that link; treat as fallback-worthy
					// only if more links remain (operator may have a typo on one).
					const cls: ErrorClass = isLast ? "fatal" : "fallback";
					const errClass = `resolve-${cls}`;
					linkLogs.push({
						provider: link.provider,
						model: link.model,
						outcome: cls === "fatal" ? "exhausted" : "fallback",
						errorClass: errClass,
						errorMessage: shortMessage(resolveErr),
					});
					if (cls === "fatal") {
						const errMsg = blankAssistantMessage(link.provider, link.model);
						(errMsg as any).errorMessage = `fallback chain exhausted: ${formatExhaustedMessage(linkLogs)}`;
						(errMsg as any).stopReason = "error";
						out.push({ type: "error", reason: "error", error: errMsg } as AssistantMessageEvent);
						out.end(errMsg);
						emitLog(args, linkLogs, sessionId, peerId, sliceId);
						return;
					}
					continue;
				}

				const upstream = args.callStreamSimple(resolved, context, options);
				let committed = false;

				let preStreamError: (AssistantMessageEvent & { type: "error" }) | null = null;

				for await (const ev of upstream) {
					if (!committed) {
						if (ev.type === "error") {
							preStreamError = ev as AssistantMessageEvent & { type: "error" };
							break;
						}
						if (CONTENT_EVENT_TYPES.has(ev.type)) {
							committed = true;
							// Forward this event as the first content event.
							out.push(ev);
							continue;
						}
						// Drop any pre-content `start` from upstream — wrapper already
						// emitted its own. Forward other non-content non-error events
						// (e.g. partial usage updates, if any).
						if (ev.type === "start") {
							continue;
						}
						out.push(ev);
						continue;
					}
					// Committed → forward verbatim, but patch `done` message metadata.
					if (ev.type === "done") {
						const doneEv = ev as AssistantMessageEvent & { type: "done" };
						const patched = patchDoneMessage(doneEv.message, link.provider, link.model);
						out.push({ ...doneEv, message: patched } as AssistantMessageEvent);
					} else {
						out.push(ev);
					}
				}

				if (committed) {
					// Stream finished normally (or terminated mid-stream after
					// content). The upstream's done/error event has already been
					// forwarded; finalize the wrapper stream.
					const finalMsg = await upstream.result();
					const stopReason = readField<string>(finalMsg, "stopReason");
					const isError = stopReason === "error" || stopReason === "aborted";
					const outcome: LinkOutcome = isError ? "fatal" : "served";
					linkLogs.push({
						provider: link.provider,
						model: link.model,
						outcome,
						latencyMs: Date.now() - startedAt,
						...(isError
							? {
									errorClass: statusOrCode(finalMsg),
									errorMessage: shortMessage(finalMsg),
								}
							: {}),
					});
					out.end(patchDoneMessage(finalMsg, link.provider, link.model));
					emitLog(args, linkLogs, sessionId, peerId, sliceId);
					return;
				}

				// Pre-stream error path.
				if (!preStreamError) {
					// Stream ended without any event — treat as fallback-worthy unknown.
					linkLogs.push({
						provider: link.provider,
						model: link.model,
						outcome: isLast ? "exhausted" : "fallback",
						errorClass: "empty-stream",
						errorMessage: "upstream ended with no events",
					});
					if (isLast) {
						const errMsg = blankAssistantMessage(link.provider, link.model);
						(errMsg as any).errorMessage = `fallback chain exhausted: ${formatExhaustedMessage(linkLogs)}`;
						(errMsg as any).stopReason = "error";
						out.push({ type: "error", reason: "error", error: errMsg } as AssistantMessageEvent);
						out.end(errMsg);
						emitLog(args, linkLogs, sessionId, peerId, sliceId);
						return;
					}
					continue;
				}

				const cls = classifyForRun(args.classify, args.signal, preStreamError);
				const errClass = statusOrCode(preStreamError.error);
				const errMsgText = shortMessage(preStreamError.error);

				if (cls === "abort") {
					linkLogs.push({
						provider: link.provider,
						model: link.model,
						outcome: "abort",
						errorClass: errClass,
						errorMessage: errMsgText,
					});
					out.push(preStreamError);
					out.end(preStreamError.error);
					emitLog(args, linkLogs, sessionId, peerId, sliceId);
					return;
				}
				if (cls === "fatal") {
					linkLogs.push({
						provider: link.provider,
						model: link.model,
						outcome: "fatal",
						errorClass: errClass,
						errorMessage: errMsgText,
					});
					out.push(preStreamError);
					out.end(preStreamError.error);
					emitLog(args, linkLogs, sessionId, peerId, sliceId);
					return;
				}

				// fallback: log and advance, unless this was the last link → exhausted.
				if (isLast) {
					linkLogs.push({
						provider: link.provider,
						model: link.model,
						outcome: "exhausted",
						errorClass: errClass,
						errorMessage: errMsgText,
					});
					const synthesized = blankAssistantMessage("fallback", args.chainName);
					(synthesized as any).errorMessage = `fallback chain exhausted: ${formatExhaustedMessage(linkLogs)}`;
					(synthesized as any).stopReason = "error";
					out.push({ type: "error", reason: "error", error: synthesized } as AssistantMessageEvent);
					out.end(synthesized);
					emitLog(args, linkLogs, sessionId, peerId, sliceId);
					return;
				}

				linkLogs.push({
					provider: link.provider,
					model: link.model,
					outcome: "fallback",
					errorClass: errClass,
					errorMessage: errMsgText,
				});
				// continue to next link
			}
			// Loop fell off naturally — should not happen because the last
			// iteration always returns. Be defensive.
			const errMsg = blankAssistantMessage("fallback", args.chainName);
			(errMsg as any).errorMessage = `fallback chain exhausted: ${formatExhaustedMessage(linkLogs)}`;
			(errMsg as any).stopReason = "error";
			out.push({ type: "error", reason: "error", error: errMsg } as AssistantMessageEvent);
			out.end(errMsg);
			emitLog(args, linkLogs, sessionId, peerId, sliceId);
		} catch (loopErr) {
			const errMsg = blankAssistantMessage("fallback", args.chainName);
			(errMsg as any).errorMessage = `fallback chain internal error: ${shortMessage(loopErr)}`;
			(errMsg as any).stopReason = "error";
			linkLogs.push({
				provider: "fallback",
				model: args.chainName,
				outcome: "fatal",
				errorClass: "internal",
				errorMessage: shortMessage(loopErr),
			});
			out.push({ type: "error", reason: "error", error: errMsg } as AssistantMessageEvent);
			out.end(errMsg);
			emitLog(args, linkLogs, sessionId, peerId, sliceId);
		}
	})();

	return out;
}

function patchDoneMessage(msg: AssistantMessage, provider: string, modelId: string): AssistantMessage {
	const m = msg as any;
	return {
		...m,
		provider,
		model: modelId,
	} as AssistantMessage;
}

function formatExhaustedMessage(links: LogEntryLink[]): string {
	const parts = links.map((l) => `${l.provider}/${l.model} (${l.errorClass ?? l.outcome})`);
	return parts.join(" → ");
}

function emitLog(
	args: RunChainArgs,
	links: LogEntryLink[],
	sessionId: string | null,
	peerId: string | null,
	sliceId: string | null,
): void {
	try {
		args.log({
			ts: nowIso(),
			chain: args.chainName,
			links,
			sessionId,
			peerId,
			sliceId,
		});
	} catch {
		// swallow — log resilience is enforced at the writer level
	}
}
