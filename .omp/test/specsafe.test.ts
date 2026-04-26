/**
 * Tests for the SpecSafe Oh My Pi hook port.
 *
 * Source of truth for the cases:
 *   .pi/extensions/specsafe-subagents/test/subagents-patch.test.ts
 *   .pi/extensions/specsafe-session/test/specsafe-session.test.ts
 *
 * The `buildChildEnv` cases from the vanilla suite are intentionally
 * absent — env injection is not ported. See ../hooks/PORT-NOTES.md.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { commitSubagentWork } from "../hooks/specsafe-subagents";
import {
	buildTrailerBlock,
	readStateFileOrNull,
	statePathFor,
	type StateFile,
} from "../hooks/specsafe-session";

// ---------------------------------------------------------------------------
// helpers (mirror .pi test helpers)
// ---------------------------------------------------------------------------

function mkTmpRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-specsafe-"));
	spawnSync("git", ["init", "-b", "main"], { cwd: dir });
	spawnSync("git", ["config", "user.email", "test@seshat.local"], { cwd: dir });
	spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
	spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "README.md"), "initial\n");
	spawnSync("git", ["add", "."], { cwd: dir });
	spawnSync("git", ["commit", "-m", "initial"], { cwd: dir });
	return dir;
}

function lastCommit(cwd: string): { subject: string; body: string } {
	const subj = spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd, encoding: "utf-8" }).stdout.trim();
	const body = spawnSync("git", ["log", "-1", "--pretty=%B"], { cwd, encoding: "utf-8" }).stdout;
	return { subject: subj, body };
}

function commitCount(cwd: string): number {
	const out = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd, encoding: "utf-8" }).stdout.trim();
	return Number(out);
}

let repo: string;
beforeEach(() => {
	repo = mkTmpRepo();
});
afterEach(() => {
	try {
		fs.rmSync(repo, { recursive: true, force: true });
	} catch {}
});

// ---------------------------------------------------------------------------
// commitSubagentWork — ports subagents-patch.test.ts cases
// ---------------------------------------------------------------------------

describe("[unit] commitSubagentWork — successful dirty tree", () => {
	test("stages all changes and commits with required trailers", () => {
		fs.writeFileSync(path.join(repo, "out.md"), "ghola wrote this\n");

		const result = commitSubagentWork({
			cwd: repo,
			agent: "spec-writer",
			sliceId: "TEST-001",
			sessionId: "sess-abc",
			message: "drafted the opening spec",
		});
		expect(result.committed).toBe(true);

		const { subject, body } = lastCommit(repo);
		expect(subject.startsWith("spec-writer:")).toBe(true);
		expect(subject).toContain("drafted the opening spec");

		for (const trailer of [
			"Co-Authored-By: spec-writer",
			"Spec-Slice: TEST-001",
			"Peer: spec-writer",
			"Session: sess-abc",
		]) {
			expect(body).toContain(trailer);
		}
	});
});

describe("[unit] commitSubagentWork — clean tree", () => {
	test("is a no-op, does not create an empty commit, reports committed:false", () => {
		const before = commitCount(repo);
		const result = commitSubagentWork({
			cwd: repo,
			agent: "doc-scout",
			sliceId: "TEST-001",
			sessionId: "sess-def",
			message: "no files touched",
		});
		expect(result.committed).toBe(false);
		expect(commitCount(repo)).toBe(before);
	});
});

describe("[unit] commitSubagentWork — error handling", () => {
	test("does not throw when cwd is not a git repo (returns committed:false with error)", () => {
		const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "omp-notrepo-"));
		fs.writeFileSync(path.join(notRepo, "x.txt"), "content\n");
		try {
			const result = commitSubagentWork({
				cwd: notRepo,
				agent: "implementer",
				sliceId: "TEST-001",
				sessionId: "sess-xyz",
				message: "would fail silently",
			});
			expect(result.committed).toBe(false);
			expect(result.error).toBeDefined();
		} finally {
			fs.rmSync(notRepo, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// state-file helpers — port a subset of specsafe-session.test.ts that does
// not depend on the begin/end tools (those tools live in .pi/, not .omp/).
// ---------------------------------------------------------------------------

describe("[unit] state file — readStateFileOrNull", () => {
	let projectDir: string;
	beforeEach(() => {
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-specsafe-state-"));
		fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
	});
	afterEach(() => {
		try {
			fs.rmSync(projectDir, { recursive: true, force: true });
		} catch {}
	});

	test("returns null on missing file (does not throw)", () => {
		const s = readStateFileOrNull(statePathFor(projectDir));
		expect(s).toBeNull();
	});

	test("corrupt state file is quarantined, returns null", () => {
		const sp = statePathFor(projectDir);
		fs.writeFileSync(sp, "{not valid json", { mode: 0o600 });
		const s = readStateFileOrNull(sp);
		expect(s).toBeNull();
		const entries = fs.readdirSync(path.join(projectDir, ".pi"));
		expect(entries.some((f) => f.startsWith(".honcho-state.json.corrupt-"))).toBe(true);
		expect(fs.existsSync(sp)).toBe(false);
	});

	test("reads a valid state file with currentSlice", () => {
		const state: StateFile = {
			currentSlice: {
				id: "S1",
				workspaceId: "w",
				sessionId: "sess-1",
				beganAt: new Date().toISOString(),
				costCounter: {
					honchoCalls: 0,
					honchoCost: 0,
					subagentTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				},
			},
			history: [],
		};
		fs.writeFileSync(statePathFor(projectDir), JSON.stringify(state), { mode: 0o600 });
		const loaded = readStateFileOrNull(statePathFor(projectDir));
		expect(loaded?.currentSlice?.id).toBe("S1");
		expect(loaded?.currentSlice?.sessionId).toBe("sess-1");
	});
});

// ---------------------------------------------------------------------------
// buildTrailerBlock — exercises the four-trailer recipe
// ---------------------------------------------------------------------------

describe("[unit] buildTrailerBlock", () => {
	test("emits all four trailers in source-faithful order", () => {
		const block = buildTrailerBlock({
			agent: "implementer",
			sliceId: "CUR-92__login",
			sessionId: "sess-xyz",
		});
		const lines = block.split("\n");
		expect(lines[0]).toBe("Co-Authored-By: implementer <implementer@seshat.local>");
		expect(lines[1]).toBe("Spec-Slice: CUR-92__login");
		expect(lines[2]).toBe("Peer: implementer");
		expect(lines[3]).toBe("Session: sess-xyz");
	});
});
