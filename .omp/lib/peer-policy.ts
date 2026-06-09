/**
 * peer-policy — pure identity/authorization logic for the Honcho memory plane.
 *
 * Seshat v2, slice v2.1 (retires the SPEC-008.1 "model-trusted as_peer" weak
 * spot). This module is intentionally free of any `@oh-my-pi/*` import so it
 * can be unit-tested without the omp runtime present (mirrors the
 * `buildHonchoTools` pure-factory pattern in tools/honcho/index.ts).
 *
 * It is consumed by:
 *   - .omp/extensions/identity-gate.ts  (the tool_call interceptor)
 *   - .omp/test/peer-policy.test.ts      (unit tests)
 *
 * Residual limitation (documented, not hidden): omp v15 exposes no trusted
 * per-agent identity to tools/hooks. When `expectedPeer` is unknown (the
 * dispatcher did not export SESHAT_EXPECTED_PEER), layer-2 enforcement falls
 * back to allowlist + content invariants only. The TTSR rule
 * (.omp/rules/identity-peer-gate.mdc) and the append-only audit make any
 * spoof attempt loud and reviewable.
 */

/** Personas permitted to write durable Honcho conclusions. Mirrors
 *  CONCLUSION_WRITERS in tools/honcho/index.ts — keep the two in sync. */
export const CONCLUSION_WRITERS: ReadonlySet<string> = new Set([
	"validator",
	"reviewer",
	"reviewer-code",
	"security-reviewer",
	"steward",
	"release-steward",
]);

/** Every known persona name (used to reject typo'd / unknown peers early). */
export const KNOWN_PERSONAS: ReadonlySet<string> = new Set([
	"seshat",
	"steward",
	"release-steward",
	"architect",
	"spec-writer",
	"doc-scout",
	"docs-writer",
	"test-writer",
	"implementer",
	"validator",
	"reviewer",
	"reviewer-code",
	"security-reviewer",
]);

/** Personas whose durable conclusions MUST be prefixed `product:`. */
export const PRODUCT_DIALECT_WRITERS: ReadonlySet<string> = new Set(["steward", "release-steward"]);

export type IdentityVerdict = { ok: true } | { ok: false; reason: string };

export function isConclusionWriter(peer: string): boolean {
	return CONCLUSION_WRITERS.has(peer);
}

const ok: IdentityVerdict = { ok: true };
const deny = (reason: string): IdentityVerdict => ({ ok: false, reason });

/**
 * Evaluate a `honcho_conclude` call. Validation order is exact and matches
 * tools/honcho/index.ts §3.2 so the interceptor and the tool agree:
 *   1. as_peer required (no env fallback for conclusions)
 *   2. as_peer must be a known persona (catches typos before allowlist)
 *   3. as_peer must be in CONCLUSION_WRITERS
 *   4. if a trusted expectedPeer is known, declared must equal it (anti-spoof)
 *   5. product-dialect writers must prefix content with `product:`
 */
export function evaluateConclude(input: {
	declaredPeer?: string;
	expectedPeer?: string;
	content: string;
}): IdentityVerdict {
	const declared = (input.declaredPeer ?? "").trim();
	if (declared.length === 0) {
		return deny(`as_peer is required for honcho_conclude (one of: ${[...CONCLUSION_WRITERS].join(", ")})`);
	}
	if (!KNOWN_PERSONAS.has(declared)) {
		return deny(`as_peer '${declared}' is not a known persona`);
	}
	if (!CONCLUSION_WRITERS.has(declared)) {
		return deny(`peer '${declared}' is not permitted to write conclusions`);
	}
	const expected = (input.expectedPeer ?? "").trim();
	if (expected.length > 0 && declared !== expected) {
		return deny(`as_peer '${declared}' does not match the dispatched persona '${expected}' (identity spoof blocked)`);
	}
	if (PRODUCT_DIALECT_WRITERS.has(declared) && !input.content.trimStart().startsWith("product:")) {
		return deny(`${declared} conclusions must be prefixed with 'product:' (dialect separator)`);
	}
	return ok;
}

/**
 * Evaluate a `honcho_remember` call. `as_peer` is OPTIONAL here (defaults to
 * the env peer). The only hard failure is a declared peer that contradicts a
 * trusted expectedPeer, or a declared peer that is not a known persona.
 */
export function evaluateRemember(input: {
	declaredPeer?: string;
	expectedPeer?: string;
}): IdentityVerdict {
	const declared = (input.declaredPeer ?? "").trim();
	if (declared.length === 0) return ok; // env fallback is allowed
	if (!KNOWN_PERSONAS.has(declared)) {
		return deny(`as_peer '${declared}' is not a known persona`);
	}
	const expected = (input.expectedPeer ?? "").trim();
	if (expected.length > 0 && declared !== expected) {
		return deny(`as_peer '${declared}' does not match the dispatched persona '${expected}' (identity spoof blocked)`);
	}
	return ok;
}
