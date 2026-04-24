import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import { statePathFor } from "../specsafe-session/index.ts";

// ---------------------------------------------------------------------------
// SpecSafe integration helpers (SPEC-20260424-001).
// Exported so unit tests can exercise them without standing up a Pi subprocess.
// ---------------------------------------------------------------------------

type SpecsafeStateSnapshot = {
	currentSlice: {
		id: string;
		workspaceId: string;
		sessionId: string;
	} | null;
} | null;

/**
 * Build the environment the child pi process inherits.
 *
 * Always sets HONCHO_PEER_ID (the child's identity). When a slice is open,
 * also threads workspace/session/slice IDs through. The parent's API key
 * passes through via the spread of `parent`.
 */
export function buildChildEnv(
	parent: NodeJS.ProcessEnv,
	state: { currentSlice: { id: string; workspaceId: string; sessionId: string } | null } | null,
	agentName: string,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...parent, HONCHO_PEER_ID: agentName };
	const slice = state?.currentSlice;
	if (slice) {
		env.HONCHO_WORKSPACE_ID = slice.workspaceId;
		env.HONCHO_SESSION_ID = slice.sessionId;
		env.SPECSAFE_SLICE_ID = slice.id;
	}
	return env;
}

function readSpecsafeState(cwd: string): SpecsafeStateSnapshot {
	const sp = statePathFor(cwd);
	try {
		if (!fs.existsSync(sp)) return null;
		return JSON.parse(fs.readFileSync(sp, "utf-8")) as SpecsafeStateSnapshot;
	} catch {
		return null;
	}
}

/**
 * Commit any dirty working-tree changes with structured trailers attributing
 * the commit to the subagent. No-op when tree is clean or cwd isn't a repo.
 */
export async function commitSubagentWork(opts: {
	cwd: string;
	agent: string;
	sliceId: string;
	sessionId: string;
	message: string;
}): Promise<{ committed: boolean; error?: string }> {
	const repoCheck = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd: opts.cwd,
		encoding: "utf-8",
	});
	if (repoCheck.status !== 0) {
		return { committed: false, error: `not a git repo: ${repoCheck.stderr.trim() || "unknown"}` };
	}
	const porcelain = spawnSync("git", ["status", "--porcelain"], { cwd: opts.cwd, encoding: "utf-8" });
	if (porcelain.status !== 0) {
		return { committed: false, error: `git status failed: ${porcelain.stderr}` };
	}
	if (porcelain.stdout.trim().length === 0) {
		return { committed: false };
	}
	const addRes = spawnSync("git", ["add", "-A"], { cwd: opts.cwd, encoding: "utf-8" });
	if (addRes.status !== 0) {
		return { committed: false, error: `git add failed: ${addRes.stderr}` };
	}
	const firstLine = (opts.message || "work").split("\n")[0]!.trim();
	const clipped = firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine;
	const subject = `${opts.agent}: ${clipped}`;
	const commitRes = spawnSync(
		"git",
		[
			"commit",
			"-m",
			subject,
			"--trailer",
			`Co-Authored-By: ${opts.agent} <${opts.agent}@seshat.local>`,
			"--trailer",
			`Spec-Slice: ${opts.sliceId}`,
			"--trailer",
			`Peer: ${opts.agent}`,
			"--trailer",
			`Session: ${opts.sessionId}`,
		],
		{ cwd: opts.cwd, encoding: "utf-8" },
	);
	if (commitRes.status !== 0) {
		return { committed: false, error: `git commit failed: ${commitRes.stderr}` };
	}
	return { committed: true };
}

function summarizeForCommit(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m || m.role !== "assistant") continue;
		const content = m.content as unknown;
		if (typeof content === "string") {
			const firstLine = content.trim().split("\n")[0] ?? "";
			if (firstLine) return firstLine.slice(0, 160);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (typeof part !== "object" || part === null) continue;
			const asText = part as { type?: string; text?: string };
			if (asText.type === "text" && typeof asText.text === "string" && asText.text.trim()) {
				return (asText.text.trim().split("\n")[0] ?? "").slice(0, 160) || "work in progress";
			}
		}
	}
	return "work in progress";
}

type UsageStats = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
};

type AgentRunResult = {
	agent: string;
	source: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	stderr: string;
	messages: Message[];
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
};

const TaskItem = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	task: Type.String({ description: "Task for that agent" }),
	cwd: Type.Optional(Type.String({ description: "Optional working directory for that run" })),
});

const ScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: "Where to discover agent markdown files.",
	default: "project",
});

const ParamsSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Single-agent mode: agent name" })),
	task: Type.Optional(Type.String({ description: "Single-agent mode: task" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel-agent mode" })),
	chain: Type.Optional(Type.Array(TaskItem, { description: "Sequential-agent mode" })),
	agentScope: Type.Optional(ScopeSchema),
	cwd: Type.Optional(Type.String({ description: "Single-agent mode cwd override" })),
});

function makeUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");

	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: "pi", args };
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-specsafe-agent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `${safeName}.md`);

	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});

	return { dir, filePath };
}

function extractFinalText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || message.role !== "assistant") continue;
		const content = message.content as unknown;
		if (typeof content === "string") {
			if (content.trim()) return content.trim();
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (typeof part !== "object" || part === null) continue;
			const asText = part as { type?: string; text?: string };
			if (asText.type === "text" && typeof asText.text === "string" && asText.text.trim()) {
				return asText.text.trim();
			}
		}
	}
	return "";
}

async function runAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	signal?: AbortSignal,
): Promise<AgentRunResult> {
	const agent = agents.find((entry) => entry.name === agentName);

	if (!agent) {
		return {
			agent: agentName,
			source: "unknown",
			task,
			exitCode: 1,
			stderr: `Unknown agent "${agentName}"`,
			messages: [],
			usage: makeUsage(),
		};
	}

	const args = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpDir: string | null = null;
	let tmpPromptPath: string | null = null;

	try {
		if (agent.systemPrompt) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);

		const result: AgentRunResult = {
			agent: agent.name,
			source: agent.source,
			task,
			exitCode: 0,
			stderr: "",
			messages: [],
			usage: makeUsage(),
			model: agent.model,
		};

		const runCwd = cwd ?? defaultCwd;
		const specsafeState = readSpecsafeState(defaultCwd);
		const childEnv = buildChildEnv(process.env, specsafeState, agent.name);

		result.exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: runCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnv,
			});

			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;

				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type !== "message_end" || !event.message) return;

				const message = event.message as Message;
				result.messages.push(message);

				if (message.role !== "assistant") return;
				result.usage.turns += 1;

				if (message.usage) {
					result.usage.input += message.usage.input || 0;
					result.usage.output += message.usage.output || 0;
					result.usage.cacheRead += message.usage.cacheRead || 0;
					result.usage.cacheWrite += message.usage.cacheWrite || 0;
					result.usage.cost += message.usage.cost?.total || 0;
					result.usage.contextTokens = message.usage.totalTokens || 0;
				}

				if (!result.model && message.model) result.model = message.model;
				if (message.stopReason) result.stopReason = message.stopReason;
				if (message.errorMessage) result.errorMessage = message.errorMessage;
			};

			proc.stdout.on("data", (chunk) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (chunk) => {
				result.stderr += chunk.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			if (signal) {
				const abort = () => proc.kill("SIGTERM");
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			}
		});

		// SpecSafe auto-commit: only on success, only when a slice is open.
		if (result.exitCode === 0 && specsafeState?.currentSlice) {
			try {
				await commitSubagentWork({
					cwd: runCwd,
					agent: agent.name,
					sliceId: specsafeState.currentSlice.id,
					sessionId: specsafeState.currentSlice.sessionId,
					message: summarizeForCommit(result.messages),
				});
			} catch (err) {
				result.stderr += `\n[auto-commit] ${err instanceof Error ? err.message : String(err)}`;
			}
		}

		return result;
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {}
		}
		if (tmpDir) {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {}
		}
	}
}

function summarizeRun(result: AgentRunResult): string {
	const finalText = extractFinalText(result.messages) || result.stderr || "(no output)";
	const preview = finalText.length > 400 ? `${finalText.slice(0, 400)}...` : finalText;
	const status = result.exitCode === 0 ? "ok" : "failed";
	return `[${result.agent}] ${status}\n${preview}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate work to specialized agents defined as markdown files. Supports single, parallel, and chain execution.",
		parameters: ParamsSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "project";
			const baseCwd = ctx.cwd;
			const agents = discoverAgents(baseCwd, agentScope);

			const single = Boolean(params.agent && params.task);
			const parallel = (params.tasks?.length ?? 0) > 0;
			const chain = (params.chain?.length ?? 0) > 0;
			const modeCount = Number(single) + Number(parallel) + Number(chain);

			if (modeCount !== 1) {
				const available = agents.map((agent) => agent.name).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Provide exactly one of agent/task, tasks, or chain. Available agents: ${available}` }],
					details: { agentScope, runs: [] },
					isError: true,
				};
			}

			if (single && params.agent && params.task) {
				const run = await runAgent(baseCwd, agents, params.agent, params.task, params.cwd, signal);
				return {
					content: [{ type: "text", text: summarizeRun(run) }],
					details: { agentScope, runs: [run] },
					isError: run.exitCode !== 0,
				};
			}

			if (parallel && params.tasks) {
				const runs = await Promise.all(
					params.tasks.map((entry) => runAgent(baseCwd, agents, entry.agent, entry.task, entry.cwd, signal)),
				);

				return {
					content: [{ type: "text", text: runs.map(summarizeRun).join("\n\n") }],
					details: { agentScope, runs },
				};
			}

			const runs: AgentRunResult[] = [];
			let previous = "";

			for (const step of params.chain || []) {
				const task = step.task.replace(/\{previous\}/g, previous);
				const run = await runAgent(baseCwd, agents, step.agent, task, step.cwd, signal);
				runs.push(run);

				if (run.exitCode !== 0) {
					return {
						content: [{ type: "text", text: runs.map(summarizeRun).join("\n\n") }],
						details: { agentScope, runs },
						isError: true,
					};
				}

				previous = extractFinalText(run.messages);
			}

			return {
				content: [{ type: "text", text: runs.map(summarizeRun).join("\n\n") }],
				details: { agentScope, runs },
			};
		},
	});
}
