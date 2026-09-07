# Agentic Community College (ACC) — Claude's working notes

A Claude Code plugin that turns a session into a coding tutor. ACC is the **framework**: it ships the MCP server, the `course-conductor` agent, and the authoring/runtime skills. Content lives in separate **course plugins** that declare `accContent` in their `plugin.json`; ACC discovers them at runtime.

The user-facing onboarding doc is `README.md`. This file is for Claude's context when working on the code.

## North star (v0.3)

Given a programming topic and its documentation, ACC produces a **lesson** (or a **course** of lessons) with one fixed shape:

1. **Phase 0 — docs.** If the author gives no docs, ACC retrieves the official documentation and stores a curated snapshot inside the lesson (`docs/`). The implementing agent grounds every chapter in that snapshot.
2. **Plan.** The author defines the ordered steps that show what is meant to be taught. Every step becomes a **chapter**.
3. **Tests first.** For every chapter the author writes the test cases that prove the step works, plus one **end-to-end test** that proves the whole feature. The tests are the contract; the reference solution exists to prove the tests are satisfiable.
4. **Runtime.** For every chapter the conductor (1) tells the learner what will be implemented, (2) implements the code until that chapter's tests pass, (3) generates an **HTML artifact** that explains the code just written, visually, with the most significant snippets.
5. **Close.** After the last chapter the conductor runs the e2e test and writes a **summary artifact** with the most important learnings.

The agent writes the code. The learner reads, asks, and confirms. There are no output modes anymore: ACC recommends the **Concise** Claude Code output style and offers to set it. All learning content goes into the artifacts, not the chat.

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

- **ACC** — the framework. This repo. Ships the MCP server + conductor + skills.
- **Course** — a content plugin. Declares `accContent: { lessons: "./lessons/" }` in `plugin.json`. Discovered by ACC at runtime via `~/.claude/plugins/installed_plugins.json`. Published courses: [`acc-deepbook-course`](https://github.com/contract-hero/acc-deepbook-course) and [`acc-evm-wal`](https://github.com/contract-hero/acc-evm-wal) (both on the v0.2 section model, pending migration), and [`acc-claude-sdk`](https://github.com/contract-hero/acc-claude-sdk) (first v0.3 course).
- **Lesson** — one end-to-end learning experience inside a course (`lessons/<slug>/`). Always namespaced as `<course-plugin-key>/<slug>` when it crosses a tool boundary.
- **Chapter** — one step of a lesson. A chapter is defined by the set of test cases it makes pass. The conductor implements a chapter, then explains it with one artifact.
- **Artifact** — a self-contained HTML page. One per chapter plus one summary, generated at runtime into the workspace.
- **Workspace** — the learner's copy of the lesson's reference app, minus the solution files, at `~/.acc/workspaces/<slug>/`.

## Lesson layout (v0.3)

```
lessons/<slug>/
├── lesson.json          identity, prerequisites, workspace seeding rules
├── description.md       what the learner will build, why, prerequisites, time
├── docs/                Phase 0 snapshot: curated reference docs (markdown) + INDEX.md
├── chapters.json        ordered chapters, per-chapter verification, final e2e gate
├── chapters/NN-<id>.md  chapter brief: what gets implemented, which tests define done, notes
├── reference-app/       complete working solution INCLUDING every test (unit + e2e)
└── validation.json      result of the authoring-time learner pass
```

### `lesson.json`

```json
{
  "slug": "01-basic-agent",
  "title": "…",
  "summary": "…",
  "prerequisites": ["pnpm-installed"],
  "docs": "docs/",
  "workspace": {
    "host": "reference-app",
    "host_install_command": "pnpm install",
    "verification_cwd": ".",
    "solution_files": ["src/agent.ts", "src/tools.ts", "src/cli.ts"],
    "files": []
  },
  "personalization_options": [],
  "personalization_ranges": {}
}
```

- `workspace.host` is copied whole into the workspace. Then every `solution_files` entry is **deleted** from the copy. Then `files[]` starters (`{ starter, path }`) are copied in. The learner's workspace therefore holds scaffold + tests, never the solution.
- `docs` is optional. When present it must be a lesson-relative directory; `nextChapter` returns its absolute path as `docs_dir`.
- `build_command`, `test_command`, and `artifact` from v0.2 are gone. Verification lives in `chapters.json`.

### `chapters.json`

```json
{
  "schema_version": 2,
  "chapters": [
    {
      "id": "c01-run-query",
      "title": "Run a query and read the result",
      "brief_md": "chapters/01-run-query.md",
      "key_idea": "query() returns an async iterable of typed messages; the `result` message is the contract.",
      "expected_files": ["src/agent.ts"],
      "tests": ["tests/01-run-query.test.ts"],
      "verification": { "mode": "test-suite", "command": "pnpm vitest run tests/01-run-query.test.ts" }
    }
  ],
  "final_verification": { "mode": "test-suite", "command": "pnpm vitest run" }
}
```

- Every chapter carries its own mandatory `verification`. Modes: `compile`, `test-suite`. Pass = exit 0.
- `tests` lists the workspace-relative test files that define the chapter (informational: the conductor reads them before implementing and lists them in the artifact).
- `key_idea` is the one concept the chapter artifact must center on.
- `final_verification` is the e2e gate that runs once after the last chapter passes. Lessons whose e2e needs credentials skip those tests in-suite with a clear message; a skipped e2e still exits 0.

### Chapter brief (`chapters/NN-<id>.md`)

Short markdown with three parts: **What we implement** (learner-facing, 3–6 lines), **Done when** (the test names and what each asserts), **Implementation notes** (for the agent: which docs file to read, pitfalls, constraints such as "do not touch package.json").

## Runtime flow (v0.3)

1. The course's `/<course>:start` command invokes the `course-engine` skill with a course filter.
2. `start` → catalog + `outputStyle` status. If the active style is not `Concise`, the skill asks the learner and, on yes, calls `setOutputStyle`.
3. Learner picks a lesson → `selectLesson` (mints v5 state, seeds the workspace) → `runPreflightProbe` for each prerequisite → `setPersonalization` (defaults when the lesson has none).
4. Hand-off to the `course-conductor` agent. Per chapter:
   1. `nextChapter` → brief, key idea, expected files, tests, resolved verification (`cwd` always set), `docs_dir`, `workspace_path`, `artifact_path`, `artifact_nav` (prev/next filenames for the footer links).
   2. **Tell** — a short "Chapter N of M — title: here is what we implement and which tests define done".
   3. **Implement** — read `docs_dir` and the chapter's tests, edit only `expected_files`, run the chapter's verification command with Bash until green (max 5 attempts, then ask the learner).
   4. **Explain** — write the chapter artifact at `artifact_path` following `skills/chapter-artifact/references/conventions.md` (the MCP returns the absolute path as `artifact_conventions_path`).
   5. `verifyChapter` — the official gate. On pass it advances `chapter_cursor` and records the artifact path in state. On fail it returns the output; the conductor never auto-retries the gate, it asks the learner.
   6. **Pause** — `AskUserQuestion`: continue / I have questions / pause here. Never more than one chapter per learner turn.
5. When `nextChapter` returns `done: true` with `final_verification`, the conductor calls `verifyChapter` once more (runs the e2e), then writes `summary_artifact_path` (chapter cards built from the `artifacts` map, the most important learnings, the final architecture), calls `verifyChapter` a last time so the summary gets recorded, and offers `publish-html` when the envelope says `publish_available: true` (`toolkit@contract-hero` enabled).

## MCP tools (v0.3)

| Tool | Purpose |
|---|---|
| `start` | Catalog across enabled courses (`chapter_count` per lesson) + `outputStyle: { active, recommended: "Concise", ok }`. Never runs probes. |
| `runPreflightProbe` | Runs one declared probe by id, optional remediation. Unchanged. |
| `selectLesson` | Mints v5 state, seeds the workspace (host − solution_files + starters), returns description, prerequisites, personalization prompts, `workspaceStrippedFiles`, first-run setup. |
| `setPersonalization` | Validates + persists personalization values. `{}` accepts defaults. |
| `setOutputStyle` | Writes `outputStyle` into `~/.claude/settings.json` (only `Concise` is accepted). Returns the previous value. |
| `nextChapter` | Chapter envelope (see runtime flow) while chapters remain. Done envelope (`done: true`, `summary_artifact_path`, `artifacts` map, `publish_available`) once the cursor is past the last chapter: with `final_verification` while the e2e has not run, with `completed: true` after it passed. |
| `verifyChapter` | Runs the current chapter's verification, or `final_verification` when the cursor is past the last chapter. On pass: advances the cursor (or marks `completed_at`), records the artifact path if the file exists. After completion a re-entrant call re-runs nothing and records `summary.html` once it exists. |
| `configureWorkspace` | Read/write `~/.acc/config.json`. Unchanged. |

Retired: `setOutputMode`, `advanceArtifact`, `nextSection`, `verifySection`.

## State v5

```ts
interface State {
  schema_version: 5;
  selected_lesson: string;                       // namespaced slug
  personalization: Record<string, unknown>;
  chapter_cursor: number;                        // 0-based; === chapters.length means "e2e pending or done"
  history: HistoryEntry[];
  artifacts: Record<string, string>;             // chapter id → absolute artifact path (+ "summary")
  workspace_path?: string;
  test_status?: { pass: boolean; output?: string; ts?: string; final?: boolean };
  completed_at?: string;                         // set when final_verification passed
}
```

State lives at `<projectRoot>/.acc/state.json`. Older versions surface as `schema-mismatch`; the learner re-runs the course's start command.

## Component Map

| Path | Role |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest: name=`agentic-community-college`, commands/agents/skills/mcpServers registered. |
| `commands/create-course.md` | `/agentic-community-college:create-course` → loads `course-creator` skill. |
| `commands/create-lesson.md` | `/agentic-community-college:create-lesson` → loads `lesson-creator` skill. |
| `commands/list.md` | `/agentic-community-college:list` → read-only catalog browser; calls `start` and renders, no state mutation. |
| `agents/course-conductor.md` | Chapter-loop driver dispatched after course-engine sets up the session. |
| `skills/course-engine/SKILL.md` | Session driver: discovery → output-style check → lesson selection → prerequisites → personalization → hand off to the conductor. Invoked by each course plugin's own `start` command. |
| `skills/course-creator/SKILL.md` + `templates/` | Scaffolds a new course plugin (plugin.json + accContent + probes + README + CLAUDE.md + start command + empty lessons/). |
| `skills/lesson-creator/SKILL.md` + `templates/` | Authors a lesson: Phase 0 docs → plan → tests + reference solution → chapters → description → learner validation pass → `validation.json`. |
| `skills/chapter-artifact/SKILL.md` + `references/conventions.md` + `templates/` | ACC-owned conventions for the per-chapter and summary artifacts. The conductor reads the conventions file at runtime. |
| `mcp/server/src/index.ts` | MCP entry; registers the 8 tools and starts stdio transport when run as a script. |
| `mcp/server/src/tools/start.ts` | `start`. |
| `mcp/server/src/tools/runPreflightProbe.ts` | `runPreflightProbe`. |
| `mcp/server/src/tools/selectLesson.ts` | `selectLesson`. |
| `mcp/server/src/tools/setPersonalization.ts` | `setPersonalization`. |
| `mcp/server/src/tools/setOutputStyle.ts` | `setOutputStyle`. |
| `mcp/server/src/tools/nextChapter.ts` | `nextChapter`. |
| `mcp/server/src/tools/verifyChapter.ts` | `verifyChapter`. |
| `mcp/server/src/tools/configureWorkspace.ts` | `configureWorkspace`. |
| `mcp/server/src/tools/setupGate.ts` | Shared entry sequence for chapter-loop tools, in two steps: `loadSelectedState` (state load + selected lesson) and `resolveSelectedLesson` (registry resolve); `runSetupGate` runs both. |
| `mcp/server/src/progress.ts` | `lessonPhase()` (chapter / e2e / done, the one reading of state vs chapters) and `resolveVerification()` (applies `workspace.verification_cwd`), shared by `nextChapter` and `verifyChapter`. |
| `mcp/server/src/artifacts.ts` | Artifact path conventions (`<workspace>/artifacts/NN-<id>.html`, `summary.html`), `artifactNav()` for footer links, and `CONVENTIONS_PATH`. |
| `mcp/server/src/outputStyle.ts` | The one reader of `~/.claude/settings.json`: `readClaudeSettings()`, `isClaudePluginEnabled()`, `getOutputStyleStatus()`, `writeOutputStyle()`. |
| `mcp/server/src/settings.ts` | `loadAccConfig` / `saveAccConfig` / `mergeAccConfig` for `~/.acc/config.json`. |
| `mcp/server/src/pathResolver.ts` | `resolveCoursePaths`, `substitutePathRefs`, `envVarsFor`, `envFileContents` — the only `${paths.<id>}` substitution channel. |
| `mcp/server/src/schemas/contentPaths.ts` | Validator for `accContent.paths` + cross-reference check against probe `${paths.<id>}` references. |
| `mcp/server/src/pluginsRoot.ts` | `discoverCourses()` — scans `~/.claude/plugins/installed_plugins.json` for `accContent` plugins. |
| `mcp/server/src/registry.ts` | `scanCourses()` + `loadLessonBySlug()` over the discovered course plugins (`lesson.json` + `chapters.json`). |
| `mcp/server/src/state.ts` | State load/save with atomic writes and corruption archiving. `STATE_SCHEMA_VERSION = 5`. State dir: `.acc/`. |
| `mcp/server/src/workspace.ts` | Course-owned, idempotent workspace lifecycle at `~/.acc/workspaces/<slug>/`. Host-tarball fingerprinting, solution-file stripping, archive-and-recreate on mismatch. |
| `mcp/server/src/personalization.ts` | `substitutePromptOnly()` — scope-guarded `{{ key }}` substitution. |
| `mcp/server/src/verify.ts` | Verification runner. Modes: `compile`, `test-suite`. Spawn injection seam preserved. |
| `mcp/server/src/preflight.ts` | Shared probe types only. ACC ships **zero** hardcoded probes. |
| `mcp/server/src/dynamicProbes.ts` | Declarative probe runner (`filesystem-exists`, `http-get`, `shell-exit-zero`, `claude-plugin-enabled`). |
| `mcp/server/src/schemas/courseProbes.ts` | Validator for `accContent.probes`. |
| `mcp/server/src/pathSafety.ts` | `containedPath` guard for host-side file writes, plus the shared `isSafeRelPath` / `isFilenameSafeId` predicates every manifest validator uses. |
| `mcp/server/src/schemas/lesson.ts` | `validateLesson()` for `<lesson>/lesson.json`. |
| `mcp/server/src/schemas/chapters.ts` | `validateChapters()` for `<lesson>/chapters.json`. |
| `mcp/server/src/schemas/common.ts` | `ValidationResult` + `validateRelPathList()` shared by the lesson and chapters validators. |
| `mcp/server/src/schemas/state.ts` | v5 state validator. |
| `mcp/server/src/schemas/workspace.ts` | Per-workspace `.course-state.json` metadata validator. |
| `tests/` | Vitest suites: schemas, discovery, registry, output style, personalization, probes, verify, workspace, chapter-loop tools, skill/agent/template harnesses. |

## Architectural invariants (do not break)

1. **Plugin discovery is read every call.** `discoverCourses()` doesn't memoize the registry file — a freshly-enabled course plugin shows up on the next `start` without an MCP-server restart.
2. **Each lesson's slug is namespaced** as `<course-plugin-key>/<lesson-slug>` everywhere it crosses a tool boundary.
3. **State writes are atomic.** `state.ts:saveState` writes to a tmp file with `wx` + `0o600`, fsyncs, then renames. Same helper (`atomicWrite.ts`) for every durable file ACC writes.
4. **Corrupt state recovery is two-tier.** Unreadable or invalid `state.json` is archived to `.acc/state.corrupt-<sha256-prefix>.json`; if the archive write fails, the diagnostic is returned without `archivedTo`.
5. **`{{ ... }}` substitution is scoped to chapter briefs only.** `personalization.ts:substitutePromptOnly` is the only function that performs it. Never call it on `expected_files`, `tests`, `verification.command`, or any path-shaped field.
6. **State schema versioning is on `STATE_SCHEMA_VERSION = 5`.** Older states surface as `schema-mismatch`. Never silently coerce.
7. **Workspaces are course-owned and idempotent.** `prepareWorkspace` fingerprints the host tarball into `host_signature` and reuses an existing workspace iff that signature matches. Mismatch → archive to `<workspace>.archive-<ts>/` and recreate. Solution files are stripped at seed time; the runtime never copies them back.
8. **Verification spawn is injectable.** `runVerification` accepts a `spawn` stub via `VerifyOptions.spawn`. No module-level test override.
9. **`start` never runs preflight probes.** Probes only run via `runPreflightProbe`, invoked by the course-engine after `selectLesson`.
10. **ACC ships zero domain probes.** Every probe is declared by a course plugin's `plugin.json`. A new probe kind requires a runtime change in ACC.
11. **`runPreflightProbe` resolves probe IDs against the merged registry.** Collisions: first-found wins with a discovery warning. Unknown IDs surface as a descriptive error.
12. **Artifacts are written by the conductor, recorded by `verifyChapter`.** The MCP never generates HTML. `verifyChapter` only checks that the conventional file exists and stores its path; a missing artifact is a warning, not a failure.
13. **Path safety is non-negotiable.** Every manifest path field is validated with `pathSafety.isSafeRelPath` (no `..`, no leading slash); every host-side write under the workspace resolves through `pathSafety.containedPath`; probe params go through `dynamicProbes.expandUserPath`. One predicate, one guard, no local copies.
14. **Configurable paths are a separate code path from personalization.** `${paths.<id>}` substitution lives in `pathResolver.substitutePathRefs` and runs ONLY against probe params + remediation, BEFORE the probe runner sees them.
15. **The output-style check is advisory.** No MCP tool refuses to run because of the active output style. `start` reports it; `setOutputStyle` changes it only when the learner says yes.

## When You Edit MCP Server Code

1. Edit under `mcp/server/src/`.
2. Run `pnpm build` from `mcp/server` (the plugin runs the *built* `dist/index.js`, not the source).
3. Run `pnpm test` from the repo root.
4. Restart Claude Code if the plugin is already loaded; MCP servers don't hot-reload.

## When You Author a Course or Lesson

Don't write lesson files by hand — invoke `course-creator` for a new course plugin and `lesson-creator` for each lesson. `lesson-creator` runs Phase 0 (docs), the plan, the tests + reference solution, the chapter briefs, and the learner validation pass, then writes `validation.json`.
