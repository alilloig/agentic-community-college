---
name: lesson-creator
description: Author a new ACC lesson end-to-end — seeds a reference codebase into a target course, drafts the ordered section sequence with per-section key-moment emphasis, writes the test suite that gates equivalence, generates the evolving HTML artifact, and runs a learner-sub-agent validation pass under both learning and explanatory output styles before committing the result. Use when the user asks to "create a new lesson", "author an ACC lesson", "scaffold a lesson", "add a lesson from a reference app", or "build a course module from existing code".
---

# Lesson Creator Skill

You are authoring a new lesson for the Agentic Community College (ACC) framework. A lesson is a hard copy of a reference codebase plus a curated set of step-by-step prompts that drives a learner to a functionally-equivalent implementation. Each lesson is emitted into a **course** (a separate Claude Code plugin that declares `accContent`).

Run the 7 steps below in order. Don't skip steps — the validation pass at the end depends on every artifact being in place.

## Step 1 — Target selection

Call the `start` MCP tool (`agentic-community-college:start`) with the user's `projectRoot`. Use the `courses` array in the response to determine which content plugins are enabled.

- If `result.courses` is empty, ask the user where the new lesson should land. Offer the absolute path of an existing content repo on disk (e.g. `~/workspace/acc-deepbook-course/`). Refuse to author into ACC itself.
- If `result.courses` has one entry, default to that course's `lessons/` directory and confirm with the user.
- If `result.courses` has multiple entries, ask the user which one to author into.

Resolve the target to an absolute path: `<course-install-dir>/lessons/`. The skill emits a new directory `<course-install-dir>/lessons/<slug>/` containing every artifact for this lesson.

## Step 2 — Input gathering

Ask the user (using AskUserQuestion where natural) for:

- **Source reference-app dir**: absolute path to the working codebase the lesson teaches (e.g. `~/workspace/deepbook-sandbox-evaluation-apps/independent/01-market-stats`). Read its directory tree before continuing.
- **Slug**: short kebab-case identifier (e.g. `01-market-stats`). Must be unique inside the target course.
- **Title**: human-readable, e.g. "DeepBook Market Stats".
- **Summary**: one-sentence elevator pitch shown in the lesson catalog.
- **Personalization** (optional): list of free-form keys with their ranges (integer min/max/default) or enums (values/default). Most lessons ship with no personalization.
- **Chapter breakdown**: ask whether to (a) **auto-derive** sections from the reference-app's natural milestones (you read the code and propose 5–10 sections), or (b) **manual** (the user names the sections).

## Step 3 — Seed transform

Copy the source reference-app into `<lesson>/reference-app/`. Then **transform it to be offline-runnable** — the lesson must compile and pass its tests with no external dependencies:

- Identify every live-network dependency (`fetch` to live RPC, Vite middleware proxying to a live API, env vars pointing at sandbox endpoints). Read the app to find them.
- Replace each with an in-bundle fixture. Concretely, two common patterns:
  - **Vite dev-server middleware** that reads from outside the repo → replace with one that serves a JSON fixture under `reference-app/fixtures/`.
  - **`globalThis.fetch` to a JSON-RPC / HTTP endpoint** → mock at the boundary via `dataLayer.offline.ts` (or equivalent) keyed on method name, returning canned responses from `reference-app/fixtures/`.
- Run `pnpm install && pnpm vitest run` inside `reference-app/` to confirm the existing test suite passes against the stubs. If any fail, fix the stubs before continuing — the test suite IS the lesson's equivalence gate.

## Step 4 — Section authoring

Draft `<lesson>/sections.json` and one `<lesson>/sections/NN-<slug>.md` per chapter.

Use `skills/lesson-creator/templates/sections.json.tmpl` as the starting shape. For each section, supply:

- `id` — `s01-<short-name>`, `s02-...`, etc.
- `title` — human-readable.
- `body_md` — `sections/NN-<short-name>.md`. Write the body now; keep it short. Tell the learner what to build and which file(s) to edit. The HTML artifact carries the depth.
- `key_moment` — 1–2 sentences naming the load-bearing piece of code in this section. This is the single most important field — it's what steers the learning-mode agent to leave its TODO at the right place. Be specific: "the bit-math that decodes the order_id" beats "the dataLayer logic".
- `expected_files` — list of workspace-relative files this section produces or touches.
- `artifact_section_id` — matches a `<section data-section-id="…">` in the artifact template (next step).
- `verification` — usually omit (every section gates on the same final test suite). Add only when a section needs a mid-lesson `compile` check that's distinct from the final gate.

The final `final_verification` is mandatory:

```json
{ "mode": "test-suite", "command": "pnpm vitest run" }
```

## Step 5 — Test authoring

Copy the reference-app's vitest suite into `<lesson>/tests/`. The path layout is your call (unit/, scenario/, e2e/ subdirs are fine; flat is also fine). Add one extra **e2e** test that asserts the assembled app renders the expected UI when seeded with the fixture data — this catches "the prompts produced syntactically-correct code that doesn't actually work" failures.

Keep the tests fast (under 30s total). Long-running playwright tests are out of scope — vitest + React Testing Library + jsdom is the default stack.

## Step 6 — Artifact authoring

Draft `<lesson>/artifact/template.html` from `skills/lesson-creator/templates/template.html.tmpl`. The skeleton ships:

- Inline `<style>` (dark theme, mirrors `path-map.html`'s tokens).
- Inline JS poller (~40 lines, already in the template) that re-reads `./artifact-state.json` every 2s and toggles `data-visible` on sections whose `data-section-id` matches `revealed[]`.
- One `<section data-section-id="…">` block per lesson section, in order, each hidden by default.
- An inline SVG architecture diagram of the final app (you draw this fresh — it's the single most-viewed piece of content during the lesson).

Each section block should:

- State what the learner has built so far.
- Visualize the new piece they're adding (boxes-and-arrows SVG, code snippets, a per-section flow diagram).
- Avoid duplicating the section's `body_md` text — the body is the *what*, the artifact is the *why and how*.

Run `python3 -m http.server` (or `open file://…`) and confirm the artifact renders correctly in a browser before continuing.

## Step 7 — Validation pass

Dispatch a learner sub-agent **twice** — once per output style — and confirm `vitest` passes in each run.

Use the `Agent` tool with `subagent_type: skill-runner` and `isolation: "worktree"`. The sub-agent's prompt:

> You are a learner taking an ACC lesson. The lesson lives at `<absolute path to lesson dir>`. Your workspace is `~/.acc/workspaces/<slug>/`. Walk through the sections in order: for each, read `sections/NN-*.md`, implement the code as instructed, and proceed. After the last section, run `cd <workspace> && pnpm vitest run`. Report exit code + last 50 lines of output. Output style is currently set to `<learning|explanatory>` — honor whatever the active style expects.

Run the dispatch sequentially:

1. First with the learner's Claude Code session in `learning` output style.
2. Then again with the session in `explanatory` output style.

Capture each run's exit code and `vitest` summary. Write the result to `<lesson>/validation.json`:

```json
{
  "ran_at": "<ISO-8601>",
  "learning":   { "exit_code": 0, "tests_passed": <n>, "transcript_excerpt": "<last 50 lines>" },
  "explanatory":{ "exit_code": 0, "tests_passed": <n>, "transcript_excerpt": "<last 50 lines>" }
}
```

If either run fails (`exit_code !== 0` or fewer tests passed than expected):

- Identify the failing section by re-reading the transcript.
- Ask the user: refine the section's `body_md` / `key_moment`, or accept the failure as a documented known issue? (Some sections legitimately have multiple valid implementations; if `vitest` is too strict, that's a test-suite issue, not a prompt issue.)
- If refining, edit the section and re-run only the failing mode's pass.
- If accepting, add a `known_issues` array to `validation.json` listing the failure.

Only emit a final `validation.json` once both modes are accepted.

## Final commit

Once `validation.json` is written, summarize the new lesson to the user and recommend they `git add` + commit inside the target course repo. Do not run git commands from this skill — leave it to the user so they can audit the diff first.

## Skipping validation

If the user explicitly asks to skip step 7 (e.g. `--skip-validation`), still write a `validation.json` placeholder noting that validation was skipped:

```json
{
  "ran_at": "<ISO-8601>",
  "validation_skipped": true,
  "reason": "<user-provided reason>"
}
```

Never silently skip — always emit the file so downstream tooling can detect unvalidated lessons.
