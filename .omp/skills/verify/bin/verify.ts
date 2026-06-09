#!/usr/bin/env -S bun run
/**
 * verify — the universal verification contract runner (Seshat v2, slice v2.2).
 *
 * Every mission — code, docs, or config — ships with machine-checked
 * acceptance criteria. This retires the old "skip tests for markdown/config"
 * carve-out: docs/config simply carry a non-test `check_command` (lint, build,
 * link-check) instead of a unit test. Nothing ships unverified.
 *
 * Criteria file shape (`.omp/.../acceptance.json` or inline in a mission packet):
 *   {
 *     "scaleLevel": 2,
 *     "criteria": [
 *       { "id": "AC-1", "description": "types pass",  "check_command": "bun run typecheck", "severity": "block" },
 *       { "id": "AC-2", "description": "tests green",  "check_command": "bun test",          "severity": "block" },
 *       { "id": "AC-3", "description": "no lint warns", "check_command": "bun run lint",      "severity": "warn"  }
 *     ]
 *   }
 *
 * Usage:
 *   bun run .omp/skills/verify/bin/verify.ts run <criteria.json>
 *   bun run .omp/skills/verify/bin/verify.ts run <criteria.json> --json
 *   bun run .omp/skills/verify/bin/verify.ts scaffold <0..4> [> acceptance.json]
 *
 * Exit codes:
 *   0  all block-severity criteria passed (warn failures allowed)
 *   1  at least one block-severity criterion failed
 *   2  usage / parse error
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

export type Severity = "block" | "warn";

export interface Criterion {
	id: string;
	description: string;
	check_command: string;
	severity: Severity;
}

export interface CriterionResult {
	id: string;
	description: string;
	severity: Severity;
	passed: boolean;
	exitCode: number;
}

export interface CriteriaDoc {
	scaleLevel?: number;
	criteria: Criterion[];
}

/** Parse + validate a criteria document. Throws a precise error on bad shape. */
export function parseCriteria(raw: unknown): CriteriaDoc {
	if (typeof raw !== "object" || raw === null) throw new Error("criteria doc must be a JSON object");
	const obj = raw as Record<string, unknown>;
	if (!Array.isArray(obj.criteria)) throw new Error("criteria doc must have a `criteria` array");
	const criteria = obj.criteria.map((c, i) => {
		if (typeof c !== "object" || c === null) throw new Error(`criteria[${i}] must be an object`);
		const o = c as Record<string, unknown>;
		const id = o.id;
		const description = o.description;
		const check_command = o.check_command;
		const severity = o.severity ?? "block";
		if (typeof id !== "string" || id.length === 0) throw new Error(`criteria[${i}].id is required`);
		if (typeof description !== "string") throw new Error(`criteria[${i}].description is required`);
		if (typeof check_command !== "string" || check_command.length === 0)
			throw new Error(`criteria[${i}].check_command is required`);
		if (severity !== "block" && severity !== "warn") throw new Error(`criteria[${i}].severity must be "block" or "warn"`);
		return { id, description, check_command, severity } satisfies Criterion;
	});
	const scaleLevel = typeof obj.scaleLevel === "number" ? obj.scaleLevel : undefined;
	return { scaleLevel, criteria };
}

/** A command runner seam so tests can inject results without spawning. */
export type CommandRunner = (command: string) => { exitCode: number };

const realRunner: CommandRunner = (command) => {
	const res = spawnSync(command, { shell: true, stdio: "inherit", encoding: "utf-8" });
	return { exitCode: res.status ?? 1 };
};

/** Run every criterion. block-severity short-circuits nothing — all run so the
 *  operator sees the full picture in one pass. */
export function runCriteria(criteria: Criterion[], run: CommandRunner = realRunner): CriterionResult[] {
	return criteria.map((c) => {
		const { exitCode } = run(c.check_command);
		return { id: c.id, description: c.description, severity: c.severity, passed: exitCode === 0, exitCode };
	});
}

export interface Summary {
	total: number;
	passed: number;
	blockFailures: CriterionResult[];
	warnFailures: CriterionResult[];
	ok: boolean; // true when no block-severity criterion failed
}

export function summarize(results: CriterionResult[]): Summary {
	const blockFailures = results.filter((r) => !r.passed && r.severity === "block");
	const warnFailures = results.filter((r) => !r.passed && r.severity === "warn");
	const passed = results.filter((r) => r.passed).length;
	return { total: results.length, passed, blockFailures, warnFailures, ok: blockFailures.length === 0 };
}

/** Scale-level starter acceptance sets (BMAD-style cost dial). */
export function scaffold(level: number): CriteriaDoc {
	const typecheck: Criterion = {
		id: "AC-TYPES",
		description: "Type checker passes",
		check_command: "bun run typecheck",
		severity: "block",
	};
	const tests: Criterion = {
		id: "AC-TESTS",
		description: "Test suite green (RED→GREEN proven)",
		check_command: "bun test",
		severity: "block",
	};
	const lint: Criterion = { id: "AC-LINT", description: "Lint clean", check_command: "bun run lint", severity: "warn" };
	switch (level) {
		case 0:
			return { scaleLevel: 0, criteria: [lint] };
		case 1:
			return { scaleLevel: 1, criteria: [typecheck, lint] };
		case 2:
			return { scaleLevel: 2, criteria: [typecheck, tests, lint] };
		case 3:
			return {
				scaleLevel: 3,
				criteria: [
					typecheck,
					tests,
					lint,
					{
						id: "AC-AUDIT",
						description: "Dependency audit clean",
						check_command: "bun pm ls >/dev/null 2>&1 || true",
						severity: "warn",
					},
				],
			};
		case 4:
			return {
				scaleLevel: 4,
				criteria: [
					typecheck,
					tests,
					lint,
					{
						id: "AC-AUDIT",
						description: "Dependency audit clean",
						check_command: "bun pm ls >/dev/null 2>&1 || true",
						severity: "block",
					},
					{
						id: "AC-BUILD",
						description: "Release build succeeds",
						check_command: "echo 'wire release build here'",
						severity: "block",
					},
				],
			};
		default:
			throw new Error(`scale level must be 0..4 (got ${level})`);
	}
}

export function renderSummary(doc: CriteriaDoc, results: CriterionResult[], summary: Summary): string {
	const lines: string[] = [];
	if (doc.scaleLevel !== undefined) lines.push(`scale level: ${doc.scaleLevel}`);
	for (const r of results) {
		const mark = r.passed ? "PASS" : r.severity === "block" ? "FAIL" : "WARN";
		lines.push(`  [${mark}] ${r.id} — ${r.description}${r.passed ? "" : ` (exit ${r.exitCode})`}`);
	}
	lines.push(
		`${summary.passed}/${summary.total} passed; ${summary.blockFailures.length} blocking, ${summary.warnFailures.length} warnings`,
	);
	lines.push(summary.ok ? "VERDICT: PASS" : "VERDICT: FAIL");
	return lines.join("\n");
}

function fail(message: string, code: number): never {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

function main(argv: string[]): number {
	const [sub, ...rest] = argv;
	if (sub === "scaffold") {
		const level = Number(rest[0]);
		if (!Number.isInteger(level)) fail("usage: verify scaffold <0..4>", 2);
		process.stdout.write(`${JSON.stringify(scaffold(level), null, 2)}\n`);
		return 0;
	}
	if (sub === "run") {
		const file = rest.find((a) => !a.startsWith("--"));
		const asJson = rest.includes("--json");
		if (!file) fail("usage: verify run <criteria.json> [--json]", 2);
		let doc: CriteriaDoc;
		try {
			doc = parseCriteria(JSON.parse(fs.readFileSync(file, "utf-8")));
		} catch (err) {
			fail(`error: ${err instanceof Error ? err.message : String(err)}`, 2);
		}
		const results = runCriteria(doc.criteria);
		const summary = summarize(results);
		if (asJson) {
			process.stdout.write(`${JSON.stringify({ scaleLevel: doc.scaleLevel, results, summary }, null, 2)}\n`);
		} else {
			process.stdout.write(`${renderSummary(doc, results, summary)}\n`);
		}
		return summary.ok ? 0 : 1;
	}
	fail("usage: verify <run|scaffold> ...", 2);
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}
