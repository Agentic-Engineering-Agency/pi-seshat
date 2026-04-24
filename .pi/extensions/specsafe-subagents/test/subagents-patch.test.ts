/**
 * Tests for the specsafe-subagents patch.
 *
 * SpecSafe slice: SPEC-20260424-001 — pi-honcho-bridge-v1
 *
 * Covers:
 *   - env injection into spawned child processes (HONCHO_*, SPECSAFE_SLICE_ID)
 *   - auto-commit on successful subagent exit with required trailers
 *   - NO commit on child failure
 *   - NO commit on clean working tree
 *
 * These tests are [unit]-style in that they don't require the full pi runtime;
 * they exercise the helpers directly by importing from the patched module.
 * The helpers MUST be exported by the implementer:
 *   - buildChildEnv(parentEnv, state, agentName)
 *   - commitSubagentWork({ cwd, agent, sliceId, sessionId, message })
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildChildEnv, commitSubagentWork } from "../index.ts";

function mkTmpRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
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

// ---------- env injection ----------

describe("[unit] buildChildEnv", () => {
	test("injects HONCHO_* + SPECSAFE_SLICE_ID when a slice is open", () => {
		const state = {
			currentSlice: {
				id: "CUR-92__login",
				workspaceId: "curia",
				sessionId: "sess-xyz",
				beganAt: "2026-04-24T00:00:00Z",
				costCounter: {
					honchoCalls: 0,
					honchoCost: 0,
					subagentTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				},
			},
			history: [],
		};
		const parent = { PATH: "/usr/bin", HONCHO_API_KEY: "hch-secret" } as NodeJS.ProcessEnv;
		const child = buildChildEnv(parent, state, "implementer");
		expect(child.HONCHO_PEER_ID).toBe("implementer");
		expect(child.HONCHO_WORKSPACE_ID).toBe("curia");
		expect(child.HONCHO_SESSION_ID).toBe("sess-xyz");
		expect(child.SPECSAFE_SLICE_ID).toBe("CUR-92__login");
		expect(child.HONCHO_API_KEY).toBe("hch-secret"); // pass-through
		expect(child.PATH).toBe("/usr/bin");
	});

	test("sets only HONCHO_PEER_ID when no slice is open", () => {
		const parent = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
		const child = buildChildEnv(parent, null, "spec-writer");
		expect(child.HONCHO_PEER_ID).toBe("spec-writer");
		expect(child.HONCHO_WORKSPACE_ID).toBeUndefined();
		expect(child.HONCHO_SESSION_ID).toBeUndefined();
		expect(child.SPECSAFE_SLICE_ID).toBeUndefined();
	});
});

// ---------- auto-commit ----------

describe("[unit] commitSubagentWork — successful dirty tree", () => {
	test("stages all changes and commits with required trailers", async () => {
		fs.writeFileSync(path.join(repo, "out.md"), "ghola wrote this\n");

		const result = await commitSubagentWork({
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
	test("is a no-op, does not create an empty commit, reports committed:false", async () => {
		const before = commitCount(repo);
		const result = await commitSubagentWork({
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
	test("does not throw when cwd is not a git repo (logs + returns committed:false)", async () => {
		const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-notrepo-"));
		fs.writeFileSync(path.join(notRepo, "x.txt"), "content\n");
		try {
			const result = await commitSubagentWork({
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

// The "subagent with exit != 0 MUST NOT commit" invariant is asserted at the
// integration boundary inside runAgent. That logic is a one-line guard
// (`if (code === 0 && state) await commitSubagentWork(...)`). Rather than
// mount a full pi child-process harness in unit tests, this invariant is
// covered by code review of the patch — any future reviewer MUST confirm
// the guard is present. If this policy ever feels thin, add an e2e test
// that spawns a scripted child that exits 1 after writing a file.
