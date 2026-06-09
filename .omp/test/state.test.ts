/**
 * Unit tests — state skill (Seshat v2.6 durable mission context).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyNote, applySet, emptyState, renderMarkdown, withLock } from "../skills/state/bin/state";

describe("[unit] state.applySet", () => {
	test("sets phase", () => {
		expect(applySet(emptyState("m"), "phase", "implement").phase).toBe("implement");
	});
	test("sets a valid scaleLevel", () => {
		expect(applySet(emptyState("m"), "scaleLevel", "3").scaleLevel).toBe(3);
	});
	test("rejects out-of-range scaleLevel", () => {
		expect(() => applySet(emptyState("m"), "scaleLevel", "9")).toThrow();
	});
	test("rejects unknown key", () => {
		expect(() => applySet(emptyState("m"), "bogus", "x")).toThrow();
	});
});

describe("[unit] state.applyNote", () => {
	test("appends a note", () => {
		const s = applyNote(emptyState("m"), "decided X");
		expect(s.notes).toHaveLength(1);
		expect(s.notes[0]!.text).toBe("decided X");
	});
	test("rejects empty note", () => {
		expect(() => applyNote(emptyState("m"), "   ")).toThrow();
	});
});

describe("[unit] state.renderMarkdown", () => {
	test("renders mission + phase + notes", () => {
		const md = renderMarkdown(applyNote(applySet(emptyState("team-invites"), "phase", "verify"), "n1"));
		expect(md).toContain("team-invites");
		expect(md).toContain("phase:** verify");
		expect(md).toContain("n1");
	});
});

describe("[unit] state.withLock", () => {
	test("runs fn and releases; second acquire works after", () => {
		const dir = mkdtempSync(join(tmpdir(), "seshat-lock-"));
		const lock = join(dir, ".state.lock");
		try {
			expect(withLock(lock, () => 42)).toBe(42);
			expect(withLock(lock, () => "again")).toBe("again");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("nested acquire of the same lock throws (held)", () => {
		const dir = mkdtempSync(join(tmpdir(), "seshat-lock-"));
		const lock = join(dir, ".state.lock");
		try {
			expect(() =>
				withLock(lock, () => {
					withLock(lock, () => "inner");
				}),
			).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
