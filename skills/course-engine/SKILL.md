---
name: course-engine
description: ACC entry-point skill — invoked by /agentic-community-college:start. Renders the discovered courses and their lessons, lets the learner pick one, walks them through output-mode selection and personalization via MCP tools, then hands off to the course-conductor agent for the section loop.
---

# Course Engine Skill

When the user invokes `/agentic-community-college:start`, follow these steps.

## 1. Probe the session

Call the `start` MCP tool with the user's `projectRoot` (the working directory).

Render the result:

- **Output style**: If `outputStyleOk` is `true`, briefly confirm the learning output style plugin is active. If `false`, advise the user to enable `learning-output-style@claude-plugins-official` for the best experience (advisory — ACC still runs without it, but the tool gate stays closed).
- **Discovered courses**: List `result.courses` (plugin keys). If empty, tell the user no course plugins are enabled and stop — there is nothing to learn until they install one.
- **Lesson catalog**: List each `result.lessons` entry with its `namespaced_slug`, `title`, and `summary`, grouped by `course_name`. If the catalog is empty (courses present but no lessons), surface the warning array and stop.
- **Warnings**: If `result.warnings` is non-empty, render each warning's `kind` + `message` so the user can diagnose configuration issues.

In cycle 1, `preflight` is always `{ skipped: true, reason: 'cycle-1' }` and `state` is always `null`. Do not run a preflight loop yet.

## 2. Lesson selection

Ask the user which lesson they want to take. They should refer to it by its `namespaced_slug` (e.g. `acc-deepbook-course@local/01-market-stats`).

When they pick one, call `selectLesson({ projectRoot, slug })`.

If `result.ok` is `false`, surface `result.errors` verbatim and stop.

If `result.ok` is `true`:

- Render `result.description` verbatim if present (it's the lesson's `description.md` body — what the learner is about to build, prerequisites, learning outcomes).
- If `result.workspaceCreated === true`, briefly mention the workspace was provisioned at `result.workspacePath`. If `result.workspaceArchivedTo` is set, note that an older workspace was archived because the host content changed.

## 3. Output mode

Render `result.outputModePrompt.message` and ask the user to pick `learning` or `explanatory`. Once chosen, call `setOutputMode({ projectRoot, style })`.

If the result includes a `warnings` entry with `kind: 'output-style-mismatch'`, surface its message — it tells the user their Claude Code session output style doesn't match what they picked in ACC, and how to align them via `/output-style`.

## 4. Personalization

If `selectLesson` returned a `personalizationPrompts` array, walk it: for each entry, ask the user for a value (or accept the default). Collect the chosen values into a single object and call `setPersonalization({ projectRoot, values })`. Passing `{}` accepts every default.

If the lesson has no personalization options, skip this step (call `setPersonalization({ projectRoot, values: {} })` to lock in the defaults).

## 5. Hand off to the conductor

Once the four MCP setup tools have all returned `ok: true`, dispatch the `course-conductor` agent to drive the section loop. The conductor reads state on its own and walks the learner through each section, advancing the HTML artifact and gating on `verifySection`.

Keep your own narration terse — the conductor takes over the learner-facing voice from here.
