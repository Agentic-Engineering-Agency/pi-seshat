/**
 * Cross-provider fallback chain — config loading.
 *
 * SpecSafe slice: SPEC-20260426-007 — cross-provider-fallback
 *
 * Reads the `extensions.fallback-chain` block from a parsed
 * `~/.pi/agent/models.json` object and resolves the chain for a given
 * call (per-Ghola env override via PI_FALLBACK_CHAIN takes precedence).
 */

import type { ChainLink } from "./chain.ts";

export interface FallbackConfig {
	chains: Record<string, ChainLink[]>;
	logFile: string;
}

const DEFAULT_LOG_FILE = ".pi/.fallback-log.jsonl";

function isObject(x: unknown): x is Record<string, unknown> {
	return x !== null && typeof x === "object" && !Array.isArray(x);
}

function validateLink(raw: unknown, ctx: string): ChainLink {
	if (!isObject(raw)) {
		throw new Error(`fallback-chain: ${ctx} must be an object with provider+model`);
	}
	const provider = raw.provider;
	const model = raw.model;
	if (typeof provider !== "string" || provider.length === 0) {
		throw new Error(`fallback-chain: ${ctx} missing/invalid 'provider'`);
	}
	if (typeof model !== "string" || model.length === 0) {
		throw new Error(`fallback-chain: ${ctx} missing/invalid 'model'`);
	}
	return { provider, model };
}

export function parseConfig(modelsJson: unknown): FallbackConfig {
	if (!isObject(modelsJson)) {
		return { chains: {}, logFile: DEFAULT_LOG_FILE };
	}
	const ext = modelsJson.extensions;
	if (!isObject(ext)) {
		return { chains: {}, logFile: DEFAULT_LOG_FILE };
	}
	const block = ext["fallback-chain"];
	if (!isObject(block)) {
		return { chains: {}, logFile: DEFAULT_LOG_FILE };
	}

	const rawChains = block.chains;
	const chains: Record<string, ChainLink[]> = {};
	if (isObject(rawChains)) {
		for (const [name, links] of Object.entries(rawChains)) {
			if (!Array.isArray(links)) {
				throw new Error(`fallback-chain: chains.${name} must be an array`);
			}
			if (links.length === 0) {
				throw new Error(`fallback-chain: chains.${name} must be non-empty`);
			}
			chains[name] = links.map((link, i) => validateLink(link, `chains.${name}[${i}]`));
		}
	}

	const logFile = typeof block.logFile === "string" && block.logFile.length > 0 ? block.logFile : DEFAULT_LOG_FILE;

	return { chains, logFile };
}

export interface ResolveChainArgs {
	config: FallbackConfig;
	chainName: string;
	env: Record<string, string | undefined>;
}

function parseEnvChain(value: string): ChainLink[] {
	const parts = value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (parts.length === 0) {
		throw new Error("PI_FALLBACK_CHAIN: empty after parsing");
	}
	return parts.map((pair, i) => {
		const slash = pair.indexOf("/");
		if (slash <= 0 || slash === pair.length - 1) {
			throw new Error(`PI_FALLBACK_CHAIN: entry #${i} '${pair}' is not a 'provider/model' pair`);
		}
		const provider = pair.slice(0, slash).trim();
		const model = pair.slice(slash + 1).trim();
		if (!provider || !model) {
			throw new Error(`PI_FALLBACK_CHAIN: entry #${i} '${pair}' is malformed`);
		}
		return { provider, model };
	});
}

export function resolveChain(args: ResolveChainArgs): ChainLink[] {
	const override = args.env.PI_FALLBACK_CHAIN;
	if (typeof override === "string" && override.length > 0) {
		return parseEnvChain(override);
	}
	const chain = args.config.chains[args.chainName];
	if (!chain) {
		throw new Error(`fallback-chain: no chain named '${args.chainName}' in config`);
	}
	return chain;
}
