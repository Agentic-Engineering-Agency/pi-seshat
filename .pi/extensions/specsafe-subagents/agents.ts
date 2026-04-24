import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];

	const agents: AgentConfig[] = [];
	const entries = fs.readdirSync(dir, { withFileTypes: true });

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		const content = fs.readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body.trim(),
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let current = cwd;

	while (true) {
		const candidate = path.join(current, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentConfig[] {
	const userDir = path.join(getAgentDir(), "agents");
	const projectDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectDir ? [] : loadAgentsFromDir(projectDir, "project");

	const merged = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) merged.set(agent.name, agent);
		for (const agent of projectAgents) merged.set(agent.name, agent);
	} else {
		for (const agent of [...userAgents, ...projectAgents]) merged.set(agent.name, agent);
	}

	return [...merged.values()];
}
