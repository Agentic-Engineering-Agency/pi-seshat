/**
 * autopilot — cross-session autonomous mission continuation (Seshat v2.8).
 *
 * Source of truth for the runtime wiring. Auto-loaded via the shim at
 * `.omp/extensions/autopilot.ts` (omp discovers `.omp/extensions/*.ts`, not the
 * flat `.omp/hooks/*.ts` — see specsafe-session.ts for the same rationale).
 *
 * Responsibilities (the pure decisions live in ../lib/autopilot.ts):
 *   1. goal_updated  → mirror the native goal into a portable, git-trackable
 *      store at `.omp/.autopilot.json` so the objective survives an auto-handoff
 *      (new in-process session) AND a full `omp` process restart.
 *   2. session_start / session_switch(reason="new") → at the boundary, decide
 *      whether to re-arm the autonomous loop (omp deliberately PAUSES goals on
 *      resume — GoalRuntime.onThreadResumed, runtime.ts:274-285) and steer the
 *      orchestrator to re-establish its native goal using the injected
 *      <handoff-context> + STATE.md.
 *   3. /autopilot command → operator control (set/auto/show/pause/resume/stop).
 *
 * Safety: re-arming in "auto" mode (triggerTurn) only happens when the operator
 * has explicitly enabled full autonomy (`autoContinue: true`). Otherwise the
 * resume prompt is delivered as a non-triggering followUp draft for review.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HookAPI } from "@oh-my-pi/pi-coding-agent";
import {
	applyTransition,
	type AutopilotMission,
	buildResumePrompt,
	createMission,
	decideArm,
	type MissionTransition,
	orchestratorContextWarning,
	reconcileWithGoal,
} from "../lib/autopilot";

// ---------------------------------------------------------------------------
// Portable store (impure layer; lib stays pure & unit-tested)
// ---------------------------------------------------------------------------

function storePath(cwd: string): string {
	return join(cwd, ".omp", ".autopilot.json");
}

function readMission(cwd: string): AutopilotMission | null {
	const p = storePath(cwd);
	if (!existsSync(p)) return null;
	try {
		const parsed = JSON.parse(readFileSync(p, "utf-8")) as AutopilotMission;
		if (parsed && typeof parsed === "object" && typeof parsed.objective === "string" && "status" in parsed) {
			return parsed;
		}
		throw new Error("missing required fields");
	} catch {
		// Quarantine corrupt store rather than crash the session.
		try {
			renameSync(p, `${p}.corrupt-${Date.now()}`);
		} catch {
			/* best effort */
		}
		return null;
	}
}

function writeMission(cwd: string, mission: AutopilotMission | null): void {
	const p = storePath(cwd);
	mkdirSync(join(cwd, ".omp"), { recursive: true });
	if (mission === null) return;
	const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(mission, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, p);
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

export default function (pi: HookAPI): void {
	// One re-arm per logical boundary: both session_start and session_switch can
	// land for the same continuation; this de-dupes within a process.
	let armedSessionToken = "";

	// 1) Mirror the native goal into the portable store on every change.
	pi.on("goal_updated", async (event, ctx) => {
		const goal = (event as { goal?: { objective: string; status: string; tokenBudget?: number } | null }).goal ?? null;
		const reconciled = reconcileWithGoal(readMission(ctx.cwd), goal, Date.now);
		if (reconciled) writeMission(ctx.cwd, reconciled);
	});

	// 2) Re-arm the autonomous loop at session boundaries.
	const armBoundary = async (token: string, ctx: Parameters<Parameters<HookAPI["on"]>[1]>[1]): Promise<void> => {
		const alreadyArmedThisSession = armedSessionToken === token;
		const mission = readMission(ctx.cwd);
		const decision = decideArm(mission, { alreadyArmedThisSession });
		if (!decision.arm) return;

		armedSessionToken = token;

		// Persist the boundary crossing (session count) so the operator can see
		// how far the mission has travelled.
		const advanced: AutopilotMission = {
			...decision.mission,
			sessionCount: decision.mission.sessionCount + 1,
			updatedAt: new Date().toISOString(),
		};
		writeMission(ctx.cwd, advanced);

		// Advisory: warn if the orchestrator is not on a 1M-context model.
		const usage =
			typeof (ctx as { getContextUsage?: () => { contextWindow?: number } | undefined }).getContextUsage === "function"
				? (ctx as { getContextUsage: () => { contextWindow?: number } | undefined }).getContextUsage()
				: undefined;
		const warning = orchestratorContextWarning(usage?.contextWindow);
		if (warning && ctx.hasUI) ctx.ui.notify(warning, "warning");

		const prompt = buildResumePrompt(advanced, decision.mode);

		// "auto" → trigger an autonomous turn; "draft" → deliver a non-triggering
		// followUp the operator reviews and submits.
		pi.sendMessage(
			{
				customType: "autopilot-resume",
				content: prompt,
				display: true,
				attribution: "agent",
			},
			{ triggerTurn: decision.mode === "auto", deliverAs: "followUp" },
		);

		if (ctx.hasUI) {
			ctx.ui.setStatus("autopilot", decision.mode === "auto" ? "autopilot:auto" : "autopilot:draft");
			ctx.ui.notify(
				decision.mode === "auto"
					? "Autopilot armed — resuming mission autonomously."
					: "Autopilot draft ready — review and submit to resume.",
				"info",
			);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		await armBoundary(`start:${ctx.sessionManager.getSessionId()}`, ctx);
	});

	pi.on("session_switch", async (event, ctx) => {
		// Only re-arm for fresh continuations (auto-handoff / /handoff create a
		// "new" session); resuming an old thread is left to the operator.
		if ((event as { reason?: string }).reason !== "new") return;
		await armBoundary(`switch:${ctx.sessionManager.getSessionId()}`, ctx);
	});

	// 3) Operator control surface.
	pi.registerCommand("autopilot", {
		description: "Cross-session autonomous mission control (set/auto/show/pause/resume/stop)",
		handler: async (args: string, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			const objective = rest.join(" ").trim();
			const cwd = ctx.cwd;
			const notify = (msg: string, level: "info" | "warning" | "error" = "info") =>
				ctx.hasUI ? ctx.ui.notify(msg, level) : undefined;

			const transition = (t: MissionTransition, label: string): void => {
				const m = readMission(cwd);
				if (!m) return notify("No autopilot mission set. Use /autopilot set <objective>.", "error");
				try {
					writeMission(cwd, applyTransition(m, t, Date.now));
					notify(`Autopilot mission ${label}.`);
				} catch (err) {
					notify(`autopilot: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			};

			switch (sub) {
				case "set":
				case "auto": {
					if (!objective) return notify(`Usage: /autopilot ${sub} <objective>`, "error");
					const mission = createMission({ objective, autoContinue: sub === "auto" }, Date.now);
					writeMission(cwd, mission);
					notify(
						sub === "auto"
							? "Autopilot mission set (FULL AUTONOMY). It will auto-resume across handoffs and restarts."
							: "Autopilot mission set (draft mode). It will draft a resume prompt at each boundary.",
					);
					// Also seed the native goal now so this session is autonomous immediately.
					pi.sendMessage(
						{
							customType: "autopilot-seed",
							content: buildResumePrompt(mission, mission.autoContinue ? "auto" : "draft"),
							display: true,
							attribution: "agent",
						},
						{ triggerTurn: mission.autoContinue, deliverAs: "followUp" },
					);
					return;
				}
				case "pause":
					return transition("pause", "paused");
				case "resume":
					return transition("resume", "resumed");
				case "stop":
				case "drop":
					return transition("drop", "stopped");
				case "done":
				case "complete":
					return transition("complete", "completed");
				default: {
					const m = readMission(cwd);
					if (!m) return notify("No autopilot mission. Use /autopilot set <objective> or /autopilot auto <objective>.");
					return notify(
						`Autopilot: "${m.objective}" — ${m.status}${m.autoContinue ? " (auto)" : " (draft)"}, spanned ${m.sessionCount} boundary(ies).`,
					);
				}
			}
		},
	});
}
