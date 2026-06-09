/**
 * identity-gate — code-enforced Honcho peer-identity interceptor (Seshat v2.1).
 *
 * Retires the SPEC-008.1 "model-trusted as_peer" weak spot. This `tool_call`
 * interceptor runs BEFORE honcho_conclude / honcho_remember execute and:
 *   - re-validates the declared `as_peer` against the pure peer-policy
 *     (allowlist + known-persona + product: dialect invariants),
 *   - cross-checks `as_peer` against a trusted `SESHAT_EXPECTED_PEER` env var
 *     when the dispatcher exported one (hard anti-spoof),
 *   - blocks the call with a concrete reason on any violation,
 *   - appends every decision (allow AND deny) to an append-only audit log.
 *
 * It is defense-in-depth, layered with:
 *   - .omp/rules/identity-peer-gate.mdc  (TTSR: corrects mid-stream, pre-call)
 *   - tools/honcho/index.ts              (the allowlist inside the tool itself)
 *
 * Auto-loaded because it lives in `.omp/extensions/` (omp v15 discovery).
 */
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HookAPI } from "@oh-my-pi/pi-coding-agent";
import { evaluateConclude, evaluateRemember } from "../lib/peer-policy";

const AUDIT_PATH = join(homedir(), ".omp", "agent", ".identity-audit.jsonl");

async function audit(line: Record<string, unknown>): Promise<void> {
	try {
		await mkdir(dirname(AUDIT_PATH), { recursive: true });
		await appendFile(AUDIT_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...line })}\n`, {
			mode: 0o600,
		});
	} catch {
		// Audit failure must never break the agent loop.
	}
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

export default function (pi: HookAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		const tool = event.toolName;
		if (tool !== "honcho_conclude" && tool !== "honcho_remember") return undefined;

		const input = (event.input ?? {}) as { as_peer?: unknown; content?: unknown };
		const declaredPeer = str(input.as_peer);
		// Trusted hint exported per-dispatch by the orchestrator. Empty when the
		// dispatcher could not export it — policy degrades to allowlist-only.
		const expectedPeer = str(process.env.SESHAT_EXPECTED_PEER);

		const verdict =
			tool === "honcho_conclude"
				? evaluateConclude({ declaredPeer, expectedPeer, content: str(input.content) })
				: evaluateRemember({ declaredPeer, expectedPeer });

		const session = ctx.sessionManager?.getSessionId?.() ?? null;

		if (!verdict.ok) {
			await audit({ event: "deny", tool, declaredPeer, expectedPeer: expectedPeer || null, session, reason: verdict.reason });
			return { block: true, reason: `identity-gate: ${verdict.reason}` };
		}

		await audit({ event: "allow", tool, declaredPeer: declaredPeer || null, expectedPeer: expectedPeer || null, session });
		return undefined;
	});
}
