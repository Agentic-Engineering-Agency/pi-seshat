/**
 * SpecSafe session lifecycle extension for Pi.
 *
 * SpecSafe slice: SPEC-20260424-001 — pi-honcho-bridge-v1
 *
 * Owns .pi/.honcho-state.json (0600, serialized writes). Provides:
 *   specsafe_begin(sliceId, workspaceId) — create Honcho session, persist state
 *   specsafe_end(outcome)                — archive current slice
 *   specsafe_status()                    — current + history snapshot
 *
 * Invariant: at most one currentSlice open at a time. Re-opening a sliceId
 * that already appears in history is a v1 error (no --resume yet).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Honcho } from "@honcho-ai/sdk";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// State file shape + helpers.
// ---------------------------------------------------------------------------

export type CostCounter = {
	honchoCalls: number;
	honchoCost: number;
	subagentTokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		turns: number;
	};
};

export type CurrentSlice = {
	id: string;
	workspaceId: string;
	sessionId: string;
	beganAt: string;
	costCounter: CostCounter;
};

export type HistoryEntry = {
	sliceId: string;
	workspaceId: string;
	sessionId: string;
	beganAt: string;
	endedAt: string;
	outcome: "PASS" | "FAIL" | "ABANDONED";
	costSummary: CostCounter;
};

export type StateFile = {
	currentSlice: CurrentSlice | null;
	history: HistoryEntry[];
};

function freshCostCounter(): CostCounter {
	return {
		honchoCalls: 0,
		honchoCost: 0,
		subagentTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};
}

function emptyState(): StateFile {
	return { currentSlice: null, history: [] };
}

export function statePathFor(cwd: string): string {
	return path.join(cwd, ".pi", ".honcho-state.json");
}

export function readStateFileOrNull(filePath: string): StateFile | null {
	if (!fs.existsSync(filePath)) return null;
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as StateFile;
		if (!("currentSlice" in parsed) || !Array.isArray((parsed as any).history)) {
			throw new Error("missing required fields");
		}
		return parsed;
	} catch {
		try {
			const quarantine = `${filePath}.corrupt-${Date.now()}`;
			fs.renameSync(filePath, quarantine);
		} catch {
			// Quarantine is best-effort; corrupt file may already be gone.
		}
		return null;
	}
}

function writeStateFile(filePath: string, state: StateFile): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
	fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Factory for testability.
// ---------------------------------------------------------------------------

type BuildOpts = {
	getCwd: () => string;
	/** Inject a stubbed session-creator for unit tests; production wires the Honcho SDK. */
	provisionSession: (opts: { sliceId: string; workspaceId: string }) => Promise<string>;
};

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
};

function errText(text: string): ToolResult {
	return { content: [{ type: "text", text }], details: {}, isError: true };
}
function okText(text: string, details?: Record<string, unknown>): ToolResult {
	return { content: [{ type: "text", text }], details: details ?? {} };
}

export function buildSpecsafeSessionTools(opts: BuildOpts) {
	// Serialize writes through an in-process promise chain so begin/end calls
	// can't interleave their read-modify-write cycles.
	let chain: Promise<void> = Promise.resolve();
	function serialize<T>(fn: () => Promise<T>): Promise<T> {
		const runnable = () => fn();
		const next = chain.then(runnable, runnable);
		chain = next.then(
			() => {},
			() => {},
		);
		return next;
	}

	const specsafe_begin = {
		label: "SpecSafe Begin",
		description: "Open a new SpecSafe slice. Creates a Honcho session and writes .pi/.honcho-state.json.",
		parameters: Type.Object({
			sliceId: Type.String({ description: "Slice identifier (e.g. CUR-92__login-fix or SPEC-001)" }),
			workspaceId: Type.String({ description: "Honcho workspace ID" }),
		}),
		async execute(_id: string, params: any, _sig: AbortSignal, _upd: unknown, _ctx: unknown) {
			return serialize(async (): Promise<ToolResult> => {
				const cwd = opts.getCwd();
				const sp = statePathFor(cwd);
				const state = readStateFileOrNull(sp) ?? emptyState();
				if (state.currentSlice) {
					return errText(`slice already open: ${state.currentSlice.id}`);
				}
				if (state.history.some((h) => h.sliceId === params.sliceId)) {
					return errText(`slice already exists in history: ${params.sliceId}`);
				}
				const sessionId = await opts.provisionSession({
					sliceId: params.sliceId,
					workspaceId: params.workspaceId,
				});
				state.currentSlice = {
					id: params.sliceId,
					workspaceId: params.workspaceId,
					sessionId,
					beganAt: new Date().toISOString(),
					costCounter: freshCostCounter(),
				};
				writeStateFile(sp, state);
				return okText(`slice ${params.sliceId} begun; session=${sessionId}`, {
					sessionId,
					slice: state.currentSlice,
				});
			});
		},
	};

	const specsafe_end = {
		label: "SpecSafe End",
		description: "Close the current SpecSafe slice and archive it into history.",
		parameters: Type.Object({
			outcome: Type.Union([Type.Literal("PASS"), Type.Literal("FAIL"), Type.Literal("ABANDONED")]),
		}),
		async execute(_id: string, params: any, _sig: AbortSignal, _upd: unknown, _ctx: unknown) {
			return serialize(async (): Promise<ToolResult> => {
				const cwd = opts.getCwd();
				const sp = statePathFor(cwd);
				const state = readStateFileOrNull(sp) ?? emptyState();
				if (!state.currentSlice) {
					return errText("no slice is currently open");
				}
				const s = state.currentSlice;
				const archived: HistoryEntry = {
					sliceId: s.id,
					workspaceId: s.workspaceId,
					sessionId: s.sessionId,
					beganAt: s.beganAt,
					endedAt: new Date().toISOString(),
					outcome: params.outcome,
					costSummary: s.costCounter,
				};
				state.history.push(archived);
				state.currentSlice = null;
				writeStateFile(sp, state);
				return okText(`slice ${s.id} ended (${params.outcome})`, { archived });
			});
		},
	};

	const specsafe_status = {
		label: "SpecSafe Status",
		description: "Report the current slice and recent history.",
		parameters: Type.Object({}),
		async execute(_id: string, _params: any, _sig: AbortSignal, _upd: unknown, _ctx: unknown) {
			const cwd = opts.getCwd();
			const sp = statePathFor(cwd);
			const state = readStateFileOrNull(sp) ?? emptyState();
			const lines: string[] = [];
			if (state.currentSlice) {
				const c = state.currentSlice;
				lines.push(`OPEN: ${c.id} (workspace=${c.workspaceId}, session=${c.sessionId})`);
				lines.push(
					`cost: ${c.costCounter.honchoCalls} honcho calls, ${c.costCounter.subagentTokens.turns} subagent turns`,
				);
			} else {
				lines.push("no slice currently open");
			}
			lines.push(`history: ${state.history.length} slice(s)`);
			for (const h of state.history.slice(-5)) {
				lines.push(`  - ${h.sliceId} ${h.outcome} (${h.beganAt} → ${h.endedAt})`);
			}
			return okText(lines.join("\n"), { currentSlice: state.currentSlice, history: state.history });
		},
	};

	return { specsafe_begin, specsafe_end, specsafe_status };
}

// ---------------------------------------------------------------------------
// Pi extension entry point.
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const tools = buildSpecsafeSessionTools({
		getCwd: () => process.cwd(),
		provisionSession: async ({ sliceId, workspaceId }) => {
			const client = new Honcho({ apiKey: process.env.HONCHO_API_KEY!, workspaceId });
			const session = await client.session(sliceId);
			return session.id;
		},
	});
	for (const [name, tool] of Object.entries(tools)) {
		// See honcho/index.ts for the matching note on this cast.
		pi.registerTool({ name, ...tool } as any);
	}
}
