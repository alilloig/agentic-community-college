# Agentic Community College (ACC)

![Agentic Community College](./banner.png)

> Coding lessons that run inside Claude Code. Chapters defined by tests. The agent builds, you learn.

ACC v0.3.0 is a Claude Code plugin that turns a session into a coding tutor. A lesson starts from a topic and its documentation. It is split into **chapters**, and each chapter is defined by the tests it makes pass. At runtime the agent implements every chapter in your workspace, explains what it wrote with a self-contained HTML artifact, and closes the lesson with an end-to-end test and a summary page. You read, ask, and confirm.

**👉 [Read the 2-minute overview](https://contract-hero.github.io/agentic-community-college/)**

## How it works

1. **Docs.** The lesson author gives ACC the official docs, or ACC retrieves them. A curated snapshot lives inside the lesson (`docs/`). Every chapter is grounded in it.
2. **Plan.** The author defines the ordered steps the lesson teaches. Each step becomes a chapter.
3. **Tests first.** Each chapter ships the tests that prove its step works, plus one end-to-end test for the whole feature. A reference solution proves the tests are satisfiable. Your workspace gets the scaffold and the tests, never the solution.
4. **Runtime.** For each chapter the conductor tells you what it will build, implements it until the chapter's tests pass, and writes one HTML artifact: what was built, a diagram of how it works, the key snippets, and the tests that prove it. Then it pauses so you can read and ask.
5. **Close.** After the last chapter the conductor runs the e2e test and writes a summary artifact with the most important learnings.

There are no output modes. ACC recommends the **Concise** Claude Code output style and offers to set it. All learning content goes into the artifacts, not the chat.

## Install

```text
/plugin marketplace add contract-hero/plugin-marketplace
/plugin install agentic-community-college@contract-hero
/plugin install acc-claude-sdk@contract-hero            # a course (see below)
/acc-claude-sdk:start                                   # start a lesson
```

## Courses

- **[`acc-claude-sdk`](https://github.com/contract-hero/acc-claude-sdk)**: the first v0.3 course. Build agents with the Claude Agent SDK, chapter by chapter, with tests as the contract. Start with `/acc-claude-sdk:start`.
- **[`acc-deepbook-course`](https://github.com/contract-hero/acc-deepbook-course)**: 4 Sui DeepBook lessons (orders, CLOB swaps, flash-loan arbitrage, market-maker bot). Written for the v0.2 section model; migration to v0.3 chapters is pending, so it does not run on ACC v0.3 yet.
- **[`acc-evm-wal`](https://github.com/contract-hero/acc-evm-wal)**: 6 Walrus x EVM lessons (blob anchoring, Walrus Sites, ENS resolver, DAO proposals, verifiable manifest client, quilt-backed ERC-721). Also on the v0.2 section model, pending migration.

## Write your own course

```text
/agentic-community-college:create-course     # scaffold a course plugin
/agentic-community-college:create-lesson     # docs -> chapters -> tests -> validation
```

`create-lesson` curates the docs, plans the chapters, writes the tests and the reference solution, writes the chapter briefs, and validates the lesson with a learner sub-agent before you commit.

## Links

- **Landing page**: <https://contract-hero.github.io/agentic-community-college/>
- **Courses**: [`acc-claude-sdk`](https://github.com/contract-hero/acc-claude-sdk) · [`acc-deepbook-course`](https://github.com/contract-hero/acc-deepbook-course) · [`acc-evm-wal`](https://github.com/contract-hero/acc-evm-wal)
- **Marketplace**: [`contract-hero/plugin-marketplace`](https://github.com/contract-hero/plugin-marketplace)
- **Companion toolkit**: `toolkit@contract-hero` (optional; the conductor offers `publish-html` for the summary artifact when it is enabled)

## For contributors

If you are editing ACC itself, see [`CLAUDE.md`](./CLAUDE.md) for the architectural invariants, build/test commands, and component map.

```bash
pnpm install
cd mcp/server && pnpm install && pnpm build
pnpm test    # from the repo root
```

The plugin manifest spawns `node mcp/server/dist/index.js` over stdio, so `pnpm build` is required after any change in `mcp/server/src/`.
