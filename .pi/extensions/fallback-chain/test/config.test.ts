/**
 * Tests for fallback-chain config loading and per-Ghola env override.
 *
 * SpecSafe slice: SPEC-20260426-007 — cross-provider-fallback
 * Covers AC 8 (configuration round-trip) and AC 9 (per-Ghola env override).
 *
 * Imports of the not-yet-implemented module are deferred at runtime so
 * `bun run typecheck` passes for the rest of the codebase. `bun test` will
 * fail until the implementer creates ../config.ts — that's the TDD red.
 */

import { describe, expect, test } from "bun:test";

interface ChainLink {
	provider: string;
	model: string;
}

interface FallbackConfig {
	chains: Record<string, ChainLink[]>;
	logFile: string;
}

interface ParseConfigFn {
	(modelsJson: unknown): FallbackConfig;
}

interface ResolveChainArgs {
	config: FallbackConfig;
	chainName: string;
	env: Record<string, string | undefined>;
}

interface ResolveChainFn {
	(args: ResolveChainArgs): ChainLink[];
}

async function loadConfigModule(): Promise<{
	parseConfig: ParseConfigFn;
	resolveChain: ResolveChainFn;
}> {
	// Dynamic import via runtime-computed specifier — see chain.test.ts.
	const spec = "../config.ts";
	// biome-ignore lint/suspicious/noExplicitAny: deferred import shim
	const mod = (await import(/* @vite-ignore */ spec)) as any;
	return { parseConfig: mod.parseConfig, resolveChain: mod.resolveChain };
}

const sampleModelsJson = {
	extensions: {
		"fallback-chain": {
			chains: {
				default: [
					{ provider: "anthropic", model: "claude-opus-4-7" },
					{ provider: "openai", model: "gpt-5.5" },
					{ provider: "google", model: "gemini-2.5-pro" },
				],
				cheap: [
					{ provider: "openai", model: "gpt-5-mini" },
					{ provider: "google", model: "gemini-2.5-flash" },
				],
			},
			logFile: ".pi/.fallback-log.jsonl",
		},
	},
};

describe("[unit] parseConfig — AC 8 round-trip", () => {
	test("AC8: parseConfig reads chains map from models.json shape", async () => {
		const { parseConfig } = await loadConfigModule();
		const cfg = parseConfig(sampleModelsJson);
		expect(Object.keys(cfg.chains).sort()).toEqual(["cheap", "default"]);
		expect(cfg.chains.default).toHaveLength(3);
		expect(cfg.chains.default?.[0]).toEqual({ provider: "anthropic", model: "claude-opus-4-7" });
		expect(cfg.chains.cheap).toHaveLength(2);
		expect(cfg.logFile).toBe(".pi/.fallback-log.jsonl");
	});

	test("AC8: missing extensions.fallback-chain returns empty chains map (graceful)", async () => {
		const { parseConfig } = await loadConfigModule();
		const cfg = parseConfig({});
		expect(cfg.chains).toEqual({});
	});

	test("AC8: malformed chain entries are rejected with a clear error", async () => {
		const { parseConfig } = await loadConfigModule();
		expect(() =>
			parseConfig({
				extensions: {
					"fallback-chain": {
						chains: {
							bad: [{ provider: "anthropic" }], // missing model
						},
					},
				},
			}),
		).toThrow();
	});
});

describe("[unit] resolveChain — AC 9 per-Ghola override", () => {
	test("AC9: with no env, returns the configured chain by name", async () => {
		const { parseConfig, resolveChain } = await loadConfigModule();
		const cfg = parseConfig(sampleModelsJson);
		const chain = resolveChain({ config: cfg, chainName: "default", env: {} });
		expect(chain).toEqual([
			{ provider: "anthropic", model: "claude-opus-4-7" },
			{ provider: "openai", model: "gpt-5.5" },
			{ provider: "google", model: "gemini-2.5-pro" },
		]);
	});

	test("AC9: PI_FALLBACK_CHAIN env var replaces chain for one call", async () => {
		const { parseConfig, resolveChain } = await loadConfigModule();
		const cfg = parseConfig(sampleModelsJson);
		const chain = resolveChain({
			config: cfg,
			chainName: "default",
			env: { PI_FALLBACK_CHAIN: "moonshot/kimi-k2.6,google/gemini-2.5-flash" },
		});
		expect(chain).toEqual([
			{ provider: "moonshot", model: "kimi-k2.6" },
			{ provider: "google", model: "gemini-2.5-flash" },
		]);
	});

	test("AC9: removed env reverts to the configured chain on the next call", async () => {
		const { parseConfig, resolveChain } = await loadConfigModule();
		const cfg = parseConfig(sampleModelsJson);
		const overridden = resolveChain({
			config: cfg,
			chainName: "default",
			env: { PI_FALLBACK_CHAIN: "x/x,y/y" },
		});
		expect(overridden).toEqual([
			{ provider: "x", model: "x" },
			{ provider: "y", model: "y" },
		]);
		const reverted = resolveChain({ config: cfg, chainName: "default", env: {} });
		expect(reverted[0]).toEqual({ provider: "anthropic", model: "claude-opus-4-7" });
	});

	test("AC9: malformed PI_FALLBACK_CHAIN throws a clear error (no silent fallthrough)", async () => {
		const { parseConfig, resolveChain } = await loadConfigModule();
		const cfg = parseConfig(sampleModelsJson);
		expect(() =>
			resolveChain({
				config: cfg,
				chainName: "default",
				env: { PI_FALLBACK_CHAIN: "not-a-valid-pair" },
			}),
		).toThrow();
	});

	test("AC9: empty PI_FALLBACK_CHAIN is treated as unset (use configured chain)", async () => {
		const { parseConfig, resolveChain } = await loadConfigModule();
		const cfg = parseConfig(sampleModelsJson);
		const chain = resolveChain({
			config: cfg,
			chainName: "default",
			env: { PI_FALLBACK_CHAIN: "" },
		});
		expect(chain[0]).toEqual({ provider: "anthropic", model: "claude-opus-4-7" });
	});

	test("AC9: unknown chainName without env override throws", async () => {
		const { parseConfig, resolveChain } = await loadConfigModule();
		const cfg = parseConfig(sampleModelsJson);
		expect(() => resolveChain({ config: cfg, chainName: "nonexistent", env: {} })).toThrow();
	});
});
