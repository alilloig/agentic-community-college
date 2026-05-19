# Agentic Community College (ACC)

> Coding lessons that run inside Claude Code — and ship verified work.

ACC is a Claude Code plugin that turns a session into an interactive coding tutor. Install the framework, install (or write) a **course plugin**, and the conductor walks you through reference-seeded lessons with real test gates and an evolving HTML artifact.

**👉 [Read the 2-minute overview](https://contract-hero.github.io/agentic-community-college/)**

## Install

```text
/plugin marketplace add contract-hero/plugin-marketplace
/plugin install agentic-community-college@contract-hero
/plugin install acc-deepbook-course@contract-hero    # the reference course
/acc-deepbook-course:start                            # start a lesson
```

## Write your own course

```text
/agentic-community-college:create-course
/agentic-community-college:create-lesson
```

## Links

- **Landing page** — <https://contract-hero.github.io/agentic-community-college/>
- **Reference course** — [`acc-deepbook-course`](https://github.com/contract-hero/acc-deepbook-course)
- **Marketplace** — [`contract-hero/plugin-marketplace`](https://github.com/contract-hero/plugin-marketplace)
- **Companion toolkit** — `toolkit@contract-hero` (optional; powers per-section diagrams + post-lesson publishing)

## For contributors

If you're editing ACC itself, see [`CLAUDE.md`](./CLAUDE.md) for the architectural invariants, build/test commands, and component map.

```bash
pnpm install
cd mcp/server && pnpm install && pnpm build
pnpm test    # from the repo root
```

The plugin manifest spawns `node mcp/server/dist/index.js` over stdio, so `pnpm build` is required after any change in `mcp/server/src/`.
