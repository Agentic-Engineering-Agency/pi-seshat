import { spawnSync } from "node:child_process";
import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const PANE_ID_RE = /^w[A-Za-z0-9]+:p\d+$/;

type TextResult = AgentToolResult<{ command: string[]; stdout?: string; stderr?: string; exitCode?: number }>;

function validatePaneId(paneId: string): string | undefined {
	return PANE_ID_RE.test(paneId) ? undefined : `invalid Herdr pane id: ${paneId} (expected wX:pN)`;
}

function runHerdr(args: string[]): TextResult {
	const result = spawnSync("herdr", args, { encoding: "utf-8" });
	const stdout = result.stdout.trim();
	const stderr = result.stderr.trim();
	if (result.status !== 0) {
		return {
			content: [{ type: "text", text: stderr || stdout || `herdr exited ${result.status}` }],
			details: { command: ["herdr", ...args], stdout, stderr, exitCode: result.status ?? 1 },
		};
	}
	return {
		content: [{ type: "text", text: stdout || "OK" }],
		details: { command: ["herdr", ...args], stdout, stderr, exitCode: 0 },
	};
}

export default function (pi: ExtensionAPI): void {
	const { Type } = pi.typebox;

	pi.registerTool({
		name: "herdr_send",
		label: "Herdr send",
		description: "Send literal text to a Herdr pane by colon-form pane id (for example w1:p1 or wB:p1).",
		promptSnippet: "herdr_send(target_pane, message) sends text to a Herdr pane; Enter is not appended.",
		parameters: Type.Object({
			target_pane: Type.String({ description: "Herdr pane id, e.g. w1:p1 or wB:p1" }),
			message: Type.String({ description: "Literal text to send; Enter is not appended" }),
		}),
		async execute(_toolCallId, params): Promise<TextResult> {
			const error = validatePaneId(params.target_pane);
			if (error) return { content: [{ type: "text", text: error }], details: { command: [], exitCode: 1 } };
			return runHerdr(["pane", "send-text", params.target_pane, params.message]);
		},
	});

	pi.registerTool({
		name: "herdr_read",
		label: "Herdr read",
		description: "Read text from a Herdr pane by colon-form pane id (for example w1:p1 or wB:p1).",
		promptSnippet: "herdr_read(target_pane, lines?) reads a Herdr pane.",
		parameters: Type.Object({
			target_pane: Type.String({ description: "Herdr pane id, e.g. w1:p1 or wB:p1" }),
			lines: Type.Optional(Type.Number({ minimum: 1, maximum: 500, description: "Recent line count" })),
		}),
		async execute(_toolCallId, params): Promise<TextResult> {
			const error = validatePaneId(params.target_pane);
			if (error) return { content: [{ type: "text", text: error }], details: { command: [], exitCode: 1 } };
			const args = ["pane", "read", params.target_pane, "--format", "text"];
			if (params.lines !== undefined) args.push("--lines", String(params.lines));
			return runHerdr(args);
		},
	});

	pi.registerTool({
		name: "herdr_enter",
		label: "Herdr enter",
		description: "Send Enter to a Herdr pane by colon-form pane id (for example w1:p1 or wB:p1).",
		promptSnippet: "herdr_enter(target_pane) presses Enter in a Herdr pane.",
		parameters: Type.Object({
			target_pane: Type.String({ description: "Herdr pane id, e.g. w1:p1 or wB:p1" }),
		}),
		async execute(_toolCallId, params): Promise<TextResult> {
			const error = validatePaneId(params.target_pane);
			if (error) return { content: [{ type: "text", text: error }], details: { command: [], exitCode: 1 } };
			return runHerdr(["pane", "send-keys", params.target_pane, "enter"]);
		},
	});

	pi.registerTool({
		name: "herdr_panes",
		label: "Herdr panes",
		description: "List Herdr panes using `herdr pane list`.",
		promptSnippet: "herdr_panes() lists Herdr panes.",
		parameters: Type.Object({}),
		async execute(): Promise<TextResult> {
			return runHerdr(["pane", "list"]);
		},
	});
}
