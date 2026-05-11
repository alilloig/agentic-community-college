# Agentic Community College (ACC) — Claude's working notes

A Claude Code plugin that runs reference-seeded coding lessons through MCP. ACC is the **framework** — it ships the MCP server, the conductor agent, and the authoring/runtime skills. Content lives in separate **course plugins** that declare `accContent` in their `plugin.json`; ACC discovers them at runtime.

The user-facing onboarding doc is `README.md`. This file is for Claude's context when working on the code.

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
- **Course** — a content plugin. Declares `accContent: { lessons: "./lessons/" }` in `plugin.json`. Discovered by ACC at runtime via `~/.claude/plugins/installed_plugins.json`. First one: [`acc-deepbook-course`](https://github.com/alilloig/acc-deepbook-course).
- **Lesson** — a single end-to-end learning experience inside a course (`lessons/<slug>/`). Always namespaced by course in the conductor flow: `<course-plugin-key>/<slug>`.
- **Section** — a single prompt inside a lesson. The learner advances section by section; each section has a `key_moment` line that steers learning-mode TODO placement.

## Component Map

| Path | Role |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest: name=`agentic-community-college`, commands/agents/skills/mcpServers registered. |
| `commands/start.md` | `/agentic-community-college:start` → delegates to course-engine skill. |
| `agents/course-conductor.md` | Section-loop driver dispatched after course-engine sets up the session. |
| `skills/course-engine/SKILL.md` | Entry-point skill: discovery → lesson selection → prerequisites → setOutputMode → setPersonalization → hand off to conductor. |
| `skills/course-creator/SKILL.md` | Authoring skill that scaffolds a new **course plugin** from scratch (plugin.json + accContent + probes + README + CLAUDE.md + empty lessons/). |
| `skills/course-creator/templates/` | `plugin.json.tmpl`, `README.md.tmpl`, `CLAUDE.md.tmpl`, `.gitignore.tmpl`. |
| `skills/lesson-creator/SKILL.md` | Authoring skill that scaffolds a new lesson into an existing course plugin. Handles on-demand probe declaration when a lesson lists a prerequisite the course hasn't declared yet. |
| `skills/lesson-creator/templates/` | `lesson.json.tmpl`, `sections.json.tmpl`, `template.html.tmpl`, `description.md.tmpl`. |
| `mcp/server/src/index.ts` | MCP entry; registers 8 tools and starts stdio transport when run as a script. |
| `mcp/server/src/tools/start.ts` | `start` — discovers courses + lists lessons + reports preflight/state. |
| `mcp/server/src/tools/runPreflightProbe.ts` | `runPreflightProbe` — runs a named probe (unchanged from sui-mcp-course). |
| `mcp/server/src/tools/selectLesson.ts` | `selectLesson` — mints v4 state, preps the workspace, returns description + personalization prompts + output-mode picker. |
| `mcp/server/src/tools/setOutputMode.ts` | `setOutputMode` — persists `selected_output_style`; warns on session-vs-state mismatch. |
| `mcp/server/src/tools/setPersonalization.ts` | `setPersonalization` — validates + persists personalization keys against the lesson's declared options. |
| `mcp/server/src/tools/nextSection.ts` | `nextSection` — substitutes personalization into the section body, returns body + key_moment + artifact_section_id. |
| `mcp/server/src/tools/verifySection.ts` | `verifySection` — runs the current or final verification spec; advances cursor on pass. |
| `mcp/server/src/tools/advanceArtifact.ts` | `advanceArtifact` — atomically rewrites `<workspace>/artifact-state.json` so the open browser tab self-updates. |
| `mcp/server/src/pluginsRoot.ts` | `discoverCourses()` — scans `~/.claude/plugins/installed_plugins.json` for `accContent` plugins. |
| `mcp/server/src/registry.ts` | `scanCourses()` + `loadLessonBySlug()` over the discovered course plugins. |
| `mcp/server/src/state.ts` | State load/save with atomic writes (tmp + fsync + rename) and corruption archiving. `STATE_SCHEMA_VERSION = 4`. State dir: `.acc/`. |
| `mcp/server/src/workspace.ts` | Course-owned, idempotent workspace lifecycle at `~/.acc/workspaces/<slug>/`. Host-tarball fingerprinting, archive-and-recreate on mismatch. |
| `mcp/server/src/outputStyle.ts` | `probeOutputStyle()` (gates every MCP tool) + `readActiveOutputStyle()` (informational, for the mismatch warning). |
| `mcp/server/src/personalization.ts` | `substitutePromptOnly()` — scope-guarded `{{ key }}` substitution. AC-6.3 invariant. |
| `mcp/server/src/verify.ts` | Verification runner. Modes: `compile`, `test-suite`. Spawn injection seam preserved. |
| `mcp/server/src/preflight.ts` | Shared types only (`ProbeResult`, `ShellAction`, `ProbeOptions`, `SpawnFn`). ACC ships **zero** hardcoded probes. |
| `mcp/server/src/dynamicProbes.ts` | Declarative probe runner. Interprets the 4 supported kinds (`filesystem-exists`, `http-get`, `shell-exit-zero`, `claude-plugin-enabled`). |
| `mcp/server/src/schemas/courseProbes.ts` | Validator for `accContent.probes` declarations in a course plugin's `plugin.json`. |
| `mcp/server/src/pathSafety.ts` | `containedPath` guard for any host-side file writes. |
| `mcp/server/src/pathsRoot.ts` | Legacy single-root resolver. Kept for dev-loop smoke tests; production discovery flows through `pluginsRoot.ts`. |
| `mcp/server/src/schemas/lesson.ts` | `validateLesson()` for `<lesson>/lesson.json`. |
| `mcp/server/src/schemas/sections.ts` | `validateSections()` for `<lesson>/sections.json`. |
| `mcp/server/src/schemas/state.ts` | v4 state validator. |
| `mcp/server/src/schemas/workspace.ts` | Per-workspace `.course-state.json` metadata validator. |
| `tests/` | Vitest suites covering schemas, plugin discovery, registry, output-style, personalization, preflight, verify, workspace, lesson-creator harness. |

## Architectural invariants (do not break)

1. **Output-style gate runs before any state load** in every gated MCP tool (`selectLesson`, `setOutputMode`, `setPersonalization`, `nextSection`, `verifySection`, `advanceArtifact`). Pattern: `probeOutputStyle()` → return early on `!ok` → only then `loadState`. Replicate this ordering when adding new gated tools.
2. **Plugin discovery is read every call.** `discoverCourses()` doesn't memoize the registry file — a freshly-enabled course plugin shows up on the next `start` without an MCP-server restart.
3. **Each lesson's slug is namespaced** as `<course-plugin-key>/<lesson-slug>` everywhere it crosses a tool boundary. Two course plugins shipping the same internal slug must not collide.
4. **State writes are atomic.** `state.ts:saveState` writes to a `tmp` file with `wx` + `0o600`, fsyncs via `FileHandle.sync()`, then renames over the canonical path. The same pattern is reused in `advanceArtifact` for `artifact-state.json`.
5. **Corrupt state recovery is two-tier.** If `state.json` is unreadable JSON or fails schema validation, the bytes are archived to `.acc/state.corrupt-<sha256-prefix>.json` (deduped via `wx`). If the archive write itself fails, return the diagnostic without `archivedTo` so the user knows to intervene manually.
6. **`{{ ... }}` substitution is scoped to section bodies only.** `personalization.ts:substitutePromptOnly` is the only function that performs it. Never call it on `expected_files`, `verification.command`, `artifact.template`, or any path-shaped field.
7. **State schema versioning is on `STATE_SCHEMA_VERSION = 4`.** Older states (v3 from sui-mcp-course) surface as `schema-mismatch`; the user re-runs `selectLesson` to mint fresh state. Never silently coerce.
8. **Workspaces are course-owned and idempotent (F-005 carry-forward).** `prepareWorkspace` lives at `~/.acc/workspaces/<slug>/`, fingerprints the host tarball into `host_signature`, and reuses an existing workspace iff that signature matches. Mismatch → archive to `<workspace>.archive-<ts>/` and recreate.
9. **Verification spawn is injectable.** `runVerification` accepts a `spawn` stub via `VerifyOptions.spawn` for hermetic tests. Don't re-introduce a module-level test override.
10. **`start` never runs preflight probes.** It returns `preflight: { skipped: true, reason: 'cycle-1' }` and leaves `state: null`. Probes only run via `runPreflightProbe`, invoked by the course-engine **after `selectLesson`** when the loaded lesson declares `prerequisites`.
11. **ACC ships zero domain probes.** Every probe is declared by a course plugin's `plugin.json` under `accContent.probes`. ACC owns the four interpreter kinds (`filesystem-exists`, `http-get`, `shell-exit-zero`, `claude-plugin-enabled`) in `dynamicProbes.ts` and nothing else. A new probe kind requires a runtime change in ACC; a new instance of an existing kind is just a JSON declaration in the course.
12. **`runPreflightProbe` resolves probe IDs against the merged registry** (the union of every enabled course plugin's declared probes). On collision across two courses, first-found wins; emit a warning at discovery time. Unknown IDs surface as a descriptive error — never silently no-op.
13. **`lesson.json:prerequisites` is a flat list of probe-ID strings.** The schema only enforces non-empty-string entries; runtime catches unknown IDs when `runPreflightProbe` runs. No hardcoded allowlist in the schema, no cross-reference table.
14. **HTML artifact updates flow through `advanceArtifact` only.** Don't have the conductor write `artifact-state.json` directly — the atomic-write seam is what makes the page poller's reads safe.
15. **Path safety is non-negotiable.** Anything that resolves a lesson-relative path (template files, body_md, host directory, verification cwd, probe `path` params, probe `cwd` remediations) goes through `pathSafety.containedPath` / the schema validators / `dynamicProbes.expandUserPath`. Reject `..` segments and leading slashes; require `~/` or absolute for declarative probe paths.

## Verification Modes

`verify.ts:runVerification` supports two modes today:

- **`compile`** — spawn `verification.command` in `cwd` (defaulting to the workspace root). Pass = exit 0. Used for typecheck/build gates.
- **`test-suite`** — spawn a test command (vitest, playwright, whatever). Pass = exit 0. Used by `final_verification` to gate lesson completion.

Anything else is rejected via `VerificationModeUnsupportedError`. The `simulate` and `custom` modes from the old runtime are retired.

## State v4 fields

```ts
interface State {
  schema_version: 4;
  selected_lesson: string;                              // namespaced slug
  selected_output_style: 'learning' | 'explanatory';
  personalization: Record<string, unknown>;
  section_cursor: number;
  history: HistoryEntry[];
  workspace_path?: string;                              // when lesson has workspace block
  test_status?: { pass: boolean; output?: string; ts?: string };
}
```

State lives at `<projectRoot>/.acc/state.json`.

## When You Edit MCP Server Code

1. Edit under `mcp/server/src/`.
2. Run `pnpm build` from `mcp/server` (the plugin runs the *built* `dist/index.js`, not the source).
3. Run `pnpm test` from the repo root.
4. Restart Claude Code if the plugin is already loaded; MCP servers don't hot-reload.

## When You Author a Content Plugin / Lesson

Don't write lesson files by hand — invoke the `lesson-creator` skill from inside any ACC-enabled session. It scaffolds the entire `lessons/<slug>/` tree, runs an offline-fixture transform on the seed app, and dispatches a learner sub-agent twice (once per output mode) to validate that the prompts actually produce passing tests.

## Test Coverage Status

- **Covered:** schemas (lesson, sections, workspace, state), `discoverCourses`, `scanCourses`, `outputStyle.probeOutputStyle`, `personalization.substitutePromptOnly` + `validatePersonalizationValues`, all preflight probes + `runPreflightProbe`, `verify.runVerification`, `workspace.prepareWorkspace` (legacy test deleted; needs rewrite — task #12), lesson-creator templates + skill frontmatter, sample-lesson cross-check.
- **Not yet covered:** the new MCP tools themselves (`selectLesson`, `setOutputMode`, `nextSection`, `verifySection`, `advanceArtifact`). Their dependencies are tested in isolation, but end-to-end harness coverage for the tools' input/output envelopes is on the deferred list.

Track deferred test work in task #12 ("update harness/legacy tests after paths/ deletion").
