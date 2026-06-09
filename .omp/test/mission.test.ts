/**
 * Unit tests — mission skill (Seshat v2.7 uh.mission.v0 packet shim).
 */
import { describe, expect, test } from "bun:test";
import {
	attachAcceptance,
	MISSION_SCHEMA,
	newMission,
	recordPromotion,
	recordVerification,
	validatePacket,
} from "../skills/mission/bin/mission";

describe("[unit] mission.newMission", () => {
	test("creates a PENDING uh.mission.v0 packet", () => {
		const m = newMission({ id: "MIS-1", goal: "do x", scaleLevel: 2 });
		expect(m.schema).toBe(MISSION_SCHEMA);
		expect(m.runtime).toBe("oh-my-pi");
		expect(m.verification.verdict).toBe("PENDING");
		expect(m.scaleLevel).toBe(2);
		expect(m.audit).toHaveLength(1);
	});
	test("requires id and goal", () => {
		expect(() => newMission({ id: "", goal: "x" })).toThrow();
		expect(() => newMission({ id: "x", goal: "" })).toThrow();
	});
});

describe("[unit] mission.attachAcceptance / recordVerification", () => {
	test("attaches criteria and appends audit", () => {
		const m = attachAcceptance(newMission({ id: "MIS-1", goal: "g" }), [
			{ id: "AC-1", description: "d", check_command: "true", severity: "block" },
		]);
		expect(m.acceptance_criteria).toHaveLength(1);
		expect(m.audit.length).toBe(2);
	});
	test("records a verdict", () => {
		const m = recordVerification(newMission({ id: "MIS-1", goal: "g" }), "PASS");
		expect(m.verification.verdict).toBe("PASS");
		expect(m.verification.ranAt).not.toBeNull();
	});
});

describe("[unit] mission.recordPromotion is gated on PASS", () => {
	test("refuses to promote a PENDING mission", () => {
		expect(() => recordPromotion(newMission({ id: "MIS-1", goal: "g" }), "luci")).toThrow();
	});
	test("refuses to promote a FAIL mission", () => {
		const failed = recordVerification(newMission({ id: "MIS-1", goal: "g" }), "FAIL");
		expect(() => recordPromotion(failed, "luci")).toThrow();
	});
	test("promotes a PASS mission and records approver", () => {
		const passed = recordVerification(newMission({ id: "MIS-1", goal: "g" }), "PASS");
		const promoted = recordPromotion(passed, "luci");
		expect(promoted.promotion).toMatchObject({ promoted: true, approver: "luci" });
	});
	test("requires an approver", () => {
		const passed = recordVerification(newMission({ id: "MIS-1", goal: "g" }), "PASS");
		expect(() => recordPromotion(passed, "")).toThrow();
	});
});

describe("[unit] mission.validatePacket", () => {
	test("accepts a well-formed packet", () => {
		const m = newMission({ id: "MIS-1", goal: "g" });
		expect(validatePacket(JSON.parse(JSON.stringify(m))).id).toBe("MIS-1");
	});
	test("rejects wrong schema", () => {
		expect(() =>
			validatePacket({ schema: "other", id: "x", goal: "y", acceptance_criteria: [], verification: {} }),
		).toThrow();
	});
	test("rejects missing acceptance_criteria", () => {
		expect(() => validatePacket({ schema: MISSION_SCHEMA, id: "x", goal: "y", verification: {} })).toThrow();
	});
});
