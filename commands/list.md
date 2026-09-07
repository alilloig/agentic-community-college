# /agentic-community-college:list

List the ACC course plugins discovered on this machine and their lesson catalogs. **Read-only. Does not mint state or start a lesson.**

When the user invokes this:

1. Call the `start` MCP tool with `projectRoot` set to the user's working directory.
2. Render the response in three parts:
   - **Output style**: `result.outputStyle` is `{ active, recommended: "Concise", ok }`. If `ok` is false, say in one line that ACC recommends the `Concise` style and that the course's start command offers to set it. Informational only. The catalog still renders.
   - **Discovered courses**: `result.courses` is the list of plugin keys ACC sees. One bullet per course.
   - **Lesson catalog**: `result.lessons`, grouped by `course_name`. For each lesson show `namespaced_slug`, `title`, `summary`, and `chapter_count`.
3. **Warnings**: if `result.warnings` includes any `course-plugin-*` or `installed-plugins-*` kinds, render each warning's `kind` + `message` so the user can fix bad manifests before starting a lesson.

If the catalog is empty:

- If `result.courses` is empty too: advise the user to install at least one ACC content plugin (for example `claude plugins install acc-claude-sdk@contract-hero`) or scaffold one with `/agentic-community-college:create-course`.
- If `result.courses` has entries but `result.lessons` is empty: at least one course is enabled but contains no valid lessons. Surface the warnings array so the user can find the malformed manifest.

Do **not** call `selectLesson`, `setOutputStyle`, `setPersonalization`, `nextChapter`, or `verifyChapter`. To start a lesson, the user invokes the course's own start command (for example `/acc-claude-sdk:start`).
