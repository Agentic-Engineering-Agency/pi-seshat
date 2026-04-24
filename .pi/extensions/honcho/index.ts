/**
 * Honcho memory bridge extension for Pi.
 *
 * SpecSafe slice: SPEC-20260424-001 — pi-honcho-bridge-v1
 *
 * Registers four tools (honcho_recall, honcho_search, honcho_remember,
 * honcho_conclude). Identity (API key, workspace, session, peer) is read
 * from the environment at tool-call time so that the orchestrator can
 * switch slices without reloading Pi.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Honcho } from "@honcho-ai/sdk";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Policy surface — exported for the unit tests.
// ---------------------------------------------------------------------------

export const CONCLUSION_WRITERS: ReadonlySet<string> = new Set([
	"validator",
	"reviewer",
	"steward",
]);

export function isConclusionWriter(peer: string): boolean {
	return CONCLUSION_WRITERS.has(peer);
}

export function sanitizeErrorForDisplay(text: string, apiKey: string): string {
	if (!apiKey) return text;
	if (!text.includes(apiKey)) return text;
	return text.split(apiKey).join("<redacted>");
}

// ---------------------------------------------------------------------------
// Env + cost-counter plumbing.
// ---------------------------------------------------------------------------

export type HonchoToolRuntimeEnv = {
	HONCHO_API_KEY?: string;
	HONCHO_WORKSPACE_ID?: string;
	HONCHO_SESSION_ID?: string;
	HONCHO_PEER_ID?: string;
	HONCHO_BASE_URL?: string;
};

const REQUIRED_VARS = ["HONCHO_API_KEY", "HONCHO_WORKSPACE_ID", "HONCHO_SESSION_ID", "HONCHO_PEER_ID"] as const;

function checkRequired(env: HonchoToolRuntimeEnv): string | null {
	const missing = REQUIRED_VARS.filter((k) => !env[k]);
	if (missing.length === 0) return null;
	return `Missing required Honcho env vars: ${missing.join(", ")}`;
}

function statePathFor(cwd: string): string {
	return path.join(cwd, ".pi", ".honcho-state.json");
}

function bumpHonchoCallCounter(cwd: string): void {
	const sp = statePathFor(cwd);
	try {
		if (!fs.existsSync(sp)) return;
		const raw = fs.readFileSync(sp, "utf-8");
		const state = JSON.parse(raw);
		if (state?.currentSlice?.costCounter) {
			state.currentSlice.costCounter.honchoCalls = (state.currentSlice.costCounter.honchoCalls ?? 0) + 1;
			fs.writeFileSync(sp, JSON.stringify(state, null, 2), { mode: 0o600 });
		}
	} catch {
		// Cost counter is advisory. Never block a tool call on counter failures.
	}
}

// ---------------------------------------------------------------------------
// Test seams and public factory.
// ---------------------------------------------------------------------------

type BuildOpts = {
	getEnv: () => HonchoToolRuntimeEnv;
	/** Test-only: resolves a stubbed conclusion id without hitting the network. */
	__fakeConcludeResult?: { id: string };
	/** Test-only: invoked if any network-adjacent code would run under a rejected gate. */
	__networkProbe?: () => void;
};

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
};

function errText(text: string, details?: Record<string, unknown>): ToolResult {
	return { content: [{ type: "text", text }], details: details ?? {}, isError: true };
}

function okText(text: string, details?: Record<string, unknown>): ToolResult {
	return { content: [{ type: "text", text }], details: details ?? {} };
}

function makeClient(env: HonchoToolRuntimeEnv): Honcho {
	return new Honcho({
		apiKey: env.HONCHO_API_KEY!,
		workspaceId: env.HONCHO_WORKSPACE_ID!,
		...(env.HONCHO_BASE_URL ? { baseURL: env.HONCHO_BASE_URL } : {}),
	});
}

export function buildHonchoTools(opts: BuildOpts) {
	async function guarded<T>(ctx: { cwd: string }, fn: () => Promise<T>): Promise<T | ToolResult> {
		const env = opts.getEnv();
		const missing = checkRequired(env);
		if (missing) return errText(missing);
		try {
			const result = await fn();
			bumpHonchoCallCounter(ctx.cwd);
			return result;
		} catch (err: unknown) {
			const apiKey = env.HONCHO_API_KEY ?? "";
			const raw = err instanceof Error ? err.message : String(err);
			return errText(sanitizeErrorForDisplay(`honcho error: ${raw}`, apiKey));
		}
	}

	const honcho_recall = {
		label: "Honcho Recall",
		description:
			"Ask Honcho a natural-language question about what's known in the current session (default) or about another peer. Uses dialectic chat.",
		parameters: Type.Object({
			query: Type.String({ description: "Natural-language question" }),
			target: Type.Optional(Type.String({ description: "Other peer to query about (theory-of-mind)" })),
			scope: Type.Optional(
				Type.Union([Type.Literal("session"), Type.Literal("peer")], { default: "session" }),
			),
		}),
		async execute(_id: string, params: any, _sig: AbortSignal, _upd: unknown, ctx: { cwd: string }) {
			return guarded(ctx, async () => {
				const env = opts.getEnv();
				const client = makeClient(env);
				const peer = await client.peer(env.HONCHO_PEER_ID!);
				const scope = params.scope ?? "session";
				const chatOptions: Record<string, unknown> = {};
				if (scope === "session") chatOptions.sessionId = env.HONCHO_SESSION_ID;
				if (params.target) chatOptions.target = params.target;
				const response = await peer.chat(params.query, chatOptions);
				const textOut = typeof response === "string" ? response : JSON.stringify(response);
				return okText(textOut, { response });
			});
		},
	};

	const honcho_search = {
		label: "Honcho Search",
		description: "Hybrid semantic+text search. Default scope is the current session.",
		parameters: Type.Object({
			query: Type.String(),
			scope: Type.Optional(
				Type.Union([Type.Literal("session"), Type.Literal("peer"), Type.Literal("workspace")], {
					default: "session",
				}),
			),
			limit: Type.Optional(Type.Number({ default: 10, minimum: 1, maximum: 50 })),
		}),
		async execute(_id: string, params: any, _sig: AbortSignal, _upd: unknown, ctx: { cwd: string }) {
			return guarded(ctx, async () => {
				const env = opts.getEnv();
				const client = makeClient(env);
				const scope = params.scope ?? "session";
				let page: any;
				if (scope === "session") {
					const session = await client.session(env.HONCHO_SESSION_ID!);
					page = await session.search(params.query);
				} else {
					const peer = await client.peer(env.HONCHO_PEER_ID!);
					page = await peer.search(params.query);
				}
				// Pi SDK returns a Page; drain it so the tool result is simple.
				const hits: Array<Record<string, unknown>> = [];
				const iter = page && typeof page[Symbol.asyncIterator] === "function" ? page : null;
				if (iter) {
					let n = 0;
					const limit = params.limit ?? 10;
					for await (const m of iter) {
						hits.push({
							content: (m as any).content,
							peerId: (m as any).peerId ?? (m as any).peer_id,
							createdAt: (m as any).createdAt ?? (m as any).created_at,
						});
						if (++n >= limit) break;
					}
				} else if (Array.isArray(page)) {
					hits.push(...page.slice(0, params.limit ?? 10));
				}
				const summary = hits.length ? hits.map((h) => `- ${String(h.content).slice(0, 160)}`).join("\n") : "(no matches)";
				return okText(summary, { hits });
			});
		},
	};

	const honcho_remember = {
		label: "Honcho Remember",
		description: "Record a message in the current session under the current peer identity.",
		parameters: Type.Object({
			content: Type.String(),
			role: Type.Optional(Type.Union([Type.Literal("assistant"), Type.Literal("user")], { default: "assistant" })),
		}),
		async execute(_id: string, params: any, _sig: AbortSignal, _upd: unknown, ctx: { cwd: string }) {
			return guarded(ctx, async () => {
				const env = opts.getEnv();
				const client = makeClient(env);
				const peer = await client.peer(env.HONCHO_PEER_ID!);
				const session = await client.session(env.HONCHO_SESSION_ID!);
				const messages = await session.addMessages([peer.message(params.content)] as any);
				const messageId = Array.isArray(messages) && messages[0] ? (messages[0] as any).id : undefined;
				return okText("remembered", { messageId });
			});
		},
	};

	const honcho_conclude = {
		label: "Honcho Conclude",
		description:
			"Write a durable conclusion about the current peer. Restricted to validator/reviewer/steward peers.",
		parameters: Type.Object({
			content: Type.String(),
		}),
		async execute(_id: string, params: any, _sig: AbortSignal, _upd: unknown, ctx: { cwd: string }) {
			const env = opts.getEnv();
			const peerId = env.HONCHO_PEER_ID ?? "";
			if (!isConclusionWriter(peerId)) {
				return errText(`peer ${peerId || "<unset>"} is not permitted to write conclusions`);
			}
			const missing = checkRequired(env);
			if (missing) return errText(missing);

			// Test seam — short-circuits the network call entirely.
			if (opts.__fakeConcludeResult) {
				bumpHonchoCallCounter(ctx.cwd);
				return okText("conclusion recorded (stub)", { conclusionId: opts.__fakeConcludeResult.id });
			}

			try {
				const client = makeClient(env);
				const peer = await client.peer(peerId);
				const created = await peer.conclusions.create({
					content: params.content,
					sessionId: env.HONCHO_SESSION_ID,
				});
				const conclusionId = Array.isArray(created) && created[0] ? created[0].id : undefined;
				bumpHonchoCallCounter(ctx.cwd);
				return okText("conclusion recorded", { conclusionId });
			} catch (err: unknown) {
				const apiKey = env.HONCHO_API_KEY ?? "";
				const raw = err instanceof Error ? err.message : String(err);
				return errText(sanitizeErrorForDisplay(`honcho error: ${raw}`, apiKey));
			}
		},
	};

	// __networkProbe is reserved for future tests where we need to assert the
	// gate short-circuited before any network surface was reached. Currently
	// the isConclusionWriter check precedes client construction, so the probe
	// is unused in happy-path code but kept as an opt-in hook.
	void opts.__networkProbe;

	return { honcho_recall, honcho_search, honcho_remember, honcho_conclude };
}

// ---------------------------------------------------------------------------
// Sandbox helpers used by the [live] integration tests.
// ---------------------------------------------------------------------------

export async function provisionSandboxSession(opts: { workspaceId: string; sessionId: string }): Promise<string> {
	const client = new Honcho({ apiKey: process.env.HONCHO_API_KEY!, workspaceId: opts.workspaceId });
	const session = await client.session(opts.sessionId);
	return session.id;
}

export async function cleanupSandboxSession(_opts: { workspaceId: string; sessionId: string }): Promise<void> {
	// Honcho sessions are cheap and not easily deleted by the SDK. Leave them
	// in place; sandbox workspace retention is the Honcho account owner's call.
}

export async function listConclusionsForTest(opts: { workspaceId: string; peerId: string }): Promise<string[]> {
	const client = new Honcho({ apiKey: process.env.HONCHO_API_KEY!, workspaceId: opts.workspaceId });
	const peer = await client.peer(opts.peerId);
	const ids: string[] = [];
	const page: any = await peer.conclusions.list({ page: 1, size: 50 });
	if (page && typeof page[Symbol.asyncIterator] === "function") {
		for await (const c of page) ids.push((c as any).id);
	}
	return ids;
}

// ---------------------------------------------------------------------------
// Pi extension entry point.
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const tools = buildHonchoTools({ getEnv: () => process.env as HonchoToolRuntimeEnv });
	for (const [name, tool] of Object.entries(tools)) {
		// Pi's ToolDefinition infers a single Params schema per registration, but
		// our tools have heterogeneous param shapes; cast to any to register them
		// iteratively. Each individual registration is schema-valid on its own.
		pi.registerTool({ name, ...tool } as any);
	}
}
