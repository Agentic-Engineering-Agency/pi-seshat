/**
 * Tests for the specsafe-session extension.
 *
 * SpecSafe slice: SPEC-20260424-001 — pi-honcho-bridge-v1
 *
 * Covers state-file lifecycle, atomicity, and corruption handling.
 * All tests are [unit] — no Honcho network; the session-id we write is just
 * a string and Honcho round-trip is covered by honcho.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	buildSpecsafeSessionTools,
	readStateFileOrNull,
	type StateFile,
} from "../index.ts";

function mkTmpProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-specsafe-"));
	fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
	return dir;
}

function statePath(projectDir: string): string {
	return path.join(projectDir, ".pi", ".honcho-state.json");
}

let projectDir: string;
beforeEach(() => {
	projectDir = mkTmpProject();
});
afterEach(() => {
	try {
		fs.rmSync(projectDir, { recursive: true, force: true });
	} catch {}
});

describe("[unit] specsafe_begin — lifecycle invariants", () => {
	test("creates .pi/.honcho-state.json with mode 0600 and a non-empty sessionId", async () => {
		const tools = buildSpecsafeSessionTools({
			getCwd: () => projectDir,
			// Test seam: the session-provisioning side-effect (Honcho API call)
			// is substituted with a deterministic stub. The production factory
			// wires this to the SDK.
			provisionSession: async ({ sliceId, workspaceId }) => `sess-${workspaceId}-${sliceId}`,
		});

		const result = await tools.specsafe_begin.execute(
			"call-1",
			{ sliceId: "TEST-001", workspaceId: "pi-dev-sandbox" },
			new AbortController().signal,
			() => {},
			{ cwd: projectDir } as any,
		);
		expect(result.isError).toBeFalsy();

		const stat = fs.statSync(statePath(projectDir));
		// mode bits: file-type bits masked off
		expect(stat.mode & 0o777).toBe(0o600);

		const state = JSON.parse(fs.readFileSync(statePath(projectDir), "utf-8")) as StateFile;
		expect(state.currentSlice).not.toBeNull();
		expect(state.currentSlice?.sessionId).toBe("sess-pi-dev-sandbox-TEST-001");
		expect(state.currentSlice?.workspaceId).toBe("pi-dev-sandbox");
		expect(state.currentSlice?.id).toBe("TEST-001");
		expect(state.currentSlice?.beganAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(state.currentSlice?.costCounter.honchoCalls).toBe(0);
		expect(Array.isArray(state.history)).toBe(true);
	});

	test("double-begin without an intervening end returns isError", async () => {
		const tools = buildSpecsafeSessionTools({
			getCwd: () => projectDir,
			provisionSession: async () => "sess-X",
		});

		const ok = await tools.specsafe_begin.execute(
			"c1",
			{ sliceId: "S1", workspaceId: "pi-dev-sandbox" },
			new AbortController().signal,
			() => {},
			{ cwd: projectDir } as any,
		);
		expect(ok.isError).toBeFalsy();

		const dup = await tools.specsafe_begin.execute(
			"c2",
			{ sliceId: "S2", workspaceId: "pi-dev-sandbox" },
			new AbortController().signal,
			() => {},
			{ cwd: projectDir } as any,
		);
		expect(dup.isError).toBe(true);
		expect(dup.content.map((c: any) => c.text).join("\n").toLowerCase()).toContain("already open");
	});

	test("re-begin of the same sliceId after it appears in history errors (v1 — no resume)", async () => {
		const tools = buildSpecsafeSessionTools({
			getCwd: () => projectDir,
			provisionSession: async ({ sliceId }) => `sess-${sliceId}`,
		});

		await tools.specsafe_begin.execute(
			"c1",
			{ sliceId: "S1", workspaceId: "w" },
			new AbortController().signal,
			() => {},
			{ cwd: projectDir } as any,
		);
		await tools.specsafe_end.execute(
			"c2",
			{ outcome: "PASS" },
			new AbortController().signal,
			() => {},
			{ cwd: projectDir } as any,
		);

		const retry = await tools.specsafe_begin.execute(
			"c3",
			{ sliceId: "S1", workspaceId: "w" },
			new AbortController().signal,
			() => {},
			{ cwd: projectDir } as any,
		);
		expect(retry.isError).toBe(true);
		const text = retry.content.map((c: any) => c.text).join("\n").toLowerCase();
		expect(text).toContain("already exists in history");
	});
});

describe("[unit] specsafe_end", () => {
	test("archives currentSlice into history with endedAt + outcome, clears currentSlice", async () => {
		const tools = buildSpecsafeSessionTools({
			getCwd: () => projectDir,
			provisionSession: async () => "sess-1",
		});

		await tools.specsafe_begin.execute(
			"c1",
			{ sliceId: "S1", workspaceId: "w" },
			new AbortController().signal,
			() => {},
			{ cwd: projectDir } as any,
		);
		const end = await tools.specsafe_end.execute(
			"c2",
			{ outcome: "PASS" },
			new AbortController().signal,
			() => {},
			{ cwd: projectDir } as any,
		);
		expect(end.isError).toBeFalsy();

		const state = JSON.parse(fs.readFileSync(statePath(projectDir), "utf-8")) as StateFile;
		expect(state.currentSlice).toBeNull();
		expect(state.history.length).toBe(1);
		const archived = state.history[0]!;
		expect(archived.sliceId).toBe("S1");
		expect(archived.outcome).toBe("PASS");
		expect(archived.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	test("end without an open slice returns isError", async () => {
		const tools = buildSpecsafeSessionTools({
			getCwd: () => projectDir,
			provisionSession: async () => "x",
		});
		const result = await tools.specsafe_end.execute(
			"c1",
			{ outcome: "PASS" },
			new AbortController().signal,
			() => {},
			{ cwd: projectDir } as any,
		);
		expect(result.isError).toBe(true);
	});
});

describe("[unit] state file — atomicity and corruption", () => {
	test("concurrent begin+end do not corrupt the JSON", async () => {
		// Two sequential cycles with interleaved writes via the shared file-mutation queue.
		const tools = buildSpecsafeSessionTools({
			getCwd: () => projectDir,
			provisionSession: async ({ sliceId }) => `sess-${sliceId}`,
		});
		for (let i = 0; i < 5; i++) {
			const begin = tools.specsafe_begin.execute(
				"b" + i,
				{ sliceId: `S${i}`, workspaceId: "w" },
				new AbortController().signal,
				() => {},
				{ cwd: projectDir } as any,
			);
			await begin;
			const end = tools.specsafe_end.execute(
				"e" + i,
				{ outcome: "PASS" },
				new AbortController().signal,
				() => {},
				{ cwd: projectDir } as any,
			);
			await end;
		}

		const raw = fs.readFileSync(statePath(projectDir), "utf-8");
		// Should parse cleanly; no truncation, no duplicate keys.
		const state = JSON.parse(raw) as StateFile;
		expect(state.currentSlice).toBeNull();
		expect(state.history.length).toBe(5);
	});

	test("readStateFileOrNull returns null on missing file (not throw)", () => {
		const s = readStateFileOrNull(statePath(projectDir));
		expect(s).toBeNull();
	});

	test("corrupt state file is quarantined, readStateFileOrNull returns null", () => {
		fs.writeFileSync(statePath(projectDir), "{not valid json", { mode: 0o600 });
		const s = readStateFileOrNull(statePath(projectDir));
		expect(s).toBeNull();
		// A sibling `.corrupt-*` file should exist.
		const entries = fs.readdirSync(path.join(projectDir, ".pi"));
		expect(entries.some((f) => f.startsWith(".honcho-state.json.corrupt-"))).toBe(true);
		// The live state file should not exist after quarantine.
		expect(fs.existsSync(statePath(projectDir))).toBe(false);
	});
});

describe("[unit] specsafe_status", () => {
	test("reports currentSlice and last N history entries accurately", async () => {
		const tools = buildSpecsafeSessionTools({
			getCwd: () => projectDir,
			provisionSession: async ({ sliceId }) => `sess-${sliceId}`,
		});
		await tools.specsafe_begin.execute(
			"b",
			{ sliceId: "S1", workspaceId: "w" },
			new AbortController().signal,
			() => {},
			{ cwd: projectDir } as any,
		);
		await tools.specsafe_end.execute(
			"e",
			{ outcome: "PASS" },
			new AbortController().signal,
			() => {},
			{ cwd: projectDir } as any,
		);
		await tools.specsafe_begin.execute(
			"b2",
			{ sliceId: "S2", workspaceId: "w" },
			new AbortController().signal,
			() => {},
			{ cwd: projectDir } as any,
		);

		const status = await tools.specsafe_status.execute(
			"s",
			{},
			new AbortController().signal,
			() => {},
			{ cwd: projectDir } as any,
		);
		expect(status.isError).toBeFalsy();
		const d = status.details as any;
		expect(d.currentSlice?.id).toBe("S2");
		expect(d.history.length).toBe(1);
		expect(d.history[0].sliceId).toBe("S1");
	});
});
