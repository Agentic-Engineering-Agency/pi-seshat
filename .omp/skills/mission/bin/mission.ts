#!/usr/bin/env -S bun run
/**
 * mission — Ultimate-Harness mission-packet shim (Seshat v2, slice v2.7).
 *
 * Emits/updates `uh.mission.v0` packets so this omp installation is legible to
 * the Ultimate Harness as a runtime adapter: a mission carries its goal, scale
 * level, acceptance criteria, verification verdict, promotion record, and an
 * append-only audit trail. The `release-steward` writes/refreshes the packet at
 * L4 promotion time; `verify` results flow into `verification`.
 *
 * Usage:
 *   bun run .omp/skills/mission/bin/mission.ts new <id> <goal...> [--scale N]
 *   bun run .omp/skills/mission/bin/mission.ts show <packet.json>
 *   bun run .omp/skills/mission/bin/mission.ts set-verdict <packet.json> <PASS|FAIL>
 *   bun run .omp/skills/mission/bin/mission.ts promote <packet.json> <approver>
 *
 * Exit codes: 0 ok · 1 state/validation error · 2 usage error
 */
import * as fs from "node:fs";

export const MISSION_SCHEMA = "uh.mission.v0" as const;

export interface AcceptanceCriterion {
	id: string;
	description: string;
	check_command: string;
	severity: "block" | "warn";
}

export interface MissionPacket {
	schema: typeof MISSION_SCHEMA;
	id: string;
	goal: string;
	scaleLevel: number | null;
	runtime: "oh-my-pi";
	acceptance_criteria: AcceptanceCriterion[];
	verification: { verdict: "PASS" | "FAIL" | "PENDING"; ranAt: string | null };
	promotion: { promoted: boolean; approver: string | null; at: string | null };
	audit: Array<{ ts: string; event: string }>;
	createdAt: string;
	updatedAt: string;
}

function now(): string {
	return new Date().toISOString();
}

export function newMission(input: { id: string; goal: string; scaleLevel?: number | null }): MissionPacket {
	if (!input.id) throw new Error("mission id is required");
	if (!input.goal) throw new Error("mission goal is required");
	const ts = now();
	return {
		schema: MISSION_SCHEMA,
		id: input.id,
		goal: input.goal,
		scaleLevel: input.scaleLevel ?? null,
		runtime: "oh-my-pi",
		acceptance_criteria: [],
		verification: { verdict: "PENDING", ranAt: null },
		promotion: { promoted: false, approver: null, at: null },
		audit: [{ ts, event: `created mission ${input.id}` }],
		createdAt: ts,
		updatedAt: ts,
	};
}

export function attachAcceptance(packet: MissionPacket, criteria: AcceptanceCriterion[]): MissionPacket {
	return touch({ ...packet, acceptance_criteria: criteria }, `attached ${criteria.length} acceptance criteria`);
}

export function recordVerification(packet: MissionPacket, verdict: "PASS" | "FAIL"): MissionPacket {
	return touch({ ...packet, verification: { verdict, ranAt: now() } }, `verification ${verdict}`);
}

/** Promotion requires a PASS verification — refuses otherwise (gate, not advice). */
export function recordPromotion(packet: MissionPacket, approver: string): MissionPacket {
	if (!approver) throw new Error("approver is required");
	if (packet.verification.verdict !== "PASS") {
		throw new Error(`cannot promote: verification is ${packet.verification.verdict}, not PASS`);
	}
	return touch({ ...packet, promotion: { promoted: true, approver, at: now() } }, `promoted by ${approver}`);
}

function touch(packet: MissionPacket, event: string): MissionPacket {
	const ts = now();
	return { ...packet, updatedAt: ts, audit: [...packet.audit, { ts, event }] };
}

/** Validate a parsed packet has the load-bearing shape. Throws on drift. */
export function validatePacket(raw: unknown): MissionPacket {
	if (typeof raw !== "object" || raw === null) throw new Error("packet must be an object");
	const o = raw as Record<string, unknown>;
	if (o.schema !== MISSION_SCHEMA) throw new Error(`packet schema must be '${MISSION_SCHEMA}'`);
	if (typeof o.id !== "string" || typeof o.goal !== "string") throw new Error("packet missing id/goal");
	if (!Array.isArray(o.acceptance_criteria)) throw new Error("packet missing acceptance_criteria[]");
	if (typeof o.verification !== "object" || o.verification === null) throw new Error("packet missing verification");
	return raw as MissionPacket;
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function load(file: string): MissionPacket {
	return validatePacket(JSON.parse(fs.readFileSync(file, "utf-8")));
}
function save(file: string, packet: MissionPacket): void {
	fs.writeFileSync(file, `${JSON.stringify(packet, null, 2)}\n`);
}
function fail(message: string, code: number): never {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

function main(argv: string[]): number {
	const [sub, ...rest] = argv;
	try {
		switch (sub) {
			case "new": {
				const scaleIdx = rest.indexOf("--scale");
				let scaleLevel: number | null = null;
				let words = rest;
				if (scaleIdx >= 0) {
					scaleLevel = Number(rest[scaleIdx + 1]);
					words = rest.filter((_, i) => i !== scaleIdx && i !== scaleIdx + 1);
				}
				const [id, ...goalParts] = words;
				if (!id || goalParts.length === 0) fail("usage: mission new <id> <goal...> [--scale N]", 2);
				process.stdout.write(`${JSON.stringify(newMission({ id, goal: goalParts.join(" "), scaleLevel }), null, 2)}\n`);
				return 0;
			}
			case "show": {
				const file = rest[0];
				if (!file) fail("usage: mission show <packet.json>", 2);
				process.stdout.write(`${JSON.stringify(load(file), null, 2)}\n`);
				return 0;
			}
			case "set-verdict": {
				const [file, verdict] = rest;
				if (!file || (verdict !== "PASS" && verdict !== "FAIL"))
					fail("usage: mission set-verdict <packet.json> <PASS|FAIL>", 2);
				save(file, recordVerification(load(file), verdict as "PASS" | "FAIL"));
				process.stdout.write(`verdict ${verdict} recorded\n`);
				return 0;
			}
			case "promote": {
				const [file, approver] = rest;
				if (!file || !approver) fail("usage: mission promote <packet.json> <approver>", 2);
				save(file, recordPromotion(load(file), approver));
				process.stdout.write(`promoted by ${approver}\n`);
				return 0;
			}
			default:
				fail("usage: mission <new|show|set-verdict|promote> ...", 2);
		}
	} catch (err) {
		fail(`error: ${err instanceof Error ? err.message : String(err)}`, 1);
	}
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}
