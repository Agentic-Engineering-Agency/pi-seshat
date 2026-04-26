/**
 * Tests for fallback-chain JSONL log writer.
 *
 * SpecSafe slice: SPEC-20260426-007 — cross-provider-fallback
 * Covers AC 10 (telemetry log shape + redaction).
 *
 * Imports of the not-yet-implemented module are deferred at runtime so
 * `bun run typecheck` passes for the rest of the codebase. `bun test`
 * fails until ../log.ts exists — that's the TDD red.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

interface AppendLogFn {
	(filePath: string, entry: LogEntry): void;
}

interface RedactFn {
	(text: string): string;
}

async function loadLogModule(): Promise<{
	appendLog: AppendLogFn;
	redact: RedactFn;
}> {
	// Dynamic import via runtime-computed specifier — see chain.test.ts.
	const spec = "../log.ts";
	// biome-ignore lint/suspicious/noExplicitAny: deferred import shim
	const mod = (await import(/* @vite-ignore */ spec)) as any;
	return { appendLog: mod.appendLog, redact: mod.redact };
}

let tmpDir: string;
let logPath: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fallback-log-"));
	logPath = path.join(tmpDir, ".fallback-log.jsonl");
});

afterEach(() => {
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// nothing
	}
});

describe("[unit] appendLog — AC 10a shape", () => {
	test("AC10a: log line is valid JSON with required fields", async () => {
		const { appendLog } = await loadLogModule();
		const entry: LogEntry = {
			ts: "2026-04-26T18:33:21.000Z",
			chain: "default",
			links: [
				{
					provider: "anthropic",
					model: "claude-opus-4-7",
					outcome: "served",
					latencyMs: 4231,
				},
			],
			sessionId: "sess-1",
			peerId: "validator",
			sliceId: "SPEC-20260426-007",
		};
		appendLog(logPath, entry);

		const text = fs.readFileSync(logPath, "utf8").trim();
		const parsed = JSON.parse(text) as Record<string, unknown>;
		expect(typeof parsed.ts).toBe("string");
		// ISO-8601 UTC, must end in Z
		expect(/Z$/.test(String(parsed.ts))).toBe(true);
		expect(parsed.chain).toBe("default");
		expect(Array.isArray(parsed.links)).toBe(true);
		expect((parsed.links as unknown[]).length).toBeGreaterThan(0);
		// All four identity fields present (string-or-null)
		for (const f of ["sessionId", "peerId", "sliceId"] as const) {
			expect(f in parsed).toBe(true);
		}
	});

	test("AC10a: null identity fields are preserved as JSON null (not omitted)", async () => {
		const { appendLog } = await loadLogModule();
		const entry: LogEntry = {
			ts: new Date().toISOString(),
			chain: "default",
			links: [{ provider: "anthropic", model: "claude-opus-4-7", outcome: "served" }],
			sessionId: null,
			peerId: null,
			sliceId: null,
		};
		appendLog(logPath, entry);
		const text = fs.readFileSync(logPath, "utf8").trim();
		const parsed = JSON.parse(text) as Record<string, unknown>;
		expect(parsed.sessionId).toBeNull();
		expect(parsed.peerId).toBeNull();
		expect(parsed.sliceId).toBeNull();
	});

	test("AC10a: appending twice yields two newline-separated JSONL entries", async () => {
		const { appendLog } = await loadLogModule();
		const base: LogEntry = {
			ts: new Date().toISOString(),
			chain: "default",
			links: [{ provider: "anthropic", model: "claude-opus-4-7", outcome: "served" }],
			sessionId: null,
			peerId: null,
			sliceId: null,
		};
		appendLog(logPath, base);
		appendLog(logPath, { ...base, chain: "cheap" });
		const text = fs.readFileSync(logPath, "utf8");
		const lines = text.split("\n").filter((l) => l.length > 0);
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});
});

describe("[unit] appendLog — AC 10b redaction", () => {
	test("AC10b: error containing sk-ant-... token has the token redacted", async () => {
		const { appendLog } = await loadLogModule();
		const fakeKey = "sk-ant-fakekey1234567890ABCDEF";
		const entry: LogEntry = {
			ts: new Date().toISOString(),
			chain: "default",
			links: [
				{
					provider: "anthropic",
					model: "claude-opus-4-7",
					outcome: "fatal",
					errorClass: "http-401",
					errorMessage: `unauthorized: bad apiKey ${fakeKey} returned 401`,
				},
			],
			sessionId: null,
			peerId: null,
			sliceId: null,
		};
		appendLog(logPath, entry);
		const text = fs.readFileSync(logPath, "utf8");
		expect(text).not.toContain(fakeKey);
	});

	test("AC10b: generic 'sk-' long-token is redacted", async () => {
		const { appendLog } = await loadLogModule();
		const fakeOpenAI = "sk-ABCDEF1234567890abcdef1234567890";
		const entry: LogEntry = {
			ts: new Date().toISOString(),
			chain: "default",
			links: [
				{
					provider: "openai",
					model: "gpt-5.5",
					outcome: "fatal",
					errorClass: "http-401",
					errorMessage: `OpenAI 401: Authorization=Bearer ${fakeOpenAI}`,
				},
			],
			sessionId: null,
			peerId: null,
			sliceId: null,
		};
		appendLog(logPath, entry);
		const text = fs.readFileSync(logPath, "utf8");
		expect(text).not.toContain(fakeOpenAI);
	});

	test("AC10b: 'Bearer <token>' is redacted regardless of token shape", async () => {
		const { appendLog } = await loadLogModule();
		const bearer = "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature";
		const entry: LogEntry = {
			ts: new Date().toISOString(),
			chain: "default",
			links: [
				{
					provider: "google",
					model: "gemini-2.5-pro",
					outcome: "fatal",
					errorClass: "http-401",
					errorMessage: `auth failed; sent header ${bearer}`,
				},
			],
			sessionId: null,
			peerId: null,
			sliceId: null,
		};
		appendLog(logPath, entry);
		const text = fs.readFileSync(logPath, "utf8");
		// The literal token portion must not survive into the file.
		expect(text).not.toContain("eyJhbGciOiJIUzI1NiJ9.payload.signature");
	});

	test("AC10b: redact() helper removes sk-ant-... pattern directly", async () => {
		const { redact } = await loadLogModule();
		const out = redact("body: sk-ant-aaaaaaaaaaaaaaaa-bbbb_cc end");
		expect(out).not.toContain("sk-ant-aaaaaaaaaaaaaaaa-bbbb_cc");
		expect(out.toLowerCase()).toContain("redact");
	});

	test("AC10b: redact() helper is a no-op for innocuous text", async () => {
		const { redact } = await loadLogModule();
		expect(redact("hello world")).toBe("hello world");
	});
});

describe("[unit] appendLog — file mode and resilience", () => {
	test("creates the log file with mode 0600 when it does not yet exist", async () => {
		const { appendLog } = await loadLogModule();
		const entry: LogEntry = {
			ts: new Date().toISOString(),
			chain: "default",
			links: [{ provider: "anthropic", model: "claude-opus-4-7", outcome: "served" }],
			sessionId: null,
			peerId: null,
			sliceId: null,
		};
		appendLog(logPath, entry);
		const stat = fs.statSync(logPath);
		// Compare only the permission bits.
		const mode = stat.mode & 0o777;
		expect(mode).toBe(0o600);
	});

	test("a write failure must not throw to the caller (per spec §3.5: 'failure to write the log MUST NOT fail the model call')", async () => {
		const { appendLog } = await loadLogModule();
		// Point at an unwritable path. On linux /proc/1/notreallywritable will EACCES for non-root.
		const bogus = "/proc/1/this-cannot-be-created/x.jsonl";
		const entry: LogEntry = {
			ts: new Date().toISOString(),
			chain: "default",
			links: [{ provider: "anthropic", model: "claude-opus-4-7", outcome: "served" }],
			sessionId: null,
			peerId: null,
			sliceId: null,
		};
		expect(() => appendLog(bogus, entry)).not.toThrow();
	});
});
