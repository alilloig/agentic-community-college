# Agentic Community College (ACC)

A Claude Code plugin that turns a Claude Code session into an interactive coding tutor. ACC is the **framework** — it ships the MCP server, the conductor agent, and the authoring skills. **Courses** are separate content plugins that declare `accContent: { lessons: "./lessons/" }` in their `plugin.json`; ACC auto-discovers them at runtime.

## What lives here

| Piece | Path |
|---|---|
| Plugin manifest | `.claude-plugin/plugin.json` |
| Entry-point command | `commands/start.md` → `/agentic-community-college:start` |
| Course conductor agent | `agents/course-conductor.md` |
| Entry-point skill | `skills/course-engine/SKILL.md` |
| Lesson authoring skill | `skills/lesson-creator/SKILL.md` |
| MCP server | `mcp/server/` |
| Tests | `tests/` |

ACC ships no learning content of its own — you install (or build) a course plugin alongside it.

## Recommended companion plugin: `toolkit@contract-hero`

ACC's authoring flow and runtime conductor delegate several HTML-deliverable tasks (per-section SVG diagrams, post-lesson snapshot publishing, project-intro drafts) to skills bundled by [`toolkit@contract-hero`](https://github.com/alilloig/contract-hero-marketplace). It's not required — lessons still run without it — but you'll get the full author / learner experience by installing it alongside ACC. The course-creator template pre-seeds a `toolkit-installed` probe so every new course you scaffold knows about the dependency.

## Vocabulary

- **Course** — a content plugin (one git repo, one domain). Declares `accContent`. The first one is [`acc-deepbook-course`](https://github.com/alilloig/acc-deepbook-course).
- **Lesson** — a single end-to-end learning experience inside a course (`lessons/<slug>/`).
- **Section** — a single prompt step inside a lesson; the learner advances section by section.

## How a session runs

1. The learner runs `/agentic-community-college:start`.
2. ACC discovers installed course plugins and lists their lessons.
3. The learner picks a lesson; `selectLesson` mints session state.
4. The learner picks an output mode (`learning` leaves TODOs for them, `explanatory` implements + narrates).
5. The conductor walks the section sequence — each section advances the HTML artifact and gates on a small `vitest` check.

## Build & test

```bash
pnpm install
cd mcp/server && pnpm install && pnpm build
pnpm test    # from the repo root
```

The plugin manifest spawns `node mcp/server/dist/index.js` over stdio, so `pnpm build` is required after any change in `mcp/server/src/`.

## Authoring a new lesson

Invoke the `lesson-creator` skill. It will ask you which discovered course to target, then seed a reference codebase into it, draft the section sequence and test suite, scaffold an evolving HTML artifact, and run a learner sub-agent validation pass under both output modes before committing.
