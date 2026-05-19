---
name: course-engine
description: ACC's session-driver skill — invoked by each course plugin's start command (e.g. /acc-deepbook-course:start). Renders the lesson catalog (optionally filtered to a single course), walks the learner through lesson selection, runs the picked lesson's prerequisite probes, collects output mode + personalization via MCP tools, then hands off to the course-conductor agent for the section loop. Use when the invoker says something like "run the ACC course engine", "start an ACC lesson", "drive a lesson from <course>".
---

# Course Engine Skill

When invoked, follow these steps. Each step's MCP tool gates on the learning output style being enabled (`outputStyleOk`); if it isn't, the tools refuse to mutate state.

## 1. Probe the session

Call the `start` MCP tool with the user's `projectRoot` (the working directory).

**If the invoking command supplied a course filter** (e.g. a per-course start.md saying "filter to `acc-deepbook-course`"), apply it now: drop any `result.lessons` entry whose `course_name` doesn't start with the named course's plugin name. Without a filter, render every discovered course.

Render the result:

- **Output style**: If `outputStyleOk` is `true`, briefly confirm the learning output style plugin is active. If `false`, advise the user to enable `learning-output-style@claude-plugins-official` for the best experience (advisory — ACC still runs without it, but the tool gate stays closed).
- **Discovered courses**: List the (filtered) `result.courses` (plugin keys). If empty after filtering, tell the user the named course isn't enabled and stop.
- **Lesson catalog**: List each (filtered) `result.lessons` entry with its `namespaced_slug`, `title`, and `summary`, grouped by `course_name`. If empty, surface the warning array and stop.
- **Warnings**: If `result.warnings` is non-empty, render each warning's `kind` + `message` so the user can diagnose configuration issues.

`start` itself never runs preflight probes — it returns `preflight: { skipped: true, reason: 'cycle-1' }` and leaves `state: null`. Probes are run later, in step 3, only when the picked lesson declares prerequisites. Don't try to enumerate every probe up front.

## 2. Lesson selection

Ask the user which lesson they want to take. They should refer to it by its `namespaced_slug` (e.g. `acc-deepbook-course@local/01-market-stats`).

When they pick one, call `selectLesson({ projectRoot, slug })`.

If `result.ok` is `false`, surface `result.errors` verbatim and stop.

If `result.ok` is `true`:

- Render `result.description` verbatim if present (it's the lesson's `description.md` body — what the learner is about to build, prerequisites, learning outcomes).
- If `result.workspaceCreated === true`, briefly mention the workspace was provisioned at `result.workspacePath`. If `result.workspaceArchivedTo` is set, note that an older workspace was archived because the host content changed.

### 2a. First-run workspace setup

If `result.firstRunSetup?.needsWorkspaceRoot === true`, the user has never picked a workspace root on this machine. Run a one-time prompt **before continuing to step 3**:

- Surface `result.firstRunSetup.defaultWorkspaceRoot` (typically `~/workspace`) as the recommended default.
- Use `AskUserQuestion` with `header: "Workspace root"`, `question: "Where should ACC put per-course project checkouts?"`, and two options:
  - `"Use the default (~/workspace)"` (Recommended)
  - `"Pick a custom path"` — if the user picks this, follow up in chat for the literal path; treat empty input as the default.
- Call `configureWorkspace({ workspace_root: <chosen> })`. On `ok: true`, mention briefly that `~/.acc/config.json` was written. On `ok: false`, surface the errors and stop — the lesson can't continue without a workspace root.
- If `result.firstRunSetup` is absent, skip this step entirely.

Note: paths declared by the course (like `sandbox`) default to `<workspace_root>/<manifest-default>`. The learner can hand-edit `~/.acc/config.json` later, or invoke `configureWorkspace({ course_paths: {...} })` for per-id overrides. The conductor doesn't need to prompt for those here unless the user explicitly asks.

## 3. Prerequisites

If `result.prerequisites` is a non-empty array, the lesson requires environmental checks before the learner can proceed. For each probe ID in the array, **call `runPreflightProbe({ probeId })`**.

- If the probe returns `pass: true`, move on.
- If it returns `pass: false` with no `action`, surface the `message` verbatim and tell the learner to fix it manually, then re-run `/agentic-community-college:start` to retry.
- If it returns `pass: false` with an `action` (a remediation), surface both the message and the action's command. Ask the learner whether to run the remediation. **Only on explicit yes**, call `runPreflightProbe({ probeId, remediate: true })`. If the remediation also fails, stop the session — the learner needs to debug manually.

Block step 4 until every prerequisite returns `pass: true`. Surface a brief status line per probe so the learner can see which checks passed.

If `result.prerequisites` is absent or empty, skip this step entirely.

## 4. Output mode

**Always surface this choice with `AskUserQuestion`** — never accept it from inline conversation, never assume a default, never proceed past this step without an explicit user selection. The two output modes drive radically different pedagogy and the learner needs to make the call deliberately.

Render `result.outputModePrompt.message` and then call `AskUserQuestion` with:
- `header`: "Output mode"
- `question`: "Which output mode do you want for this lesson?"
- Two options, **`learning` first** (the recommended default):
  - `"Learning — pace section-by-section, leave TODOs for me"` — description: *"The implementing agent works alongside you, leaving the load-bearing pieces of each section as TODOs for you to write. Slower, deeper. ~90 minutes for the deepbook market-stats lesson."*
  - `"Explanatory — implement everything, narrate as we go"` — description: *"The implementing agent writes every section's code, with brief explanations between. You read along. ~30–45 minutes."*

Translate the user's pick to the literal value `'learning'` or `'explanatory'` and call `setOutputMode({ projectRoot, style })`.

If the result includes a `warnings` entry with `kind: 'output-style-mismatch'`, surface its message — it tells the user their Claude Code session output style doesn't match what they picked in ACC, and how to align them via `/output-style`.

## 5. Personalization

If `selectLesson` returned a `personalizationPrompts` array, walk it: for each entry, ask the user for a value (or accept the default). Collect the chosen values into a single object and call `setPersonalization({ projectRoot, values })`. Passing `{}` accepts every default.

If the lesson has no personalization options, skip this step (call `setPersonalization({ projectRoot, values: {} })` to lock in the defaults).

## 6. Hand off to the conductor

Once every setup tool (`selectLesson`, the per-prerequisite `runPreflightProbe` runs, `setOutputMode`, `setPersonalization`) has succeeded, dispatch the `course-conductor` agent to drive the section loop. The conductor reads state on its own and walks the learner through each section, advancing the HTML artifact and gating on `verifySection`.

Keep your own narration terse — the conductor takes over the learner-facing voice from here.
