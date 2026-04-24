/**
 * Tests for the honcho extension.
 *
 * SpecSafe slice: SPEC-20260424-001 — pi-honcho-bridge-v1
 *
 * Test types:
 *   [unit] — no network; test pure helpers and validation logic.
 *   [live] — hits the real Honcho sandbox workspace (pi-dev-sandbox).
 *            Runs only when HONCHO_TESTS_LIVE=1 is set AND HONCHO_API_KEY is present.
 *            Matches Luci's "don't mock the database" discipline.
 *
 * These tests MUST fail against the unimplemented extension — that is SpecSafe's
 * red phase. The implementer's job is to make them green without weakening any assertion.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const LIVE = process.env.HONCHO_TESTS_LIVE === "1" && !!process.env.HONCHO_API_KEY;

// Deterministic-ish test session prefix so parallel runs don't collide.
const TEST_RUN_ID = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_WORKSPACE = "pi-dev-sandbox";

// These imports reference the extension under test. They MUST resolve once
// the implementer creates the module. Until then the suite fails to import,
// which is a correct red-phase signal.
import {
	buildHonchoTools,
	type HonchoToolRuntimeEnv,
	isConclusionWriter,
	sanitizeErrorForDisplay,
} from "../index.ts";

// ---------- [unit] helper-level tests ----------

describe("[unit] isConclusionWriter", () => {
	test("permits validator, reviewer, steward", () => {
		expect(isConclusionWriter("validator")).toBe(true);
		expect(isConclusionWriter("reviewer")).toBe(true);
		expect(isConclusionWriter("steward")).toBe(true);
	});

	test("denies other peers including the orchestrator itself", () => {
		for (const peer of ["luci", "seshat", "spec-writer", "test-writer", "implementer", "doc-scout", "unknown"]) {
			expect(isConclusionWriter(peer)).toBe(false);
		}
	});

	test("denies empty and malformed peer ids", () => {
		expect(isConclusionWriter("")).toBe(false);
		expect(isConclusionWriter("VALIDATOR")).toBe(false);
		expect(isConclusionWriter(" validator ")).toBe(false);
	});
});

describe("[unit] sanitizeErrorForDisplay", () => {
	test("strips HONCHO_API_KEY when embedded in error message", () => {
		const apiKey = "hch-v3-deadbeef1234567890feedface";
		const raw = `Error calling Honcho: unauthorized (apiKey=${apiKey}) at line 42`;
		const clean = sanitizeErrorForDisplay(raw, apiKey);
		expect(clean).not.toContain(apiKey);
		expect(clean).toContain("<redacted>");
	});

	test("is a no-op when no apiKey is provided or key absent from text", () => {
		expect(sanitizeErrorForDisplay("plain error", "")).toBe("plain error");
		expect(sanitizeErrorForDisplay("plain error", "hch-v3-abc")).toBe("plain error");
	});
});

describe("[unit] buildHonchoTools — missing env", () => {
	const emptyEnv: HonchoToolRuntimeEnv = {
		HONCHO_API_KEY: undefined,
		HONCHO_WORKSPACE_ID: undefined,
		HONCHO_SESSION_ID: undefined,
		HONCHO_PEER_ID: undefined,
	};

	test("honcho_recall returns isError with the missing var name when API key absent", async () => {
		const tools = buildHonchoTools({ getEnv: () => emptyEnv });
		const result = await tools.honcho_recall.execute(
			"call-1",
			{ query: "x" },
			new AbortController().signal,
			() => {},
			{ cwd: process.cwd() } as any,
		);
		expect(result.isError).toBe(true);
		const text = result.content.map((c: any) => c.text).join("\n");
		expect(text).toContain("HONCHO_API_KEY");
	});

	test("honcho_remember returns isError listing every missing required var", async () => {
		const tools = buildHonchoTools({ getEnv: () => emptyEnv });
		const result = await tools.honcho_remember.execute(
			"call-2",
			{ content: "x" },
			new AbortController().signal,
			() => {},
			{ cwd: process.cwd() } as any,
		);
		expect(result.isError).toBe(true);
		const text = result.content.map((c: any) => c.text).join("\n");
		for (const v of ["HONCHO_API_KEY", "HONCHO_WORKSPACE_ID", "HONCHO_SESSION_ID", "HONCHO_PEER_ID"]) {
			expect(text).toContain(v);
		}
	});
});

describe("[unit] honcho_conclude peer-allowlist gate", () => {
	const envFor = (peer: string): HonchoToolRuntimeEnv => ({
		HONCHO_API_KEY: "dummy",
		HONCHO_WORKSPACE_ID: "w",
		HONCHO_SESSION_ID: "s",
		HONCHO_PEER_ID: peer,
	});

	test("returns isError for a non-writer peer without calling Honcho", async () => {
		let networkCalled = false;
		const tools = buildHonchoTools({
			getEnv: () => envFor("implementer"),
			__networkProbe: () => {
				networkCalled = true;
			},
		});
		const result = await tools.honcho_conclude.execute(
			"call-3",
			{ content: "should not land" },
			new AbortController().signal,
			() => {},
			{ cwd: process.cwd() } as any,
		);
		expect(result.isError).toBe(true);
		const text = result.content.map((c: any) => c.text).join("\n");
		expect(text).toContain("implementer");
		expect(text.toLowerCase()).toContain("not permitted");
		expect(networkCalled).toBe(false);
	});

	test("does NOT return isError for validator (pre-network gate passes)", async () => {
		// This test asserts only the gate behavior; actual network success
		// is covered by the [live] integration test below.
		const tools = buildHonchoTools({
			getEnv: () => envFor("validator"),
			__fakeConcludeResult: { id: "fake-conclusion-id" },
		});
		const result = await tools.honcho_conclude.execute(
			"call-4",
			{ content: "fixture" },
			new AbortController().signal,
			() => {},
			{ cwd: process.cwd() } as any,
		);
		expect(result.isError).toBeFalsy();
	});
});

// ---------- [live] integration tests against pi-dev-sandbox ----------

describe.skipIf(!LIVE)("[live] honcho integration against pi-dev-sandbox", () => {
	let liveSessionId: string;

	beforeAll(async () => {
		// The live suite assumes the implementer exposes a helper to provision
		// a disposable session under the sandbox workspace. We expect this to
		// exist in the final module.
		const { provisionSandboxSession } = await import("../index.ts");
		liveSessionId = await provisionSandboxSession({
			workspaceId: TEST_WORKSPACE,
			sessionId: `${TEST_RUN_ID}-roundtrip`,
		});
	});

	afterAll(async () => {
		const { cleanupSandboxSession } = await import("../index.ts");
		await cleanupSandboxSession({ workspaceId: TEST_WORKSPACE, sessionId: liveSessionId });
	});

	test("round-trip: remember a message, search retrieves it", async () => {
		const tools = buildHonchoTools({
			getEnv: () => ({
				HONCHO_API_KEY: process.env.HONCHO_API_KEY,
				HONCHO_WORKSPACE_ID: TEST_WORKSPACE,
				HONCHO_SESSION_ID: liveSessionId,
				HONCHO_PEER_ID: "luci",
			}),
		});

		const needle = `roundtrip-${TEST_RUN_ID}`;
		const write = await tools.honcho_remember.execute(
			"live-1",
			{ content: `needle ${needle} payload` },
			new AbortController().signal,
			() => {},
			{ cwd: process.cwd() } as any,
		);
		expect(write.isError).toBeFalsy();

		// Honcho indexing latency — spec budget: 10 seconds.
		const deadline = Date.now() + 10_000;
		let foundNeedle = false;
		while (Date.now() < deadline) {
			const search = await tools.honcho_search.execute(
				"live-2",
				{ query: needle, scope: "session" },
				new AbortController().signal,
				() => {},
				{ cwd: process.cwd() } as any,
			);
			const text = search.content.map((c: any) => c.text).join("\n");
			if (text.includes(needle)) {
				foundNeedle = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 500));
		}
		expect(foundNeedle).toBe(true);
	});

	test("peer isolation: a message from peer A is attributed to peer A in search results", async () => {
		const needle = `peer-iso-${TEST_RUN_ID}`;
		const tools = buildHonchoTools({
			getEnv: () => ({
				HONCHO_API_KEY: process.env.HONCHO_API_KEY,
				HONCHO_WORKSPACE_ID: TEST_WORKSPACE,
				HONCHO_SESSION_ID: liveSessionId,
				HONCHO_PEER_ID: "spec-writer",
			}),
		});
		const write = await tools.honcho_remember.execute(
			"live-3",
			{ content: `isolation needle ${needle}` },
			new AbortController().signal,
			() => {},
			{ cwd: process.cwd() } as any,
		);
		expect(write.isError).toBeFalsy();

		// Indexing grace
		await new Promise((r) => setTimeout(r, 2_000));
		const search = await tools.honcho_search.execute(
			"live-4",
			{ query: needle, scope: "session" },
			new AbortController().signal,
			() => {},
			{ cwd: process.cwd() } as any,
		);
		const details = search.details as any;
		const attributed = (details?.hits ?? []).some((h: any) => h.peerId === "spec-writer" && String(h.content).includes(needle));
		expect(attributed).toBe(true);
	});

	test("honcho_conclude from validator creates a listable conclusion", async () => {
		const tools = buildHonchoTools({
			getEnv: () => ({
				HONCHO_API_KEY: process.env.HONCHO_API_KEY,
				HONCHO_WORKSPACE_ID: TEST_WORKSPACE,
				HONCHO_SESSION_ID: liveSessionId,
				HONCHO_PEER_ID: "validator",
			}),
		});

		const uniq = `validator-conclusion-${TEST_RUN_ID}`;
		const result = await tools.honcho_conclude.execute(
			"live-5",
			{ content: `engineering truth: ${uniq}` },
			new AbortController().signal,
			() => {},
			{ cwd: process.cwd() } as any,
		);
		expect(result.isError).toBeFalsy();
		const conclusionId = (result.details as any)?.conclusionId;
		expect(typeof conclusionId).toBe("string");
		expect(conclusionId.length).toBeGreaterThan(0);

		// Verify via the SDK's list-conclusions path (tool-level list not exposed).
		const { listConclusionsForTest } = await import("../index.ts");
		const ids = await listConclusionsForTest({ workspaceId: TEST_WORKSPACE, peerId: "validator" });
		expect(ids).toContain(conclusionId);
	});

	test("honcho_conclude from implementer does NOT create a conclusion on Honcho", async () => {
		const tools = buildHonchoTools({
			getEnv: () => ({
				HONCHO_API_KEY: process.env.HONCHO_API_KEY,
				HONCHO_WORKSPACE_ID: TEST_WORKSPACE,
				HONCHO_SESSION_ID: liveSessionId,
				HONCHO_PEER_ID: "implementer",
			}),
		});
		const { listConclusionsForTest } = await import("../index.ts");
		const before = await listConclusionsForTest({ workspaceId: TEST_WORKSPACE, peerId: "implementer" });
		const result = await tools.honcho_conclude.execute(
			"live-6",
			{ content: "should be rejected" },
			new AbortController().signal,
			() => {},
			{ cwd: process.cwd() } as any,
		);
		expect(result.isError).toBe(true);
		const after = await listConclusionsForTest({ workspaceId: TEST_WORKSPACE, peerId: "implementer" });
		expect(after.length).toBe(before.length);
	});

	test("api key is never echoed in any tool result (content or details)", async () => {
		const apiKey = process.env.HONCHO_API_KEY ?? "";
		expect(apiKey.length).toBeGreaterThan(0);

		const tools = buildHonchoTools({
			getEnv: () => ({
				HONCHO_API_KEY: apiKey,
				HONCHO_WORKSPACE_ID: TEST_WORKSPACE,
				HONCHO_SESSION_ID: liveSessionId,
				HONCHO_PEER_ID: "luci",
			}),
		});

		for (const [name, input] of [
			["honcho_remember", { content: "probe" }],
			["honcho_search", { query: "probe" }],
			["honcho_recall", { query: "probe" }],
		] as const) {
			const tool = (tools as any)[name];
			const res = await tool.execute("key-leak-" + name, input, new AbortController().signal, () => {}, {
				cwd: process.cwd(),
			} as any);
			const blob = JSON.stringify(res);
			expect(blob).not.toContain(apiKey);
		}
	});
});
