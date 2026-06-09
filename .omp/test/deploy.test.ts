/**
 * Unit tests — deploy skill (Seshat v2.7 global install link decisions).
 */
import { describe, expect, test } from "bun:test";
import { CAPABILITIES, decideLinkAction, FILES, planConfigMerge } from "../skills/deploy/bin/deploy";

describe("[unit] deploy.decideLinkAction", () => {
	test("missing → create", () => {
		expect(decideLinkAction({ kind: "missing" }, false)).toBe("create");
	});
	test("correct symlink → skip (idempotent)", () => {
		expect(decideLinkAction({ kind: "correct-symlink" }, false)).toBe("skip");
		expect(decideLinkAction({ kind: "correct-symlink" }, true)).toBe("skip");
	});
	test("wrong symlink → conflict without force, replace with force", () => {
		expect(decideLinkAction({ kind: "wrong-symlink", target: "/x" }, false)).toBe("conflict");
		expect(decideLinkAction({ kind: "wrong-symlink", target: "/x" }, true)).toBe("replace");
	});
	test("real path → conflict without force, replace with force", () => {
		expect(decideLinkAction({ kind: "regular" }, false)).toBe("conflict");
		expect(decideLinkAction({ kind: "regular" }, true)).toBe("replace");
	});
});

describe("[unit] deploy capability/file manifest", () => {
	test("links the omp capability dirs", () => {
		expect(CAPABILITIES).toContain("agents");
		expect(CAPABILITIES).toContain("extensions");
		expect(CAPABILITIES).toContain("rules");
		expect(CAPABILITIES).toContain("skills");
	});
	test("links the sticky files", () => {
		expect(FILES).toContain("RULES.md");
		expect(FILES).toContain("AGENTS.md");
	});
});

describe("[unit] deploy.planConfigMerge", () => {
	const block = "compaction:\n  strategy: handoff\ngoal:\n  enabled: true\n";
	test("no existing global config → create", () => {
		expect(planConfigMerge(null, block)).toMatchObject({ action: "create", text: block });
	});
	test("existing config without our keys → append (preserves user keys)", () => {
		const existing = "model: claude-fable-5\nui:\n  theme: dark\n";
		const r = planConfigMerge(existing, block);
		expect(r.action).toBe("append");
		if (r.action === "append") {
			expect(r.text).toContain("model: claude-fable-5");
			expect(r.text).toContain("strategy: handoff");
		}
	});
	test("existing config already declaring compaction/goal → skip (never clobber)", () => {
		expect(planConfigMerge("compaction:\n  strategy: shake\n", block)).toMatchObject({ action: "skip-exists" });
		expect(planConfigMerge("goal:\n  enabled: false\n", block)).toMatchObject({ action: "skip-exists" });
	});
});
