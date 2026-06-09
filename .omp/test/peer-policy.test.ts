/**
 * Unit tests — peer-policy (Seshat v2.1 identity enforcement).
 */
import { describe, expect, test } from "bun:test";
import { CONCLUSION_WRITERS, evaluateConclude, evaluateRemember, isConclusionWriter } from "../lib/peer-policy";

describe("[unit] peer-policy.isConclusionWriter", () => {
	test("validator/reviewer/steward and v2 additions are writers", () => {
		for (const p of ["validator", "reviewer", "reviewer-code", "security-reviewer", "steward", "release-steward"]) {
			expect(isConclusionWriter(p)).toBe(true);
			expect(CONCLUSION_WRITERS.has(p)).toBe(true);
		}
	});
	test("implementer / spec-writer are NOT writers", () => {
		expect(isConclusionWriter("implementer")).toBe(false);
		expect(isConclusionWriter("spec-writer")).toBe(false);
	});
});

describe("[unit] peer-policy.evaluateConclude", () => {
	test("missing as_peer is rejected", () => {
		const v = evaluateConclude({ content: "engineering: x" });
		expect(v.ok).toBe(false);
	});
	test("unknown persona is rejected before allowlist", () => {
		const v = evaluateConclude({ declaredPeer: "ghost", content: "x" });
		expect(v).toMatchObject({ ok: false });
		if (!v.ok) expect(v.reason).toContain("not a known persona");
	});
	test("known but non-writer persona is rejected", () => {
		const v = evaluateConclude({ declaredPeer: "implementer", content: "x" });
		expect(v).toMatchObject({ ok: false });
		if (!v.ok) expect(v.reason).toContain("not permitted");
	});
	test("writer with no expectedPeer passes", () => {
		expect(evaluateConclude({ declaredPeer: "validator", content: "engineering truth" }).ok).toBe(true);
	});
	test("expectedPeer mismatch is blocked as a spoof", () => {
		const v = evaluateConclude({ declaredPeer: "reviewer", expectedPeer: "validator", content: "x" });
		expect(v).toMatchObject({ ok: false });
		if (!v.ok) expect(v.reason).toContain("spoof");
	});
	test("expectedPeer match passes", () => {
		expect(evaluateConclude({ declaredPeer: "validator", expectedPeer: "validator", content: "x" }).ok).toBe(true);
	});
	test("steward must prefix product:", () => {
		expect(evaluateConclude({ declaredPeer: "steward", content: "no prefix" }).ok).toBe(false);
		expect(evaluateConclude({ declaredPeer: "steward", content: "product: scoped truth" }).ok).toBe(true);
	});
	test("release-steward must prefix product: too", () => {
		expect(evaluateConclude({ declaredPeer: "release-steward", content: "x" }).ok).toBe(false);
		expect(evaluateConclude({ declaredPeer: "release-steward", content: "product: y" }).ok).toBe(true);
	});
});

describe("[unit] peer-policy.evaluateRemember", () => {
	test("absent as_peer is allowed (env fallback)", () => {
		expect(evaluateRemember({}).ok).toBe(true);
	});
	test("unknown declared peer is rejected", () => {
		expect(evaluateRemember({ declaredPeer: "ghost" }).ok).toBe(false);
	});
	test("declared peer that contradicts expectedPeer is blocked", () => {
		expect(evaluateRemember({ declaredPeer: "reviewer", expectedPeer: "implementer" }).ok).toBe(false);
	});
	test("matching declared/expected passes", () => {
		expect(evaluateRemember({ declaredPeer: "implementer", expectedPeer: "implementer" }).ok).toBe(true);
	});
});
