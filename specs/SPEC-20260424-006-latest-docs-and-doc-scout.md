---
id: SPEC-20260424-006
slug: latest-docs-and-doc-scout
slice: 6 of 6
title: latest-docs skill + doc-scout agent — programmatic enforcement of the latest-docs rule
status: approved
author: seshat (drafted on behalf of luci)
created: 2026-04-24
depends_on: [SPEC-20260424-001, SPEC-20260424-002]
linear: n/a
---

# SPEC-006 — Latest-Docs Skill + Doc-Scout Agent

## 1. Goal

Turn Luci's "always check latest official docs" rule from prose into an executable contract:

- **`latest-docs` skill** — fetches, caches, and exposes the latest official documentation for a registered library/SDK/API. Uses HTTP against canonical vendor URLs, not training-data recall.
- **`doc-scout` agent** — a specialist Ghola whose only job is to run `latest-docs` and synthesize the output into focused research notes. Other agents dispatch to `doc-scout` via nested `subagent` calls when they need library context, keeping implementer/validator contexts clean.

## 2. Scope

In scope:

- `.pi/skills/latest-docs/{SKILL.md,bin/latest-docs.ts,README.md}`.
- `.pi/skills/latest-docs/registry.json` — registry of known libraries → canonical doc URLs. Seeded with: `@linear/sdk`, `@honcho-ai/sdk`, `hono`, `better-auth`, `drizzle-orm`, `@libsql/client`, `@cloudflare/workers-types`, `wrangler`, `@tanstack/start`, `@tanstack/react-query`, `zod`.
- Local cache directory `.pi/.docs-cache/<lib>/<YYYY-MM-DD>.md` with a 7-day freshness window; `--refresh` forces re-fetch.
- `.pi/agents/doc-scout.md` agent markdown.
- Addition to each existing agent's body (single line) instructing them to invoke `/skill:latest-docs <lib>` or dispatch to `doc-scout` before writing code against a library.

Not in scope:

- Scraping non-canonical doc mirrors.
- Full-text search over cached docs (nice-to-have, v2).
- Parallel multi-library fetch in a single call — v2.

## 3. Implementation constraints

### 3.1 `latest-docs` skill

Commands:

```
latest-docs list                          # enumerate known libraries in registry
latest-docs fetch <lib> [--refresh]       # fetch + cache; prints location of cache file
latest-docs show <lib> [--section=...]    # print cached content (or fetch if missing)
latest-docs register <lib> <url> [--paths=...]   # add to registry; --i-approve gated (registry edit is a config change)
```

- Fetch mechanism: `fetch()` to the registered URL (or URLs if `--paths` lists multiple pages), convert HTML → Markdown via `marked` + a simple HTML stripper (we already have `marked` in pi's dep tree). Write the Markdown to `.pi/.docs-cache/<lib>/<ISO-date>.md`.
- Each fetched cache file starts with a YAML frontmatter block containing `source_url`, `fetched_at`, `content_hash`.
- `show` reads the most recent dated file; if it's >7 days old, prints a "stale (N days)" warning in the first line.
- `--section` grep-matches a markdown header and prints the subtree under it.
- `register` mutation is audit-logged to `.pi/.docs-registry-log.jsonl`.

### 3.2 `doc-scout` agent

- `name: doc-scout`, `description: "Fetches and synthesizes the latest official documentation for a named library or API."`
- Tool allowlist: `read,find,grep,ls,honcho_recall,honcho_search,honcho_remember,latest-docs_*`. No `write`, no `edit`, no `bash`.
- Persona body ≤40 lines. Core directive: "Given a library name and a specific question, invoke latest-docs fetch + show, read the cached Markdown, extract the section most relevant to the question, and return a synthesis ≤400 words with exact code examples pulled from the docs verbatim. Never guess."
- Memory protocol: `honcho_remember` its synthesis so other agents' `honcho_recall` can surface it.

### 3.3 Directive line in existing agents

Appended to `spec-writer`, `test-writer`, `implementer`, `validator`, `reviewer`, `steward`:

> Before writing code against any external library or API, invoke `/skill:latest-docs show <lib>` yourself OR dispatch to the `doc-scout` agent. Trust the cache-dated Markdown over your training-data recall.

## 4. Acceptance criteria

1. `latest-docs list` enumerates the seeded registry, showing library name, canonical URL, and last-fetched date per entry.
2. `latest-docs fetch @honcho-ai/sdk` writes a Markdown file under `.pi/.docs-cache/@honcho-ai-sdk/<ISO-date>.md` with valid YAML frontmatter.
3. `latest-docs show @honcho-ai/sdk` prints the cached file. If >7 days old, the first line is a stale warning.
4. `latest-docs show @honcho-ai/sdk --section="Installation"` prints only the Installation subtree.
5. `latest-docs register new-lib https://example.com/docs` without `--i-approve` prints a preview; with the flag, adds to registry and logs.
6. Dispatching `subagent({ agent: "doc-scout", task: "@honcho-ai/sdk: how do I add messages?" })` returns a synthesis that includes at least one verbatim code block from the cached docs.
7. Each of the 6 existing agent bodies (5 engineering + steward) now contains exactly one "latest-docs directive" line at the position specified in 3.3.
8. `.pi/.docs-cache/` and `.pi/.docs-registry-log.jsonl` are in `.gitignore`.

## 5. Open questions / risks

- **Q1** — HTML → Markdown quality varies wildly across doc sites. **Mitigation:** registry entries can include `--selector` CSS selectors to scope the HTML before conversion; seed with sensible defaults for the major doc portals (docs.sh, readthedocs, docusaurus, mintlify patterns).
- **Q2** — Doc sites that aggressively reorganize (e.g. Linear's portal during research for this project) will break our URLs. **Mitigation:** `register` updates can repair registry entries; cache is the fallback if fetch fails.
- **Q3 — RESOLVED 2026-04-24:** configurable `ttl_days` per entry, default 7. Accepted.
- **Q4** — Worth prefetching all registry entries at `specsafe_begin`? **Proposal:** no — lazy fetch on first use keeps the common path fast; add a `/skill:latest-docs warm` command later if we hit pain.
