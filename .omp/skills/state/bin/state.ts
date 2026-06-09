#!/usr/bin/env -S bun run
/**
 * state — durable cross-session mission context (Seshat v2, slice v2.6).
 *
 * Defends against context-rot (GSD pattern): the heavy, compaction-surviving
 * facts live on disk, not in the conversation. Machine state is JSON at
 * `<cwd>/.omp/.state.json`; a human-readable `STATE.md` mirror is rendered for
 * commit so the next session (or operator) can resume instantly.
 *
 * Concurrent-writer safety: every mutation takes an O_EXCL lock
 * (`.omp/.state.lock`) — a second writer fails fast instead of interleaving.
 *
 * Usage:
 *   bun run .omp/skills/state/bin/state.ts init <mission>
 *   bun run .omp/skills/state/bin/state.ts set <phase|scaleLevel|mission> <value>
 *   bun run .omp/skills/state/bin/state.ts note "<text>"
 *   bun run .omp/skills/state/bin/state.ts show [--json]
 *   bun run .omp/skills/state/bin/state.ts render        # rewrite STATE.md
 *
 * Exit codes: 0 ok · 1 lock contention / state error · 2 usage error
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface MissionState {
	mission: string;
	phase: string;
	scaleLevel: number | null;
	updatedAt: string;
	notes: Array<{ ts: string; text: string }>;
}

export function emptyState(mission = ""): MissionState {
	return { mission, phase: "classify", scaleLevel: null, updatedAt: new Date().toISOString(), notes: [] };
}

export type SettableKey = "phase" | "scaleLevel" | "mission";

/** Pure: apply a `set`. Throws on unknown key or invalid scaleLevel. */
export function applySet(state: MissionState, key: string, value: string): MissionState {
	const next: MissionState = { ...state, notes: [...state.notes], updatedAt: new Date().toISOString() };
	switch (key) {
		case "phase":
			next.phase = value;
			return next;
		case "mission":
			next.mission = value;
			return next;
		case "scaleLevel": {
			const n = Number(value);
			if (!Number.isInteger(n) || n < 0 || n > 4) throw new Error("scaleLevel must be an integer 0..4");
			next.scaleLevel = n;
			return next;
		}
		default:
			throw new Error(`unknown key '${key}' (one of: phase, scaleLevel, mission)`);
	}
}

/** Pure: append a note. */
export function applyNote(state: MissionState, text: string): MissionState {
	if (text.trim().length === 0) throw new Error("note text is required");
	return {
		...state,
		updatedAt: new Date().toISOString(),
		notes: [...state.notes, { ts: new Date().toISOString(), text: text.trim() }],
	};
}

/** Pure: render the human-readable STATE.md mirror. */
export function renderMarkdown(state: MissionState): string {
	const lines = [
		"# STATE — current mission",
		"",
		`- **mission:** ${state.mission || "(unset)"}`,
		`- **phase:** ${state.phase}`,
		`- **scale level:** ${state.scaleLevel ?? "(unset)"}`,
		`- **updated:** ${state.updatedAt}`,
		"",
		"## Notes (most recent last)",
		"",
		...(state.notes.length === 0 ? ["_none yet_"] : state.notes.map((n) => `- ${n.ts} — ${n.text}`)),
		"",
	];
	return lines.join("\n");
}

// --------------------------------------------------------------------------
// Filesystem layer (impure)
// --------------------------------------------------------------------------

function statePath(cwd: string): string {
	return path.join(cwd, ".omp", ".state.json");
}
function lockPath(cwd: string): string {
	return path.join(cwd, ".omp", ".state.lock");
}
function stateMdPath(cwd: string): string {
	return path.join(cwd, "STATE.md");
}

/** Take an O_EXCL lock for the duration of `fn`. Throws if already held. */
export function withLock<T>(lock: string, fn: () => T): T {
	fs.mkdirSync(path.dirname(lock), { recursive: true });
	let fd: number;
	try {
		fd = fs.openSync(lock, "wx"); // wx === O_CREAT|O_EXCL — fails if exists
	} catch {
		throw new Error(`state is locked (${lock}); another writer holds it`);
	}
	try {
		fs.writeSync(fd, String(process.pid));
		return fn();
	} finally {
		fs.closeSync(fd);
		try {
			fs.rmSync(lock, { force: true });
		} catch {
			/* best effort */
		}
	}
}

function loadState(cwd: string): MissionState {
	try {
		return JSON.parse(fs.readFileSync(statePath(cwd), "utf-8")) as MissionState;
	} catch {
		return emptyState();
	}
}

function persist(cwd: string, state: MissionState): void {
	const sp = statePath(cwd);
	fs.mkdirSync(path.dirname(sp), { recursive: true });
	const tmp = `${sp}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, sp);
	fs.writeFileSync(stateMdPath(cwd), renderMarkdown(state));
}

function fail(message: string, code: number): never {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

function main(argv: string[]): number {
	const [sub, ...rest] = argv;
	const cwd = process.cwd();
	switch (sub) {
		case "init": {
			const mission = rest.join(" ").trim();
			if (!mission) fail("usage: state init <mission>", 2);
			withLock(lockPath(cwd), () => persist(cwd, emptyState(mission)));
			process.stdout.write(`initialized: ${mission}\n`);
			return 0;
		}
		case "set": {
			const [key, ...vparts] = rest;
			const value = vparts.join(" ");
			if (!key || value.length === 0) fail("usage: state set <phase|scaleLevel|mission> <value>", 2);
			try {
				withLock(lockPath(cwd), () => persist(cwd, applySet(loadState(cwd), key, value)));
			} catch (err) {
				fail(`error: ${err instanceof Error ? err.message : String(err)}`, 1);
			}
			process.stdout.write(`set ${key}=${value}\n`);
			return 0;
		}
		case "note": {
			const text = rest.join(" ");
			try {
				withLock(lockPath(cwd), () => persist(cwd, applyNote(loadState(cwd), text)));
			} catch (err) {
				fail(`error: ${err instanceof Error ? err.message : String(err)}`, 1);
			}
			process.stdout.write("noted\n");
			return 0;
		}
		case "render": {
			fs.writeFileSync(stateMdPath(cwd), renderMarkdown(loadState(cwd)));
			process.stdout.write("rendered STATE.md\n");
			return 0;
		}
		case "show": {
			const state = loadState(cwd);
			if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
			else process.stdout.write(renderMarkdown(state));
			return 0;
		}
		default:
			fail("usage: state <init|set|note|show|render> ...", 2);
	}
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}
