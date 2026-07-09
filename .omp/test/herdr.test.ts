import { describe, expect, test } from "bun:test";

import { detectHerdrState, readHerdrStateFromEnv } from "../hooks/herdr-session-init";

describe("[unit] herdr session init", () => {
	test("reads colon-form pane identity from Herdr env", () => {
		const state = readHerdrStateFromEnv({
			HERDR_ENV: "1",
			HERDR_SESSION: "fleet",
			HERDR_WORKSPACE_ID: "wB",
			HERDR_TAB_ID: "wB:t2",
			HERDR_PANE_ID: "wB:p2",
			HERDR_SOCKET_PATH: "/tmp/herdr.sock",
		});

		expect(state).toMatchObject({
			sessionId: "fleet",
			workspaceId: "wB",
			tabId: "wB:t2",
			paneId: "wB:p2",
			socketPath: "/tmp/herdr.sock",
			detectedBy: "env",
		});
	});

	test("rejects slash-form pane ids", () => {
		expect(readHerdrStateFromEnv({ HERDR_PANE_ID: "default/1/2" })).toBeNull();
	});

	test("detects CLI-only Herdr context", () => {
		const state = detectHerdrState({ PATH: process.env.PATH, HERDR_SESSION: "default" });

		expect(state).toMatchObject({ sessionId: "default", detectedBy: "cli" });
	});
});
