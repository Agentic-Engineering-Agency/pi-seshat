#!/usr/bin/env -S bun run
/**
 * deploy — install the Seshat v2 system globally (Seshat v2, slice v2.7).
 *
 * omp discovers user-level capabilities from `~/.omp/agent/{agents,extensions,
 * tools,skills,rules,commands}` and `~/.omp/agent/{RULES.md,AGENTS.md}`
 * (verified against src/discovery: builtin.ts getConfigDirs + task/discovery.ts).
 * This skill symlinks each repo `.omp/<cap>` to its `~/.omp/agent/<cap>` sibling
 * so the system is live in EVERY project, while per-project `.omp/` overrides
 * still win (project beats user in discovery precedence).
 *
 * Dry-run by default; mutations require `--i-approve` (consistent with the
 * mutation gate). Symlink (not copy) so repo edits flow live to the runtime.
 *
 * Usage:
 *   bun run .omp/skills/deploy/bin/deploy.ts            # dry-run plan
 *   bun run .omp/skills/deploy/bin/deploy.ts --i-approve
 *   bun run .omp/skills/deploy/bin/deploy.ts --i-approve --force   # replace conflicts
 *
 * Exit codes: 0 ok/clean dry-run · 1 conflict or write failure · 2 usage error
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type LinkState =
	| { kind: "missing" }
	| { kind: "correct-symlink" }
	| { kind: "wrong-symlink"; target: string }
	| { kind: "regular" };

export type LinkAction = "create" | "skip" | "replace" | "conflict";

/** Pure decision: given the current state of a link path and whether --force
 *  was passed, what should deploy do? Unit-tested in .omp/test/deploy.test.ts. */
export function decideLinkAction(state: LinkState, force: boolean): LinkAction {
	switch (state.kind) {
		case "missing":
			return "create";
		case "correct-symlink":
			return "skip";
		case "wrong-symlink":
			return force ? "replace" : "conflict";
		case "regular":
			return force ? "replace" : "conflict";
	}
}

/** Capability paths linked from repo .omp into ~/.omp/agent. */
export const CAPABILITIES = ["agents", "extensions", "tools", "skills", "rules", "commands"] as const;
export const FILES = ["RULES.md", "AGENTS.md"] as const;

export type ConfigMergeAction =
	| { action: "create"; text: string }
	| { action: "append"; text: string }
	| { action: "skip-exists" };

/**
 * Pure: decide how to install the autopilot config block into the GLOBAL
 * config.yml without clobbering the user's existing settings (notably their
 * per-role model setup). config.yml cannot be symlinked like the capability
 * dirs — it is a merge target.
 *
 * - No global file        → create it with our block.
 * - File already declares `compaction:` or `goal:` → skip (never risk
 *   corrupting hand-tuned keys; the operator merges manually).
 * - Otherwise             → append our block (valid: top-level keys are new).
 */
export function planConfigMerge(existing: string | null, block: string): ConfigMergeAction {
	if (existing === null) return { action: "create", text: block };
	if (/^(compaction|goal)\s*:/m.test(existing)) return { action: "skip-exists" };
	const joined = existing.endsWith("\n") ? existing : `${existing}\n`;
	return { action: "append", text: `${joined}\n${block}` };
}

interface Opts {
	iApprove: boolean;
	force: boolean;
}

function parseArgs(argv: string[]): Opts {
	const opts: Opts = { iApprove: false, force: false };
	for (const a of argv) {
		if (a === "--i-approve") opts.iApprove = true;
		else if (a === "--force") opts.force = true;
		else {
			process.stderr.write(`error: unknown flag: ${a}\n`);
			process.exit(2);
		}
	}
	return opts;
}

function probe(linkPath: string, expectedSource: string): LinkState {
	let st: fs.Stats | null = null;
	try {
		st = fs.lstatSync(linkPath);
	} catch {
		return { kind: "missing" };
	}
	if (st.isSymbolicLink()) {
		let real: string | null = null;
		try {
			real = fs.realpathSync(linkPath);
		} catch {
			real = null;
		}
		if (real === fs.realpathSync(expectedSource)) return { kind: "correct-symlink" };
		return { kind: "wrong-symlink", target: real ?? "(broken)" };
	}
	return { kind: "regular" };
}

function main(argv: string[]): number {
	const opts = parseArgs(argv);

	// bin/deploy.ts → skills/deploy/bin → repo .omp is 3 up; repo root 4 up.
	const here = path.dirname(fileURLToPath(import.meta.url));
	const ompSource = path.resolve(here, "..", "..", "..");
	const agentDir = path.join(os.homedir(), ".omp", "agent");

	type Item = { name: string; source: string; link: string; state: LinkState; action: LinkAction };
	const items: Item[] = [];
	for (const cap of CAPABILITIES) {
		const source = path.join(ompSource, cap);
		if (!fs.existsSync(source)) continue; // only link what the repo actually has
		const link = path.join(agentDir, cap);
		const state = probe(link, source);
		items.push({ name: cap, source, link, state, action: decideLinkAction(state, opts.force) });
	}
	for (const file of FILES) {
		const source = file === "RULES.md" ? path.join(ompSource, "RULES.md") : path.resolve(ompSource, "..", "AGENTS.md");
		if (!fs.existsSync(source)) continue;
		const link = path.join(agentDir, file);
		const state = probe(link, source);
		items.push({ name: file, source, link, state, action: decideLinkAction(state, opts.force) });
	}

	const conflicts = items.filter((i) => i.action === "conflict");
	const out = process.stdout;

	if (!opts.iApprove) {
		out.write(`deploy plan → ${agentDir}\n`);
		for (const i of items) out.write(`  ${i.action.padEnd(8)} ${i.name}  (${i.link} → ${i.source})\n`);
		const repoConfig = path.join(ompSource, "config.yml");
		if (fs.existsSync(repoConfig)) {
			const globalConfig = path.join(agentDir, "config.yml");
			const existing = fs.existsSync(globalConfig) ? fs.readFileSync(globalConfig, "utf-8") : null;
			const plan = planConfigMerge(existing, fs.readFileSync(repoConfig, "utf-8"));
			out.write(`  ${plan.action.padEnd(8)} config.yml  (autopilot block → ${globalConfig})\n`);
		}
		if (conflicts.length > 0) {
			out.write(`\n${conflicts.length} conflict(s): existing real path(s). Re-run with --i-approve --force to replace.\n`);
		}
		out.write("\ndry-run — pass --i-approve to apply\n");
		return 0;
	}

	if (conflicts.length > 0 && !opts.force) {
		process.stderr.write(`error: ${conflicts.length} conflict(s); pass --force to replace existing paths\n`);
		return 1;
	}

	fs.mkdirSync(agentDir, { recursive: true });
	for (const i of items) {
		if (i.action === "skip") {
			out.write(`skip    ${i.name}\n`);
			continue;
		}
		if (i.action === "replace") fs.rmSync(i.link, { recursive: true, force: true });
		fs.symlinkSync(i.source, i.link);
		out.write(`linked  ${i.name} → ${i.source}\n`);
	}

	// Merge the autopilot config block into the GLOBAL config.yml (cannot be a
	// symlink — it must coexist with the user's model/role settings).
	const repoConfig = path.join(ompSource, "config.yml");
	if (fs.existsSync(repoConfig)) {
		const block = fs.readFileSync(repoConfig, "utf-8");
		const globalConfig = path.join(agentDir, "config.yml");
		const existing = fs.existsSync(globalConfig) ? fs.readFileSync(globalConfig, "utf-8") : null;
		const plan = planConfigMerge(existing, block);
		if (plan.action === "skip-exists") {
			out.write("config  skip — global config.yml already has compaction:/goal: keys; merge .omp/config.yml manually\n");
		} else {
			fs.writeFileSync(globalConfig, plan.text);
			out.write(`config  ${plan.action === "create" ? "created" : "appended autopilot block to"} ${globalConfig}\n`);
		}
	}

	out.write(`\ndeployed to ${agentDir}\n`);
	return 0;
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}
