#!/usr/bin/env -S bun run
/**
 * autopilot — operator CLI for cross-session autonomous missions (Seshat v2.8).
 *
 * The portable mission record lives at `<cwd>/.omp/.autopilot.json`. The
 * runtime extension (.omp/extensions/autopilot.ts) consumes it to re-arm the
 * native goal at each session boundary (auto-handoff / process restart). This
 * CLI lets the operator (or the orchestrator Ghola) drive the same record from
 * a shell, mirroring the `/autopilot` slash command.
 *
 * Pure decisions are imported from ../../../lib/autopilot.ts (unit-tested).
 *
 * Usage:
 *   autopilot set <objective>       # draft mode (resume prompt drafted at boundaries)
 *   autopilot auto <objective>      # FULL AUTONOMY (auto-resume across boundaries)
 *   autopilot show [--json]
 *   autopilot pause | resume | stop | done
 *   autopilot budget <N|off>
 *
 * Exit codes: 0 ok · 1 state error · 2 usage error
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyTransition, type AutopilotMission, createMission, type MissionTransition } from "../../../lib/autopilot";

function storePath(cwd: string): string {
	return join(cwd, ".omp", ".autopilot.json");
}

function read(cwd: string): AutopilotMission | null {
	const p = storePath(cwd);
	if (!existsSync(p)) return null;
	try {
		return JSON.parse(readFileSync(p, "utf-8")) as AutopilotMission;
	} catch {
		return null;
	}
}

function write(cwd: string, mission: AutopilotMission): void {
	const p = storePath(cwd);
	mkdirSync(join(cwd, ".omp"), { recursive: true });
	const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(mission, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, p);
}

function render(m: AutopilotMission): string {
	return [
		"# AUTOPILOT — autonomous mission",
		"",
		`- **objective:** ${m.objective}`,
		`- **status:** ${m.status}`,
		`- **mode:** ${m.autoContinue ? "auto (full autonomy)" : "draft (review & submit)"}`,
		`- **token budget:** ${m.tokenBudget ?? "(unbounded)"}`,
		`- **session boundaries spanned:** ${m.sessionCount}`,
		`- **created:** ${m.createdAt}`,
		`- **updated:** ${m.updatedAt}`,
		"",
	].join("\n");
}

function fail(message: string, code: number): never {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

function transition(cwd: string, t: MissionTransition, label: string): number {
	const m = read(cwd);
	if (!m) fail("no autopilot mission set (use: autopilot set <objective>)", 1);
	try {
		write(cwd, applyTransition(m, t, Date.now));
	} catch (err) {
		fail(`error: ${err instanceof Error ? err.message : String(err)}`, 1);
	}
	process.stdout.write(`mission ${label}\n`);
	return 0;
}

function main(argv: string[]): number {
	const [sub, ...rest] = argv;
	const cwd = process.cwd();
	switch (sub) {
		case "set":
		case "auto": {
			const objective = rest.join(" ").trim();
			if (!objective) fail(`usage: autopilot ${sub} <objective>`, 2);
			try {
				write(cwd, createMission({ objective, autoContinue: sub === "auto" }, Date.now));
			} catch (err) {
				fail(`error: ${err instanceof Error ? err.message : String(err)}`, 1);
			}
			process.stdout.write(`mission set (${sub === "auto" ? "auto" : "draft"}): ${objective}\n`);
			return 0;
		}
		case "budget": {
			const v = rest[0];
			const m = read(cwd);
			if (!m) fail("no autopilot mission set", 1);
			if (v === "off" || v === undefined) {
				write(cwd, { ...m, tokenBudget: undefined, updatedAt: new Date().toISOString() });
				process.stdout.write("budget cleared\n");
				return 0;
			}
			const n = Number(v);
			if (!Number.isInteger(n) || n <= 0) fail("budget must be a positive integer or 'off'", 2);
			write(cwd, { ...m, tokenBudget: n, updatedAt: new Date().toISOString() });
			process.stdout.write(`budget set: ${n}\n`);
			return 0;
		}
		case "pause":
			return transition(cwd, "pause", "paused");
		case "resume":
			return transition(cwd, "resume", "resumed");
		case "stop":
		case "drop":
			return transition(cwd, "drop", "stopped");
		case "done":
		case "complete":
			return transition(cwd, "complete", "completed");
		case "show": {
			const m = read(cwd);
			if (!m) {
				process.stdout.write("no autopilot mission set\n");
				return 0;
			}
			process.stdout.write(rest.includes("--json") ? `${JSON.stringify(m, null, 2)}\n` : render(m));
			return 0;
		}
		default:
			fail("usage: autopilot <set|auto|show|pause|resume|stop|done|budget> ...", 2);
	}
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}

export { main };
