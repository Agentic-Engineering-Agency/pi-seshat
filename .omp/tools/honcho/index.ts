/**
 * Honcho memory bridge — Oh My Pi port of pi-seshat's honcho extension.
 *
 * Source of truth: /home/fr/Code/Misc/pi/.pi/extensions/honcho/index.ts
 * SpecSafe slice: SPEC-20260424-001 — pi-honcho-bridge-v1
 *
 * Faithful port of the four tools (honcho_recall, honcho_search,
 * honcho_remember, honcho_conclude) onto the Oh My Pi `CustomToolFactory`
 * surface. Behavioral invariants preserved:
 *   - Allowlist on honcho_conclude: only validator/reviewer/steward Gholas
 *     may write durable conclusions.
 *   - Steward conclusions must be prefixed with "product:" (engineering
 *     dialect separator).
 *   - HONCHO_API_KEY is sanitized out of any error text before display.
 *
 * Identity model. Vanilla Pi exposes no per-tool agent identity field on
 * the execute context, and OMP's `CustomToolContext` likewise does not
 * expose one (see @oh-my-pi/pi-coding-agent/src/extensibility/custom-tools/types.ts).
 * Both versions therefore read identity (workspace, session, peer, key)
 * from process.env at call time, so the orchestrator can swap slices
 * without reloading the agent. We optionally hydrate missing env vars
 * from ~/.omp/agent/honcho.json on first use; the file shape matches the
 * pi-seshat ~/.pi/agent/honcho.json and the two MAY be symlinked together.
 *
 * Cost-counter integration. The original extension bumps a per-slice
 * Honcho-call counter on the SpecSafe state file at
 * `<cwd>/.pi/.honcho-state.json`. Until the SpecSafe-session extension
 * is itself ported under `.omp/`, we keep writing to the same `.pi`
 * path so dual-installs stay accurate; the operation is best-effort and
 * never blocks a tool call.
 */

import { Honcho } from "@honcho-ai/sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AgentToolResult,
	CustomTool,
	CustomToolContext,
	CustomToolFactory,
} from "@oh-my-pi/pi-coding-agent";

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

const REQUIRED_VARS = [
	"HONCHO_API_KEY",
	"HONCHO_WORKSPACE_ID",
	"HONCHO_SESSION_ID",
	"HONCHO_PEER_ID",
] as const;

function checkRequired(env: HonchoToolRuntimeEnv): string | null {
	const missing = REQUIRED_VARS.filter((k) => !env[k]);
	if (missing.length === 0) return null;
	return `Missing required Honcho env vars: ${missing.join(", ")}`;
}

/**
 * Hydrate missing fields on `env` from ~/.omp/agent/honcho.json.
 * The file shape is identical to ~/.pi/agent/honcho.json and the two
 * MAY be symlinked.
 */
function hydrateFromConfigFile(env: HonchoToolRuntimeEnv): HonchoToolRuntimeEnv {
	try {
		const cfgPath = path.join(os.homedir(), ".omp", "agent", "honcho.json");
		if (!fs.existsSync(cfgPath)) return env;
		const raw = fs.readFileSync(cfgPath, "utf-8");
		const cfg = JSON.parse(raw) as Partial<Record<keyof HonchoToolRuntimeEnv, string>>;
		const merged: HonchoToolRuntimeEnv = { ...env };
		for (const k of [
			"HONCHO_API_KEY",
			"HONCHO_WORKSPACE_ID",
			"HONCHO_SESSION_ID",
			"HONCHO_PEER_ID",
			"HONCHO_BASE_URL",
		] as const) {
			if (!merged[k] && cfg[k]) merged[k] = cfg[k];
		}
		return merged;
	} catch {
		// Config-file hydration is best effort; never block on it.
		return env;
	}
}

function statePathFor(cwd: string): string {
	// Mirrors .pi/extensions/specsafe-session/index.ts::statePathFor.
	return path.join(cwd, ".pi", ".honcho-state.json");
}

function bumpHonchoCallCounter(cwd: string): void {
	const sp = statePathFor(cwd);
	try {
		if (!fs.existsSync(sp)) return;
		const raw = fs.readFileSync(sp, "utf-8");
		const state = JSON.parse(raw);
		if (state?.currentSlice?.costCounter) {
			state.currentSlice.costCounter.honchoCalls =
				(state.currentSlice.costCounter.honchoCalls ?? 0) + 1;
			fs.writeFileSync(sp, JSON.stringify(state, null, 2), { mode: 0o600 });
		}
	} catch {
		// Cost counter is advisory. Never block a tool call on counter failures.
	}
}

// ---------------------------------------------------------------------------
// Test seams + tool result shape.
// ---------------------------------------------------------------------------

type BuildOpts = {
	getEnv: () => HonchoToolRuntimeEnv;
	/** Test-only: resolves a stubbed conclusion id without hitting the network. */
	__fakeConcludeResult?: { id: string };
};

// Loose shape used in tests — matches AgentToolResult<unknown> structurally.
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

// ---------------------------------------------------------------------------
// Pure factory used by the test suite. Independent of OMP's pi.typebox so
// tests can construct tools without the OMP runtime present.
// ---------------------------------------------------------------------------

export function buildHonchoTools(opts: BuildOpts) {
	const cwd = process.cwd();

	async function guarded<T>(fn: () => Promise<T>): Promise<T | ToolResult> {
		const env = hydrateFromConfigFile(opts.getEnv());
		const missing = checkRequired(env);
		if (missing) return errText(missing);
		try {
			const result = await fn();
			bumpHonchoCallCounter(cwd);
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
		// Test-callable execute. Signature accepts the OMP positional set
		// (toolCallId, params, onUpdate, ctx, signal) but the test suite calls
		// with the legacy (id, params, signal, onUpdate, ctx) ordering. To stay
		// faithful to the source tests we expose the legacy ordering here and
		// adapt to OMP at register time below.
		async execute(
			_id: string,
			params: { query: string; target?: string; scope?: "session" | "peer" },
			_sig: AbortSignal,
			_upd: unknown,
			_ctx: { cwd: string },
		): Promise<ToolResult> {
			return guarded(async () => {
				const env = hydrateFromConfigFile(opts.getEnv());
				const client = makeClient(env);
				const peer = await client.peer(env.HONCHO_PEER_ID!);
				const scope = params.scope ?? "session";
				const chatOptions: Record<string, unknown> = {};
				if (scope === "session") chatOptions.sessionId = env.HONCHO_SESSION_ID;
				if (params.target) chatOptions.target = params.target;
				const response = await peer.chat(params.query, chatOptions);
				const textOut = typeof response === "string" ? response : JSON.stringify(response);
				return okText(textOut, { response });
			}) as Promise<ToolResult>;
		},
	};

	const honcho_search = {
		label: "Honcho Search",
		description: "Hybrid semantic+text search. Default scope is the current session.",
		async execute(
			_id: string,
			params: { query: string; scope?: "session" | "peer" | "workspace"; limit?: number },
			_sig: AbortSignal,
			_upd: unknown,
			_ctx: { cwd: string },
		): Promise<ToolResult> {
			return guarded(async () => {
				const env = hydrateFromConfigFile(opts.getEnv());
				const client = makeClient(env);
				const scope = params.scope ?? "session";
				let page: unknown;
				if (scope === "session") {
					const session = await client.session(env.HONCHO_SESSION_ID!);
					page = await session.search(params.query);
				} else if (scope === "peer") {
					const peer = await client.peer(env.HONCHO_PEER_ID!);
					page = await peer.search(params.query);
				} else {
					return errText("workspace-scope search is not yet wired; use 'session' or 'peer'");
				}
				const hits: Array<Record<string, unknown>> = [];
				const iterable =
					page && typeof (page as any)[Symbol.asyncIterator] === "function"
						? (page as AsyncIterable<unknown>)
						: null;
				if (iterable) {
					let n = 0;
					const limit = params.limit ?? 10;
					for await (const m of iterable) {
						const mm = m as Record<string, unknown>;
						hits.push({
							content: mm.content,
							peerId: mm.peerId ?? mm.peer_id,
							createdAt: mm.createdAt ?? mm.created_at,
						});
						if (++n >= limit) break;
					}
				} else if (Array.isArray(page)) {
					hits.push(...(page as Array<Record<string, unknown>>).slice(0, params.limit ?? 10));
				}
				const summary = hits.length
					? hits.map((h) => `- ${String(h.content).slice(0, 160)}`).join("\n")
					: "(no matches)";
				return okText(summary, { hits });
			}) as Promise<ToolResult>;
		},
	};

	const honcho_remember = {
		label: "Honcho Remember",
		description: "Record a message in the current session under the current peer identity.",
		async execute(
			_id: string,
			params: { content: string; role?: "assistant" | "user" },
			_sig: AbortSignal,
			_upd: unknown,
			_ctx: { cwd: string },
		): Promise<ToolResult> {
			return guarded(async () => {
				const env = hydrateFromConfigFile(opts.getEnv());
				const client = makeClient(env);
				const peer = await client.peer(env.HONCHO_PEER_ID!);
				const session = await client.session(env.HONCHO_SESSION_ID!);
				// Honcho SDK accepts a heterogeneous message-builder array; cast
				// is local to this call and matches the source extension.
				const messages = await session.addMessages([peer.message(params.content)] as any);
				const messageId =
					Array.isArray(messages) && messages[0] ? (messages[0] as any).id : undefined;
				return okText("remembered", { messageId });
			}) as Promise<ToolResult>;
		},
	};

	const honcho_conclude = {
		label: "Honcho Conclude",
		description:
			"Write a durable conclusion about the current peer. Restricted to validator/reviewer/steward peers.",
		async execute(
			_id: string,
			params: { content: string },
			_sig: AbortSignal,
			_upd: unknown,
			_ctx: { cwd: string },
		): Promise<ToolResult> {
			const env = hydrateFromConfigFile(opts.getEnv());
			const peerId = env.HONCHO_PEER_ID ?? "";
			if (!isConclusionWriter(peerId)) {
				return errText(`peer ${peerId || "<unset>"} is not permitted to write conclusions`);
			}
			if (peerId === "steward" && !params.content.startsWith("product:")) {
				return errText(
					"steward conclusions must be prefixed with 'product:' — this is a dialect separator; engineering conclusions do not use it",
				);
			}
			const missing = checkRequired(env);
			if (missing) return errText(missing);

			if (opts.__fakeConcludeResult) {
				bumpHonchoCallCounter(process.cwd());
				return okText("conclusion recorded (stub)", {
					conclusionId: opts.__fakeConcludeResult.id,
				});
			}

			try {
				const client = makeClient(env);
				const peer = await client.peer(peerId);
				const created = await peer.conclusions.create({
					content: params.content,
					sessionId: env.HONCHO_SESSION_ID,
				});
				const conclusionId = Array.isArray(created) && created[0] ? created[0].id : undefined;
				bumpHonchoCallCounter(process.cwd());
				return okText("conclusion recorded", { conclusionId });
			} catch (err: unknown) {
				const apiKey = env.HONCHO_API_KEY ?? "";
				const raw = err instanceof Error ? err.message : String(err);
				return errText(sanitizeErrorForDisplay(`honcho error: ${raw}`, apiKey));
			}
		},
	};

	return { honcho_recall, honcho_search, honcho_remember, honcho_conclude };
}

// ---------------------------------------------------------------------------
// Sandbox helpers used by the [live] integration tests.
// ---------------------------------------------------------------------------

export async function provisionSandboxSession(opts: {
	workspaceId: string;
	sessionId: string;
}): Promise<string> {
	const client = new Honcho({
		apiKey: process.env.HONCHO_API_KEY!,
		workspaceId: opts.workspaceId,
	});
	const session = await client.session(opts.sessionId);
	return session.id;
}

export async function cleanupSandboxSession(_opts: {
	workspaceId: string;
	sessionId: string;
}): Promise<void> {
	// Honcho sessions are cheap and not easily deleted by the SDK. Leave them
	// in place; sandbox workspace retention is the Honcho account owner's call.
}

export async function listConclusionsForTest(opts: {
	workspaceId: string;
	peerId: string;
}): Promise<string[]> {
	const client = new Honcho({
		apiKey: process.env.HONCHO_API_KEY!,
		workspaceId: opts.workspaceId,
	});
	const peer = await client.peer(opts.peerId);
	const ids: string[] = [];
	const page: any = await peer.conclusions.list({ page: 1, size: 50 });
	if (page && typeof page[Symbol.asyncIterator] === "function") {
		for await (const c of page) ids.push((c as any).id);
	}
	return ids;
}

// ---------------------------------------------------------------------------
// OMP CustomToolFactory entry point.
//
// Returns four tools. Each tool wraps the corresponding entry from
// buildHonchoTools(), translating between OMP's execute signature
// `(toolCallId, params, onUpdate, ctx, signal)` and the legacy positional
// ordering preserved above for test compatibility.
// ---------------------------------------------------------------------------

const factory: CustomToolFactory = (pi) => {
	const { Type } = pi.typebox;
	const { StringEnum } = pi.pi;

	const tools = buildHonchoTools({
		getEnv: () => process.env as HonchoToolRuntimeEnv,
	});

	const RecallParams = Type.Object({
		query: Type.String({ description: "Natural-language question" }),
		target: Type.Optional(
			Type.String({ description: "Other peer to query about (theory-of-mind)" }),
		),
		scope: Type.Optional(StringEnum(["session", "peer"] as const)),
	});
	const SearchParams = Type.Object({
		query: Type.String(),
		scope: Type.Optional(StringEnum(["session", "peer", "workspace"] as const)),
		limit: Type.Optional(Type.Number({ default: 10, minimum: 1, maximum: 50 })),
	});
	const RememberParams = Type.Object({
		content: Type.String(),
		role: Type.Optional(StringEnum(["assistant", "user"] as const)),
	});
	const ConcludeParams = Type.Object({
		content: Type.String(),
	});

	function adapt<TParams extends { execute: Function; label: string; description: string }>(
		name: string,
		schema: any,
		impl: TParams,
	): CustomTool<any, any> {
		return {
			name,
			label: impl.label,
			description: impl.description,
			parameters: schema,
			async execute(
				toolCallId: string,
				params: any,
				_onUpdate: unknown,
				_ctx: CustomToolContext,
				signal?: AbortSignal,
			): Promise<AgentToolResult<any>> {
				const ac = signal ?? new AbortController().signal;
				const result = await impl.execute(toolCallId, params, ac, () => {}, {
					cwd: process.cwd(),
				});
				return result as AgentToolResult<any>;
			},
		};
	}

	return [
		adapt("honcho_recall", RecallParams, tools.honcho_recall),
		adapt("honcho_search", SearchParams, tools.honcho_search),
		adapt("honcho_remember", RememberParams, tools.honcho_remember),
		adapt("honcho_conclude", ConcludeParams, tools.honcho_conclude),
	];
};

export default factory;
