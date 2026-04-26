/**
 * Cross-provider fallback chain — extension entry point.
 *
 * SpecSafe slice: SPEC-20260426-007 — cross-provider-fallback
 *
 * Registers a synthetic provider `fallback` with one model per
 * configured chain (e.g. `fallback/default`). When that synthetic
 * model is selected, our `streamSimple` walks the chain, falling
 * through pre-stream errors to the next link until one serves the
 * response.
 *
 * Q5 probe finding (lazy resolution timing):
 *   - `pi.registerProvider(...)` runs at extension load (queued; applied
 *     by the runner once bindCore() has run — see
 *     pi-coding-agent/dist/core/extensions/types.d.ts:1042-1046).
 *   - `streamSimple` is invoked later, at the user's call time, which
 *     is well after every other extension's providers are registered.
 *     ModelRegistry.find(provider, modelId) at that point finds any
 *     concretely-registered link.
 *   - We capture the live ModelRegistry from the first event handler
 *     invocation (session_start fires before any model call) and fall
 *     back to throwing if streamSimple is somehow invoked before the
 *     registry is captured (would manifest as a clear error rather
 *     than a hang).
 *
 * Q6 probe finding (no `"fallback"` provider sentinel):
 *   - grep over node_modules/@mariozechner/pi-coding-agent/dist/ shows
 *     the only `"fallback"` literals are an unrelated auth-storage
 *     source label ("source: 'fallback'" in core/auth-storage.js:298).
 *     No code path treats `model.provider === "fallback"` specially.
 *   - Patching `done.message.provider/model` to the actually-serving
 *     link is therefore safe and accurate.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { streamSimple as piStreamSimple } from "@mariozechner/pi-ai";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type ChainLink, classifyError, runChain } from "./chain.ts";
import { type FallbackConfig, parseConfig, resolveChain } from "./config.ts";
import { appendLog } from "./log.ts";

const DEFAULT_MODELS_JSON = path.join(os.homedir(), ".pi", "agent", "models.json");
const SYNTHETIC_PROVIDER = "fallback";
// Unique synthetic API id so we don't overwrite a built-in provider's
// stream handler. Without this, registering with `api: "anthropic-messages"`
// would replace pi-ai's anthropic handler — and then our chain calling
// piStreamSimple() on a real anthropic Model would recurse back into us.
const SYNTHETIC_API = "fallback-chain-api" as Api;

function loadConfig(): FallbackConfig {
	const candidates = [
		process.env.PI_MODELS_JSON,
		DEFAULT_MODELS_JSON,
		path.join(process.cwd(), ".pi", "agent", "models.json"),
	].filter((p): p is string => typeof p === "string" && p.length > 0);

	for (const p of candidates) {
		try {
			const txt = fs.readFileSync(p, "utf8");
			return parseConfig(JSON.parse(txt));
		} catch {
			// next
		}
	}
	return parseConfig({});
}

function resolveLogPath(cfg: FallbackConfig): string {
	if (path.isAbsolute(cfg.logFile)) return cfg.logFile;
	return path.join(process.cwd(), cfg.logFile);
}

export default function fallbackChainExtension(pi: ExtensionAPI): void {
	const cfg = loadConfig();
	const logPath = resolveLogPath(cfg);

	// Capture the live ModelRegistry at session_start so streamSimple
	// (which doesn't receive Pi's ExtensionContext directly) can resolve
	// each chain link at call time. See Q5 probe finding above.
	let liveRegistry: { find(provider: string, modelId: string): Model<Api> | undefined } | null = null;
	pi.on("session_start", (_event, ctx) => {
		liveRegistry = ctx.modelRegistry;
	});
	pi.on("agent_start", (_event, ctx) => {
		liveRegistry = ctx.modelRegistry;
	});

	const chainNames = Object.keys(cfg.chains);
	if (chainNames.length === 0) {
		// Provide a single default placeholder so /model doesn't 404 if
		// no config is present yet.
		chainNames.push("default");
	}

	const config: Parameters<ExtensionAPI["registerProvider"]>[1] = {
		api: SYNTHETIC_API,
		// Synthetic baseUrl/apiKey: Pi's provider-config validator requires
		// these when `models` is set, but our custom `streamSimple` short-
		// circuits the call before any HTTP is performed.
		baseUrl: "http://fallback.invalid",
		apiKey: "PI_FALLBACK_CHAIN_PLACEHOLDER",
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
			const chainName = model.id;
			let chain: ChainLink[];
			try {
				chain = resolveChain({ config: cfg, chainName, env: process.env as Record<string, string | undefined> });
			} catch (err) {
				// Surface a clear error stream so /model selection at least
				// fails fast instead of hanging.
				throw err instanceof Error ? err : new Error(String(err));
			}

			return runChain(
				{
					chain,
					chainName,
					resolveModel: ({ provider, model: modelId }) => {
						if (!liveRegistry) {
							throw new Error("fallback-chain: model registry not yet available");
						}
						const found = liveRegistry.find(provider, modelId);
						if (!found) {
							throw new Error(`fallback-chain: model ${provider}/${modelId} not registered`);
						}
						return { provider, modelId, api: String(found.api) };
					},
					callStreamSimple: (resolved, ctx2, opts2) => {
						if (!liveRegistry) {
							throw new Error("fallback-chain: model registry not yet available");
						}
						const realModel = liveRegistry.find(resolved.provider, resolved.modelId);
						if (!realModel) {
							throw new Error(`fallback-chain: model ${resolved.provider}/${resolved.modelId} disappeared`);
						}
						return piStreamSimple(realModel, ctx2 as Context, opts2 as SimpleStreamOptions | undefined);
					},
					classify: classifyError,
					log: (entry) => {
						appendLog(logPath, entry);
					},
				},
				context,
				options,
			);
		},
		models: chainNames.map((name) => ({
			id: name,
			name: `Fallback chain: ${name}`,
			api: SYNTHETIC_API,
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 16384,
		})),
	};

	pi.registerProvider(SYNTHETIC_PROVIDER, config);
}
