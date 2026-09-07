---
name: course-engine
description: ACC's session-driver skill, invoked by each course plugin's start command (for example /acc-claude-sdk:start). Renders the lesson catalog filtered to one course, checks the Claude Code output style and offers to set Concise, walks the learner through lesson selection, runs the picked lesson's prerequisite probes, collects personalization, then hands off to the course-conductor agent for the chapter loop. Use when the invoker says "run the ACC course engine", "start an ACC lesson", or "drive a lesson from <course>".
---

# Course Engine Skill

Follow the six steps in order. Keep your narration terse.

## 1. Probe the session

Call the `start` MCP tool with the user's `projectRoot` (the working directory).

**Course filter.** When the invoking command names a course (a per-course `start.md` saying "filter to `acc-claude-sdk`"), drop every `result.lessons` entry whose `course_name` does not start with that plugin name. Without a filter, render every discovered course.

Render:

- **Discovered courses**: the filtered `result.courses` (plugin keys). If empty after filtering, say the named course is not enabled and stop.
- **Lesson catalog**: each filtered `result.lessons` entry with `namespaced_slug`, `title`, `summary`, and `chapter_count`, grouped by `course_name`. If empty, render `result.warnings` and stop.
- **Warnings**: each entry's `kind` + `message` when `result.warnings` is non-empty.

`start` never runs probes. Probes run in step 4, only for the picked lesson.

## 2. Output style

`result.outputStyle` is `{ active, recommended: "Concise", ok }`. `ok` is true when `active` equals `recommended`.

- `ok: true`: one short confirmation, nothing more.
- `ok: false`: call `AskUserQuestion` with `header`: "Output style", `question`: "ACC works best with the Concise output style. Set it now?", options:
  - `"Yes, set Concise (Recommended)"`
  - `"No, keep my current style"`

  On yes, call `setOutputStyle({ style: "Concise" })`. Tell the learner the setting is written to `~/.claude/settings.json`, and that `/output-style Concise` switches the current session immediately. On `ok: false`, surface `errors` verbatim, say the style was not changed, and continue. On no, continue.

The check is advisory. No tool refuses to run because of the active style.

## 3. Lesson selection

Ask the user which lesson to take. They refer to it by `namespaced_slug` (for example `acc-claude-sdk@contract-hero/01-basic-agent`).

Call `selectLesson({ projectRoot, slug })`.

If `result.ok` is false, surface `result.errors` verbatim and stop.

If `result.ok` is true:

- Render `result.description` verbatim when present. It is the lesson's `description.md`: what the learner is about to build, prerequisites, time.
- If `result.workspaceCreated === true`, say the workspace was seeded at `result.workspacePath` with the scaffold and the tests, without the solution files listed in `result.workspaceStrippedFiles`.
- If `result.workspaceArchivedTo` is set, say the host content changed, so an older workspace was archived and the lesson starts fresh at chapter 1.
- Render `result.warnings` when present, one line per `{ kind, message }`. A `state-corrupt` warning means the previous `state.json` was unreadable. Name its `archivedTo` path when the warning carries one.

### 3a. First-run workspace setup

If `result.firstRunSetup?.needsWorkspaceRoot === true`, the user has never picked a workspace root on this machine. Run this one-time prompt before step 4:

- Surface `result.firstRunSetup.defaultWorkspaceRoot` (typically `~/workspace`) as the recommended default.
- Call `AskUserQuestion` with `header`: "Workspace root", `question`: "Where should ACC put per-course project checkouts?", options:
  - `"Use the default (~/workspace)"` (Recommended)
  - `"Pick a custom path"`: follow up in chat for the literal path; treat empty input as the default.
- Call `configureWorkspace({ workspace_root: <chosen> })`. On `ok: true`, say `~/.acc/config.json` was written. On `ok: false`, surface the errors and stop.
- **Refresh the workspace.** The first `selectLesson` seeded the workspace against the default config, so its `.env.acc-paths` file points at default paths. Re-call `selectLesson({ projectRoot, slug })` once after `configureWorkspace` returns `ok: true`. `prepareWorkspace` is idempotent on the host signature, so the workspace is reused and only the env file is rewritten. Use the refreshed `result` for the rest of the session.
- If `result.firstRunSetup` is absent, skip this step.

Paths declared by the course default to `<workspace_root>/<manifest-default>`. The learner can edit `~/.acc/config.json` later, or call `configureWorkspace({ course_paths: {...} })` for per-id overrides. Do not prompt for those unless the user asks.

### 3b. Resume or start over

`result.resumed` is true when state already held this lesson, the lesson is not complete, and the workspace was reused. The recorded artifacts are kept.

Only when `result.resumed` is true:

- Say the lesson resumes at chapter `result.chapter_cursor + 1`. `chapter_cursor` is 0-based.
- Say `selectLesson({ projectRoot, slug, restart: true })` starts the lesson over at chapter 1.
- Call `AskUserQuestion` with `header`: "Resume", `question`: "This lesson is already in progress. Resume or start over?", options:
  - `"Resume at chapter N"` (Recommended): continue with this `result`.
  - `"Start over"`: call `selectLesson({ projectRoot, slug, restart: true })` once and use that `result` for the rest of the session.

When `result.resumed` is absent or false, ask nothing. The lesson starts at chapter 1.

## 4. Prerequisites

If `result.prerequisites` is a non-empty array, call `runPreflightProbe({ probeId })` for each id.

- `pass: true`: move on.
- `pass: false` with no `action`: surface `message` verbatim. Tell the learner to fix it, then re-run the course's start command.
- `pass: false` with an `action`: surface the message and the action's command. Ask the learner whether to run the remediation. Only on an explicit yes, call `runPreflightProbe({ probeId, remediate: true })`. If the remediation also fails, stop the session.

Block step 5 until every prerequisite returns `pass: true`. Print one status line per probe.

If `result.prerequisites` is absent or empty, skip this step.

## 5. Personalization

If `selectLesson` returned a `personalizationPrompts` array, walk it: ask the user for each value, or accept the default. Collect the values into one object and call `setPersonalization({ projectRoot, values })`.

If the lesson has no personalization options, call `setPersonalization({ projectRoot, values: {} })` to lock in the defaults.

Check `result.ok`. On `ok: false`, surface `result.errors` verbatim and ask the learner for the values again. Do not go to step 6 until `setPersonalization` returns `ok: true`.

## 6. Hand off to the conductor

Once `selectLesson`, every `runPreflightProbe`, and `setPersonalization` have succeeded, dispatch the `course-conductor` agent. The conductor reads state on its own and runs the chapter loop: per chapter it tells the learner what gets built, implements the code until the chapter's tests pass, writes the chapter's HTML artifact, calls `verifyChapter`, and pauses.

Say one sentence: the conductor takes over from here.
