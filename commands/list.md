# /agentic-community-college:list

List the ACC course plugins discovered on this machine and their lesson catalogs. **Read-only — does not mint state or start a lesson.**

When the user invokes this:

1. Call the `start` MCP tool with `projectRoot` set to the user's working directory.
2. Render the response in three sections:
   - **Output style**: if `outputStyleOk` is `false`, surface the warning briefly so the user knows the gated tools (selectLesson, setOutputMode, …) will refuse to mutate state until the learning output style plugin is enabled. This is informational only — the catalog still renders.
   - **Discovered courses**: `result.courses` is the list of plugin keys ACC sees. Render one bullet per course.
   - **Lesson catalog**: `result.lessons`, grouped by `course_name`. For each lesson show its `namespaced_slug`, `title`, and `summary`. Indicate `section_count` if you have screen real estate.
3. **Warnings**: if `result.warnings` includes any `course-plugin-*` or `installed-plugins-*` kinds, render each warning's `kind` + `message` so the user can debug bad manifests before trying to start a lesson.

If the catalog is empty:

- If `result.courses` is empty too: advise the user to install at least one ACC content plugin (e.g. `claude plugins install acc-deepbook-course@contract-hero`) or scaffold one with `/agentic-community-college:create-course`.
- If `result.courses` has entries but `result.lessons` is empty: at least one course is enabled but contains no valid lessons. Surface the warnings array so the user can find the malformed manifest.

Do **not** call `selectLesson`, `setOutputMode`, `setPersonalization`, `nextSection`, `verifySection`, or `advanceArtifact`. To actually start a lesson, the user invokes the course's own start command (e.g. `/acc-deepbook-course:start`).
