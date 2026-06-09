/**
 * autopilot — pure logic for cross-session autonomous mission continuation.
 *
 * Seshat v2, slice v2.8. This module is intentionally free of any
 * `@oh-my-pi/*` import so it can be unit-tested without the omp runtime
 * present (mirrors the peer-policy / buildHonchoTools pure-factory pattern).
 *
 * ── What omp already does natively (verified in installed source) ──────────
 *   • Goal Mode (src/goals/runtime.ts, `/goal set`): a per-session autonomous
 *     objective that auto-continues between turns until complete, with an
 *     optional token budget.
 *   • Auto-handoff (compaction.strategy="handoff" + thresholdPercent): at the
 *     context threshold omp generates a handoff document, saves it to the
 *     session artifacts dir (compaction.handoffSaveToDisk), injects it as a
 *     <handoff-context> message, and continues in a NEW in-process session
 *     (compaction.autoContinue).
 *
 * ── The gap this module fills (verified) ───────────────────────────────────
 *   GoalRuntime.onThreadResumed() (runtime.ts:274-285) DELIBERATELY pauses an
 *   active goal whenever a session is resumed or switched. So after an
 *   auto-handoff (new in-process session) OR a process restart, the autonomous
 *   loop stops — the goal must be manually `/goal resume`d. Extensions receive
 *   only the read-only `goal_updated` event; there is no programmatic
 *   resume API, and native goal persistence is session-scoped (not portable
 *   across a fresh `omp` process).
 *
 *   Autopilot bridges that boundary: it mirrors the goal to a portable,
 *   git-trackable file (`.omp/.autopilot.json`) and, at each session boundary,
 *   decides whether to re-arm the autonomous loop by steering the orchestrator
 *   to re-establish its native goal — using the handoff document as context.
 *
 * Consumed by:
 *   - .omp/hooks/autopilot.ts        (the runtime wiring)
 *   - .omp/skills/autopilot/bin/...  (the operator CLI)
 *   - .omp/test/autopilot.test.ts    (unit tests)
 */

/** Lifecycle status of an autopilot mission. Mirrors omp's GoalStatus plus a
 *  portable "active" baseline. `complete`/`dropped` are terminal. */
export type AutopilotStatus = "active" | "paused" | "complete" | "dropped";

/** The portable, on-disk mission record. Schema-versioned so future changes
 *  can migrate rather than silently corrupt. */
export interface AutopilotMission {
	/** Schema version of this record. */
	version: 1;
	/** The autonomous objective the orchestrator pursues across sessions. */
	objective: string;
	status: AutopilotStatus;
	/**
	 * Full autonomy switch. When false (default), autopilot only drafts a
	 * resume prompt at session boundaries and waits for the operator to submit
	 * — a deliberate safety gate. When true, autopilot steers the orchestrator
	 * to auto-continue without human input.
	 */
	autoContinue: boolean;
	/** Optional token budget mirrored onto the native goal when re-armed. */
	tokenBudget?: number;
	/** Monotonic count of session boundaries this mission has spanned. */
	sessionCount: number;
	createdAt: string;
	updatedAt: string;
}

export const TERMINAL_STATUSES: ReadonlySet<AutopilotStatus> = new Set(["complete", "dropped"]);

/** Default orchestrator context-window floor (tokens). The orchestrator should
 *  run a 1M-context model so the 70% handoff trigger leaves ample working room;
 *  below this we warn (advisory — never blocks). */
export const ORCHESTRATOR_MIN_CONTEXT_WINDOW = 1_000_000;

/** Recommended auto-handoff trigger as a fraction of the context window. */
export const DEFAULT_HANDOFF_PERCENT = 70;

export function nowIso(now: () => number = Date.now): string {
	return new Date(now()).toISOString();
}

/** Pure: construct a fresh mission record. Throws on empty objective. */
export function createMission(
	input: { objective: string; autoContinue?: boolean; tokenBudget?: number },
	now: () => number = Date.now,
): AutopilotMission {
	const objective = input.objective.trim();
	if (!objective) throw new Error("objective is required");
	if (input.tokenBudget !== undefined && (!Number.isInteger(input.tokenBudget) || input.tokenBudget <= 0)) {
		throw new Error("tokenBudget must be a positive integer when provided");
	}
	const ts = nowIso(now);
	return {
		version: 1,
		objective,
		status: "active",
		autoContinue: input.autoContinue ?? false,
		tokenBudget: input.tokenBudget,
		sessionCount: 0,
		createdAt: ts,
		updatedAt: ts,
	};
}

export type MissionTransition = "pause" | "resume" | "complete" | "drop";

/** Pure: apply a lifecycle transition, returning a new record. Throws when the
 *  transition is illegal from the current status. */
export function applyTransition(
	mission: AutopilotMission,
	transition: MissionTransition,
	now: () => number = Date.now,
): AutopilotMission {
	if (TERMINAL_STATUSES.has(mission.status)) {
		throw new Error(`mission is ${mission.status}; no further transitions are allowed`);
	}
	const next: AutopilotMission = { ...mission, updatedAt: nowIso(now) };
	switch (transition) {
		case "pause":
			next.status = "paused";
			return next;
		case "resume":
			next.status = "active";
			return next;
		case "complete":
			next.status = "complete";
			return next;
		case "drop":
			next.status = "dropped";
			return next;
		default:
			throw new Error(`unknown transition '${transition as string}'`);
	}
}

/** Pure: reconcile the portable mission with a native goal_updated event so the
 *  two stay in sync. The native goal is the source of truth for status while a
 *  session is live; autopilot mirrors it to disk. Returns the updated record
 *  (or a newly created one if none existed and the goal is live). */
export function reconcileWithGoal(
	mission: AutopilotMission | null,
	goal: { objective: string; status: string; tokenBudget?: number } | null,
	now: () => number = Date.now,
): AutopilotMission | null {
	// Goal dropped/absent: keep the portable mission as-is (operator may still
	// want to resume it later) unless it never existed.
	if (!goal) return mission;

	const mapped: AutopilotStatus =
		goal.status === "active"
			? "active"
			: goal.status === "complete"
				? "complete"
				: goal.status === "dropped"
					? "dropped"
					: "paused"; // paused | budget-limited → paused

	if (!mission) {
		// A native goal appeared with no portable mirror (operator used /goal
		// directly). Adopt it so autopilot can carry it across the next boundary.
		const created = createMission({ objective: goal.objective, tokenBudget: goal.tokenBudget }, now);
		return { ...created, status: mapped };
	}

	return {
		...mission,
		objective: goal.objective || mission.objective,
		tokenBudget: goal.tokenBudget ?? mission.tokenBudget,
		status: mapped,
		updatedAt: nowIso(now),
	};
}

export type ArmDecision =
	| { arm: false; reason: string }
	| { arm: true; mode: "auto" | "draft"; mission: AutopilotMission };

/**
 * Pure: decide whether — and how — to re-arm the autonomous loop at a session
 * boundary (session_start on a fresh process, or session_switch reason="new"
 * after an auto-handoff).
 *
 * - No mission, or a terminal mission → do not arm.
 * - `autoContinue` true  → arm in "auto" mode (steer the orchestrator to
 *   re-establish its goal and keep working with no human input).
 * - `autoContinue` false → arm in "draft" mode (surface a resume prompt for the
 *   operator to review and submit).
 *
 * `alreadyArmedThisSession` guards against double-firing when both session_start
 * and session_switch land for the same logical boundary.
 */
export function decideArm(
	mission: AutopilotMission | null,
	opts: { alreadyArmedThisSession: boolean },
): ArmDecision {
	if (!mission) return { arm: false, reason: "no mission" };
	if (TERMINAL_STATUSES.has(mission.status)) return { arm: false, reason: `mission is ${mission.status}` };
	if (opts.alreadyArmedThisSession) return { arm: false, reason: "already armed this session" };
	return { arm: true, mode: mission.autoContinue ? "auto" : "draft", mission };
}

/**
 * Pure: build the steering prompt injected at a session boundary to re-arm the
 * native goal. The orchestrator reads the handoff `<handoff-context>` (already
 * injected by omp) plus durable STATE.md, then re-establishes goal mode via its
 * native `goal` tool and continues. Kept self-contained so the new session can
 * proceed without the prior conversation.
 */
export function buildResumePrompt(mission: AutopilotMission, mode: "auto" | "draft"): string {
	const budgetLine =
		mission.tokenBudget !== undefined ? `\n- Token budget to re-arm on the goal: ${mission.tokenBudget}` : "";
	const header =
		mode === "auto"
			? "## AUTOPILOT — autonomous mission resume\n\nThis session is a continuation of an ongoing autonomous mission. Continue WITHOUT waiting for further human input."
			: "## AUTOPILOT — mission resume (review & submit)\n\nThis is a draft to resume an ongoing mission. Review, then submit to continue.";
	return [
		header,
		"",
		"### Persistent objective",
		mission.objective,
		"",
		"### How to resume",
		"1. Read any `<handoff-context>` above and `STATE.md` for where the prior session left off.",
		"2. Re-establish goal mode for this objective using your native `goal` tool (op=create) so the autonomous loop and token accounting continue across this boundary." +
			budgetLine,
		"3. Resume the SpecSafe workflow at the recorded phase; do not restart completed slices.",
		"4. When the objective is fully met, mark it done with the `goal` tool (op=complete) and run `/skill:autopilot stop`.",
		"",
		`_Mission spans ${mission.sessionCount} prior session boundary(ies). Updated ${mission.updatedAt}._`,
	].join("\n");
}

/** Advisory check: is the orchestrator running a context window large enough for
 *  the handoff strategy to breathe? Returns a warning string or null. */
export function orchestratorContextWarning(
	contextWindow: number | undefined,
	floor: number = ORCHESTRATOR_MIN_CONTEXT_WINDOW,
): string | null {
	if (contextWindow === undefined || contextWindow <= 0) return null;
	if (contextWindow >= floor) return null;
	return `Orchestrator context window is ${contextWindow.toLocaleString()} tokens (< ${floor.toLocaleString()}). For reliable auto-handoff, run the orchestrator on a 1M-context model.`;
}

/** The recommended omp compaction/goal settings for autonomous operation.
 *  Rendered into `.omp/config.yml` and merged into the global config by the
 *  deploy skill. Kept here (pure) so it is unit-testable and single-sourced. */
export interface AutopilotConfigBlock {
	compaction: {
		enabled: true;
		strategy: "handoff";
		thresholdPercent: number;
		autoContinue: true;
		handoffSaveToDisk: true;
	};
	goal: {
		enabled: true;
		continuationModes: string[];
	};
}

export function autopilotConfigBlock(thresholdPercent: number = DEFAULT_HANDOFF_PERCENT): AutopilotConfigBlock {
	if (!Number.isInteger(thresholdPercent) || thresholdPercent < 10 || thresholdPercent > 95) {
		throw new Error("thresholdPercent must be an integer in 10..95");
	}
	return {
		compaction: {
			enabled: true,
			strategy: "handoff",
			thresholdPercent,
			autoContinue: true,
			handoffSaveToDisk: true,
		},
		goal: {
			enabled: true,
			continuationModes: ["interactive"],
		},
	};
}

/** Pure deep-merge for plain config objects (objects merged recursively, scalars
 *  and arrays overwritten). Used by the deploy skill to fold the autopilot block
 *  into an existing global config.yml WITHOUT clobbering unrelated user keys. */
export function mergeConfig<T extends Record<string, unknown>>(base: T, overlay: Record<string, unknown>): T {
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(overlay)) {
		const existing = out[key];
		if (
			existing &&
			value &&
			typeof existing === "object" &&
			typeof value === "object" &&
			!Array.isArray(existing) &&
			!Array.isArray(value)
		) {
			out[key] = mergeConfig(existing as Record<string, unknown>, value as Record<string, unknown>);
		} else {
			out[key] = value;
		}
	}
	return out as T;
}
