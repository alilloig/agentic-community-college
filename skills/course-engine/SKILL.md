# Course Engine Skill

When the user invokes `/sui-deepbook-course:start`, follow these steps:

1. Call the `start` MCP tool with the current project root as `projectRoot`.

2. Render the result:
   - **Output Style**: If `outputStyleOk` is `true`, confirm the learning output style plugin is active. If `false`, advise the user to enable `learning-output-style@claude-plugins-official` for the best experience (this is advisory only — the course still runs).
   - **Available Paths**: List each entry in `paths` with its `title` and `summary`. If `paths` is empty, inform the user that no learning paths are installed.
   - **Warnings**: If `warnings` is non-empty, display each warning's `kind` and `message` to help the user diagnose configuration issues.

3. In cycle 1, `preflight` is always `{ skipped: true, reason: "cycle-1" }` and `state` is always `null`. Do not prompt for path selection or lesson flow yet.

## After path selection (F-002)

When the user picks a path, call `selectPath({ projectRoot, slug })`.

If `result.ok` is `true`:
- **Render `result.description`** verbatim if present. This is the path's `description.md` body — what the learner is about to build, prerequisites, learning outcomes, duration. Show it BEFORE asking for personalization so the learner can opt out before tweaking knobs they don't yet understand.
- Then walk through `result.personalizationPrompts` to collect the learner's choices, and call `setPersonalization` with them.
- If `result.workspaceCreated` is `true`, briefly mention that the course has provisioned a fresh workspace at `result.workspacePath`. If `result.workspaceArchivedTo` is set, note that an older workspace was archived (host content changed).

If `result.ok` is `false`, surface `result.errors` and stop.
