/**
 * Cross-provider fallback chain — JSONL audit log writer.
 *
 * SpecSafe slice: SPEC-20260426-007 — cross-provider-fallback
 *
 * Append-only JSONL, one entry per fallback decision. File is created
 * with mode 0600 on first write. Failure to write goes to stderr and
 * MUST NOT throw to the caller (spec §3.5).
 *
 * Redaction: scan every string field for API-key-shaped tokens and
 * replace them with [REDACTED] before serialization. Load-bearing
 * security control — see AC10 + spec §6.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { LogEntry } from "./chain.ts";

const REDACTION_PATTERNS: RegExp[] = [/sk-ant-[A-Za-z0-9_-]+/g, /sk-[A-Za-z0-9]{20,}/g, /Bearer [A-Za-z0-9._-]+/gi];

const REDACTED = "[REDACTED]";

export function redact(s: string): string {
	if (typeof s !== "string" || s.length === 0) return s;
	let out = s;
	for (const pat of REDACTION_PATTERNS) {
		out = out.replace(pat, REDACTED);
	}
	return out;
}

function redactEntry(entry: LogEntry): LogEntry {
	return {
		...entry,
		links: entry.links.map((link) => ({
			...link,
			...(typeof link.errorMessage === "string" ? { errorMessage: redact(link.errorMessage) } : {}),
			...(typeof link.errorClass === "string" ? { errorClass: redact(link.errorClass) } : {}),
		})),
	};
}

export function appendLog(filePath: string, entry: LogEntry): void {
	try {
		const safe = redactEntry(entry);
		const line = `${JSON.stringify(safe)}\n`;
		const dir = path.dirname(filePath);
		try {
			fs.mkdirSync(dir, { recursive: true });
		} catch {
			// directory exists or unwritable; openSync below will surface
		}
		const fd = fs.openSync(filePath, "a", 0o600);
		try {
			fs.writeSync(fd, line);
			try {
				fs.fsyncSync(fd);
			} catch {
				// fsync best-effort; durability win, not correctness
			}
		} finally {
			fs.closeSync(fd);
		}
		// Belt-and-braces: ensure the mode is 0600 even if the file
		// pre-existed with looser perms.
		try {
			fs.chmodSync(filePath, 0o600);
		} catch {
			// chmod best-effort
		}
	} catch (err) {
		try {
			process.stderr.write(`fallback-chain: log write failed: ${(err as Error)?.message ?? err}\n`);
		} catch {
			// nothing more we can do
		}
	}
}
