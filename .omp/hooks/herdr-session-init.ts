import { spawnSync } from "node:child_process";
import type { HookAPI } from "@oh-my-pi/pi-coding-agent";

export type HerdrSessionState = {
	sessionId: string;
	workspaceId?: string;
	tabId?: string;
	paneId?: string;
	socketPath?: string;
	detectedAt: string;
	detectedBy: "env" | "cli";
};

const PANE_ID_RE = /^w\d+:p\d+$/;

export function readHerdrStateFromEnv(env: NodeJS.ProcessEnv): HerdrSessionState | null {
	const paneId = env.HERDR_PANE_ID || env.HERDR_PANE;
	if (paneId && !PANE_ID_RE.test(paneId)) return null;
	if (env.HERDR_ENV === "1" || paneId || env.HERDR_SOCKET_PATH || env.HERDR_SESSION) {
		return {
			sessionId: env.HERDR_SESSION || "default",
			workspaceId: env.HERDR_WORKSPACE_ID,
			tabId: env.HERDR_TAB_ID,
			paneId,
			socketPath: env.HERDR_SOCKET_PATH,
			detectedAt: new Date().toISOString(),
			detectedBy: "env",
		};
	}
	return null;
}

export function detectHerdrCli(env: NodeJS.ProcessEnv = process.env): HerdrSessionState | null {
	const current = spawnSync("herdr", [...(env.HERDR_SESSION ? ["--session", env.HERDR_SESSION] : []), "pane", "current"], { encoding: "utf-8" });
	if (current.status === 0) {
		try {
			const pane = JSON.parse(current.stdout)?.result?.pane;
			if (pane?.pane_id && PANE_ID_RE.test(pane.pane_id)) {
				return {
					sessionId: env.HERDR_SESSION || "default",
					workspaceId: pane.workspace_id,
					tabId: pane.tab_id,
					paneId: pane.pane_id,
					detectedAt: new Date().toISOString(),
					detectedBy: "cli",
				};
			}
		} catch {
			// fall through to CLI presence check
		}
	}

	const version = spawnSync("herdr", ["--version"], { encoding: "utf-8" });
	if (version.status !== 0) return null;
	return {
		sessionId: env.HERDR_SESSION || "default",
		detectedAt: new Date().toISOString(),
		detectedBy: "cli",
	};
}

export function detectHerdrState(env: NodeJS.ProcessEnv = process.env): HerdrSessionState | null {
	return readHerdrStateFromEnv(env) ?? detectHerdrCli(env);
}

export function persistHerdrState(state: HerdrSessionState): void {
	process.env.HERDR_SESSION = state.sessionId;
	if (state.paneId) process.env.HERDR_PANE = state.paneId;
}

function statusText(state: HerdrSessionState): string {
	return state.paneId ? `herdr:${state.paneId}` : `herdr:${state.sessionId}`;
}

export default function (pi: HookAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const state = detectHerdrState();
		if (!state) return;

		persistHerdrState(state);
		pi.appendEntry<HerdrSessionState>("herdr-session", state);

		if (ctx.hasUI) {
			ctx.ui.setStatus("herdr", statusText(state));
		}
	});
}
