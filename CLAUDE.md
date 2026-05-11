# Agentic Community College (ACC) — Claude's working notes

A Claude Code plugin that runs reference-seeded coding lessons through MCP. ACC is the framework; **course plugins** (separate repos) supply the learning content via the `accContent` field in their `plugin.json`.

The user-facing onboarding doc is `README.md`. This file is for Claude's context when working on the code.

## Status

Migrated from the original `sui-mcp-course` repo and split into framework (this repo) + content (`acc-deepbook-course`). Migration plan: `/Users/alilloig/.claude/plans/modular-pondering-lamport.md`.

## Tech Stack

- TypeScript (ESM, `"type": "module"`), Node >= 18
- pnpm workspaces — only `mcp/server` is currently a workspace member
- `@modelcontextprotocol/sdk` ^1.0.0
- `zod` for tool input schemas
- `vitest` for tests (run with `pnpm test` from the root)

## Build & Test

```bash
pnpm install                                  # root install
cd mcp/server && pnpm install && pnpm build   # produces dist/index.js
pnpm test                                     # vitest, from root
```

The plugin manifest spawns `node mcp/server/dist/index.js` over stdio, so `pnpm build` is required after any change in `mcp/server/src/`.

## Vocabulary

- **Course** — a content plugin. One domain per course. Discovered by ACC at runtime via `~/.claude/plugins/*/plugin.json` containing `accContent: { lessons: "./lessons/" }`.
- **Lesson** — a single end-to-end learning experience inside a course (`lessons/<slug>/`).
- **Section** — a single prompt step inside a lesson.

## When You Edit MCP Server Code

1. Edit under `mcp/server/src/`.
2. Run `pnpm build` from `mcp/server` (the plugin runs the *built* `dist/index.js`, not the source).
3. Run `pnpm test` from the repo root.
4. Restart Claude Code if the plugin is already loaded; MCP servers don't hot-reload.

## Architectural invariants (do not break)

Carried forward from the original `sui-mcp-course` and updated for the new architecture during the migration. The detailed invariant list is maintained in `mcp/server/src/` comments next to the code that enforces each one. Top-level rules:

1. **Output-style gate runs before any state load** in every gated tool. Pattern: probe `outputStyleOk` → return `output-style-disabled` early → only then `loadState`.
2. **State writes are atomic**: `state.ts:saveState` writes to a `tmp` file with `wx` + `0o600`, fsyncs via `FileHandle.sync()`, then renames over the canonical path.
3. **Corrupt state recovery is two-tier**: archive under `.acc/state.corrupt-<sha256-prefix>.json` (deduped via `wx`); on archive failure, surface the error rather than silently swallowing.
4. **`{{ ... }}` substitution is scoped to section bodies only** — never `target_file`, `verification.command`, or `verification.endpoint`.
5. **Verification spawn is injectable** via `VerifyOptions.spawn` for hermetic tests.
6. **State schema versioning** is on `STATE_SCHEMA_VERSION = 4`. Bumps follow the existing `schema-mismatch` flow (the learner re-runs `selectLesson` to mint fresh state); never silently coerce.
7. **Content discovery is plugin-scoped**: lessons live inside discovered course plugins, not under `paths/` in this repo. `pluginsRoot.ts` is the only correct way to compute course roots.

(More invariants will land here as their corresponding code arrives via the migration phases.)
