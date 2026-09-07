# /agentic-community-college:list

List the ACC course plugins discovered on this machine and their lesson catalogs. **Read-only. Does not mint state or start a lesson.**

When the user invokes this:

1. Call the `start` MCP tool with `projectRoot` set to the user's working directory.
2. Render `result` exactly as the `course-engine` skill's step 1 describes, with no course filter.
3. Add one line about the output style: when `result.outputStyle.ok` is false, say ACC recommends the `Concise` style and that the course's start command offers to set it. Informational only. The catalog still renders.

If the catalog is empty:

- If `result.courses` is empty too: advise the user to install at least one ACC content plugin (for example `claude plugins install acc-claude-sdk@contract-hero`) or scaffold one with `/agentic-community-college:create-course`.
- If `result.courses` has entries but `result.lessons` is empty: at least one course is enabled but contains no valid lessons. Surface the warnings array so the user can find the malformed manifest.

Do **not** call `selectLesson`, `setOutputStyle`, `setPersonalization`, `nextChapter`, or `verifyChapter`. To start a lesson, the user invokes the course's own start command (for example `/acc-claude-sdk:start`).
