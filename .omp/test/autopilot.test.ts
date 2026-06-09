/**
 * Unit tests — autopilot (Seshat v2.8 cross-session autonomous continuation).
 *
 * Pure logic only: no omp runtime required. A fixed clock makes timestamps
 * deterministic.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyTransition,
	autopilotConfigBlock,
	type AutopilotMission,
	buildResumePrompt,
	createMission,
	DEFAULT_HANDOFF_PERCENT,
	decideArm,
	mergeConfig,
	orchestratorContextWarning,
	ORCHESTRATOR_MIN_CONTEXT_WINDOW,
	reconcileWithGoal,
	TERMINAL_STATUSES,
} from "../lib/autopilot";
import { main as cli } from "../skills/autopilot/bin/autopilot";

const clock = () => Date.parse("2026-06-09T12:00:00.000Z");

describe("[unit] autopilot.createMission", () => {
	test("creates an active mission with defaults", () => {
		const m = createMission({ objective: "ship feature X" }, clock);
		expect(m.status).toBe("active");
		expect(m.autoContinue).toBe(false);
		expect(m.sessionCount).toBe(0);
		expect(m.version).toBe(1);
		expect(m.createdAt).toBe("2026-06-09T12:00:00.000Z");
	});
	test("trims objective and honors autoContinue + budget", () => {
		const m = createMission({ objective: "  do it  ", autoContinue: true, tokenBudget: 500_000 }, clock);
		expect(m.objective).toBe("do it");
		expect(m.autoContinue).toBe(true);
		expect(m.tokenBudget).toBe(500_000);
	});
	test("rejects empty objective", () => {
		expect(() => createMission({ objective: "   " }, clock)).toThrow(/objective is required/);
	});
	test("rejects non-positive / non-integer budget", () => {
		expect(() => createMission({ objective: "x", tokenBudget: 0 }, clock)).toThrow(/positive integer/);
		expect(() => createMission({ objective: "x", tokenBudget: 1.5 }, clock)).toThrow(/positive integer/);
	});
});

describe("[unit] autopilot.applyTransition", () => {
	const base = createMission({ objective: "x" }, clock);
	test("pause/resume/complete/drop set status", () => {
		expect(applyTransition(base, "pause", clock).status).toBe("paused");
		expect(applyTransition(base, "resume", clock).status).toBe("active");
		expect(applyTransition(base, "complete", clock).status).toBe("complete");
		expect(applyTransition(base, "drop", clock).status).toBe("dropped");
	});
	test("terminal missions reject further transitions", () => {
		const done = applyTransition(base, "complete", clock);
		expect(() => applyTransition(done, "resume", clock)).toThrow(/complete/);
		const dropped = applyTransition(base, "drop", clock);
		expect(() => applyTransition(dropped, "pause", clock)).toThrow(/dropped/);
	});
	test("does not mutate input (purity)", () => {
		applyTransition(base, "pause", clock);
		expect(base.status).toBe("active");
	});
});

describe("[unit] autopilot.reconcileWithGoal", () => {
	test("null goal leaves mission untouched", () => {
		const m = createMission({ objective: "x" }, clock);
		expect(reconcileWithGoal(m, null, clock)).toBe(m);
	});
	test("adopts a native goal when no portable mission exists", () => {
		const r = reconcileWithGoal(null, { objective: "from /goal", status: "active" }, clock);
		expect(r?.objective).toBe("from /goal");
		expect(r?.status).toBe("active");
	});
	test("maps budget-limited and paused to paused", () => {
		const m = createMission({ objective: "x" }, clock);
		expect(reconcileWithGoal(m, { objective: "x", status: "budget-limited" }, clock)?.status).toBe("paused");
		expect(reconcileWithGoal(m, { objective: "x", status: "paused" }, clock)?.status).toBe("paused");
	});
	test("mirrors complete/dropped status", () => {
		const m = createMission({ objective: "x" }, clock);
		expect(reconcileWithGoal(m, { objective: "x", status: "complete" }, clock)?.status).toBe("complete");
		expect(reconcileWithGoal(m, { objective: "x", status: "dropped" }, clock)?.status).toBe("dropped");
	});
});

describe("[unit] autopilot.decideArm", () => {
	const active = createMission({ objective: "x" }, clock);
	test("no mission → do not arm", () => {
		expect(decideArm(null, { alreadyArmedThisSession: false })).toMatchObject({ arm: false });
	});
	test("terminal mission → do not arm", () => {
		for (const s of [...TERMINAL_STATUSES]) {
			const m: AutopilotMission = { ...active, status: s };
			expect(decideArm(m, { alreadyArmedThisSession: false })).toMatchObject({ arm: false });
		}
	});
	test("already armed this session → do not arm (de-dupe boundary)", () => {
		expect(decideArm(active, { alreadyArmedThisSession: true })).toMatchObject({ arm: false });
	});
	test("autoContinue=false → draft mode", () => {
		const d = decideArm(active, { alreadyArmedThisSession: false });
		expect(d).toMatchObject({ arm: true, mode: "draft" });
	});
	test("autoContinue=true → auto mode", () => {
		const m = { ...active, autoContinue: true };
		const d = decideArm(m, { alreadyArmedThisSession: false });
		expect(d).toMatchObject({ arm: true, mode: "auto" });
	});
});

describe("[unit] autopilot.buildResumePrompt", () => {
	test("auto mode instructs continue without human input", () => {
		const p = buildResumePrompt(createMission({ objective: "build the thing" }, clock), "auto");
		expect(p).toContain("WITHOUT waiting for further human input");
		expect(p).toContain("build the thing");
		expect(p).toContain("goal` tool");
	});
	test("draft mode asks for review & submit", () => {
		const p = buildResumePrompt(createMission({ objective: "x" }, clock), "draft");
		expect(p).toContain("review");
		expect(p.toLowerCase()).toContain("submit");
	});
	test("includes budget line only when set", () => {
		const withBudget = buildResumePrompt(createMission({ objective: "x", tokenBudget: 9 }, clock), "auto");
		expect(withBudget).toContain("Token budget");
		const noBudget = buildResumePrompt(createMission({ objective: "x" }, clock), "auto");
		expect(noBudget).not.toContain("Token budget");
	});
});

describe("[unit] autopilot.orchestratorContextWarning", () => {
	test("warns below the 1M floor", () => {
		expect(orchestratorContextWarning(272_000)).toContain("1M-context");
	});
	test("no warning at/above floor or when unknown", () => {
		expect(orchestratorContextWarning(ORCHESTRATOR_MIN_CONTEXT_WINDOW)).toBeNull();
		expect(orchestratorContextWarning(undefined)).toBeNull();
		expect(orchestratorContextWarning(0)).toBeNull();
	});
});

describe("[unit] autopilot.autopilotConfigBlock", () => {
	test("defaults to 70% handoff with autoContinue + save-to-disk", () => {
		const c = autopilotConfigBlock();
		expect(c.compaction.thresholdPercent).toBe(DEFAULT_HANDOFF_PERCENT);
		expect(c.compaction.strategy).toBe("handoff");
		expect(c.compaction.autoContinue).toBe(true);
		expect(c.compaction.handoffSaveToDisk).toBe(true);
		expect(c.goal.enabled).toBe(true);
		expect(c.goal.continuationModes).toContain("interactive");
	});
	test("rejects out-of-range thresholds", () => {
		expect(() => autopilotConfigBlock(5)).toThrow(/10\.\.95/);
		expect(() => autopilotConfigBlock(99)).toThrow(/10\.\.95/);
	});
});

describe("[integration] autopilot CLI round-trip", () => {
	function inTempCwd<T>(fn: () => T): T {
		const dir = mkdtempSync(join(tmpdir(), "seshat-autopilot-"));
		const prev = process.cwd();
		process.chdir(dir);
		try {
			return fn();
		} finally {
			process.chdir(prev);
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test("auto set → show --json → pause → done persists status", () => {
		inTempCwd(() => {
			expect(cli(["auto", "ship", "the", "thing"])).toBe(0);
			const storePath = join(process.cwd(), ".omp", ".autopilot.json");
			expect(existsSync(storePath)).toBe(true);
			const saved = JSON.parse(readFileSync(storePath, "utf-8")) as AutopilotMission;
			expect(saved.objective).toBe("ship the thing");
			expect(saved.autoContinue).toBe(true);
			expect(saved.status).toBe("active");
			expect(cli(["pause"])).toBe(0);
			expect((JSON.parse(readFileSync(storePath, "utf-8")) as AutopilotMission).status).toBe("paused");
			expect(cli(["resume"])).toBe(0);
			expect(cli(["done"])).toBe(0);
			expect((JSON.parse(readFileSync(storePath, "utf-8")) as AutopilotMission).status).toBe("complete");
		});
	});

	test("budget set then off", () => {
		inTempCwd(() => {
			expect(cli(["set", "x"])).toBe(0);
			expect(cli(["budget", "500000"])).toBe(0);
			const storePath = join(process.cwd(), ".omp", ".autopilot.json");
			expect((JSON.parse(readFileSync(storePath, "utf-8")) as AutopilotMission).tokenBudget).toBe(500000);
			expect(cli(["budget", "off"])).toBe(0);
			expect((JSON.parse(readFileSync(storePath, "utf-8")) as AutopilotMission).tokenBudget).toBeUndefined();
		});
	});
});

describe("[unit] autopilot.mergeConfig", () => {
	test("deep-merges nested objects without clobbering siblings", () => {
		const base = { model: "fable", compaction: { keepRecentTokens: 20000 }, theme: { dark: "x" } };
		const merged = mergeConfig(base, autopilotConfigBlock(70) as unknown as Record<string, unknown>);
		// preserved
		expect(merged.model).toBe("fable");
		expect((merged.theme as { dark: string }).dark).toBe("x");
		// merged sibling key retained alongside new ones
		expect((merged.compaction as Record<string, unknown>).keepRecentTokens).toBe(20000);
		expect((merged.compaction as Record<string, unknown>).strategy).toBe("handoff");
	});
	test("arrays overwrite (not concatenate)", () => {
		const merged = mergeConfig(
			{ goal: { continuationModes: ["old"] } },
			{
				goal: { continuationModes: ["interactive"] },
			},
		);
		expect((merged.goal as Record<string, unknown>).continuationModes).toEqual(["interactive"]);
	});
});
