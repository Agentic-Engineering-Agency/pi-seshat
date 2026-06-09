/**
 * Unit tests — verify skill (Seshat v2.2 universal verification contract).
 */
import { describe, expect, test } from "bun:test";
import { type Criterion, parseCriteria, runCriteria, scaffold, summarize } from "../skills/verify/bin/verify";

const crit = (over: Partial<Criterion> = {}): Criterion => ({
	id: "AC-1",
	description: "d",
	check_command: "true",
	severity: "block",
	...over,
});

describe("[unit] verify.parseCriteria", () => {
	test("parses a valid doc and defaults severity to block", () => {
		const doc = parseCriteria({ scaleLevel: 2, criteria: [{ id: "AC-1", description: "d", check_command: "true" }] });
		expect(doc.scaleLevel).toBe(2);
		expect(doc.criteria[0]!.severity).toBe("block");
	});
	test("rejects non-object", () => {
		expect(() => parseCriteria(null)).toThrow();
	});
	test("rejects missing criteria array", () => {
		expect(() => parseCriteria({})).toThrow();
	});
	test("rejects criterion missing check_command", () => {
		expect(() => parseCriteria({ criteria: [{ id: "x", description: "y" }] })).toThrow();
	});
	test("rejects invalid severity", () => {
		expect(() =>
			parseCriteria({ criteria: [{ id: "x", description: "y", check_command: "true", severity: "loud" }] }),
		).toThrow();
	});
});

describe("[unit] verify.runCriteria + summarize", () => {
	test("all pass → ok", () => {
		const results = runCriteria([crit({ id: "A" }), crit({ id: "B" })], () => ({ exitCode: 0 }));
		const s = summarize(results);
		expect(s.ok).toBe(true);
		expect(s.passed).toBe(2);
	});
	test("a block failure makes the run not ok", () => {
		const results = runCriteria(
			[crit({ id: "A", check_command: "ok" }), crit({ id: "B", check_command: "bad" })],
			(cmd) => ({ exitCode: cmd === "bad" ? 1 : 0 }),
		);
		const s = summarize(results);
		expect(s.ok).toBe(false);
		expect(s.blockFailures.map((f) => f.id)).toContain("B");
	});
	test("a warn failure does NOT fail the run", () => {
		const r = runCriteria([crit({ id: "W", severity: "warn", check_command: "bad" })], () => ({ exitCode: 1 }));
		const s = summarize(r);
		expect(s.ok).toBe(true);
		expect(s.warnFailures.map((f) => f.id)).toContain("W");
	});
});

describe("[unit] verify.scaffold", () => {
	test("level 0 is lint-only warn", () => {
		const d = scaffold(0);
		expect(d.criteria).toHaveLength(1);
		expect(d.criteria[0]!.severity).toBe("warn");
	});
	test("level 2 includes typecheck + tests as block", () => {
		const d = scaffold(2);
		const blocks = d.criteria.filter((c) => c.severity === "block").map((c) => c.id);
		expect(blocks).toContain("AC-TYPES");
		expect(blocks).toContain("AC-TESTS");
	});
	test("level 4 adds blocking build", () => {
		const d = scaffold(4);
		expect(d.criteria.some((c) => c.id === "AC-BUILD" && c.severity === "block")).toBe(true);
	});
	test("out-of-range level throws", () => {
		expect(() => scaffold(7)).toThrow();
	});
});
