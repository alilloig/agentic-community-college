---
name: lesson-creator
description: Author a new ACC lesson end-to-end from a topic and its documentation. Curates a docs snapshot (Phase 0), plans the ordered chapters, writes the per-chapter tests plus one e2e test and a reference solution that makes them pass, writes the chapter briefs and lesson manifests, then runs a learner sub-agent validation pass and records validation.json. Use when the user asks to "create a new lesson", "author an ACC lesson", "scaffold a lesson", "add a lesson about <topic>", or "turn these docs into a lesson".
---

# Lesson Creator Skill

You are authoring one lesson for the Agentic Community College (ACC) framework. A lesson is a topic split into **chapters**. Each chapter is defined by the tests it makes pass. At runtime the conductor implements every chapter, so the lesson ships the docs, the tests, the briefs, and a reference solution that proves the tests are satisfiable.

Run Steps 0 to 7 in order. Do not skip steps. The validation pass in Step 6 depends on every file being in place.

Output layout, inside the target course:

```
lessons/<slug>/
├── lesson.json          identity, prerequisites, workspace seeding rules
├── description.md       what the learner will build, why, prerequisites, time
├── docs/                Phase 0 snapshot: curated markdown + INDEX.md
├── chapters.json        ordered chapters, per-chapter verification, final e2e gate
├── chapters/NN-<id>.md  chapter briefs
├── reference-app/       complete working solution INCLUDING every test
└── validation.json      result of the learner validation pass
```

Templates live in `skills/lesson-creator/templates/`: `lesson.json.tmpl`, `chapters.json.tmpl`, `chapter.md.tmpl`, `description.md.tmpl`. Fill `{{ key }}` placeholders with a plain string replace. No template engine.

## Step 0: Inputs

Collect these with `AskUserQuestion` where a choice is involved, plain chat otherwise.

**Target course.** Call the `start` MCP tool with the user's `projectRoot`. Use `result.courses`:

- Empty: ask for the absolute path of a course repo on disk (for example `~/workspace/acc/acc-<domain>/`). Refuse to author into ACC itself.
- One entry: default to that course and confirm.
- Several entries: ask which one.

Resolve the target to `<course-install-dir>/lessons/<slug>/`. Refuse to overwrite an existing lesson directory.

**Topic.** One sentence: what the learner builds and which library or API it uses. Note the language and toolchain the topic implies (default: TypeScript, pnpm, vitest). Confirm.

**Docs source.** One of:

- absolute paths to local docs files or directories,
- one or more URLs,
- `retrieve`: ACC finds and fetches the official documentation in Step 1.

**Slug, title, summary.** Slug is kebab-case with a numeric prefix (`01-basic-agent`), unique inside the course. Title is human-readable. Summary is one sentence for the catalog.

**Prerequisites (optional).** Probe ids the course-engine must pass before the learner starts. Probes are declared in the course plugin's `plugin.json` under `accContent.probes`. ACC ships zero domain probes. For each prerequisite the user names:

1. Read `<course>/.claude-plugin/plugin.json` and check whether the id exists in `accContent.probes`.
2. If it exists, add the id to the lesson's `prerequisites`.
3. If it does not exist, offer to declare it now. Run the same probe wizard `course-creator` uses (kind, `message_pass`, `message_fail`, `params`, optional `remediation`). Append the declaration to `accContent.probes`, write the manifest back atomically, then add the id to `prerequisites`.
4. Never add a prerequisite id without a declaration. A missing probe breaks the course-engine at runtime.

**Personalization (optional).** Free-form keys with integer ranges (`min`, `max`, `default`) or enums (`values`, `default`). Most lessons ship none. Personalization values substitute `{{ key }}` in chapter briefs only.

## Step 1: Phase 0 docs

The implementing agent grounds every chapter in this snapshot, so curate it with care.

**Obtain the source.**

- Local paths: read them.
- URLs: fetch each page with `WebFetch`. Many documentation sites serve a markdown variant of every page; try `curl -sL <url>.md` first, then `<url>/index.md`, then the HTML page. Prefer the `.md` variant, it needs no cleanup.
- `retrieve`: find the official documentation site for the topic (`WebSearch`, or a URL you know), list the pages that cover the planned steps, then fetch them as above. Show the page list to the user before fetching.

**Curate into `<lesson>/docs/`.**

- One markdown file per concept, named by concept (`query.md`, `tools.md`, `sessions.md`).
- Trim each file to at most about 300 lines. Keep the parts a learner needs to implement the chapters: API signatures, option tables, and code examples. Drop navigation, marketing, changelogs, and unrelated sections.
- Keep only the lesson's language. Remove tabs and examples for other languages.
- Keep code examples verbatim. Do not rewrite them.
- Write `docs/INDEX.md`: one line per file with the filename, what it covers, and which chapter needs it. Add the source URL or path of each file.

Set `"docs": "docs/"` in `lesson.json` (Step 4).

## Step 2: Plan

Turn the topic into an ordered list of steps, then map every step to one chapter. Aim for 3 to 6 chapters. Chapter N builds on chapter N-1; the last chapter completes the feature.

For every chapter define:

- `id`: `cNN-<short-name>` (`c01-run-query`).
- `title`: human-readable.
- `key_idea`: the one concept the chapter artifact centers on. One or two sentences. Be specific.
- `expected_files`: workspace-relative files the conductor writes in this chapter.
- test cases: names plus one line on what each asserts.

Render the plan as a table and confirm it with the user via `AskUserQuestion` before Step 3. Refine until the user accepts it.

## Step 3: Tests and reference solution

Build `<lesson>/reference-app/` as a complete, working project.

1. **Scaffold.** `package.json`, `tsconfig.json`, vitest config, `src/` stubs, `.gitignore`. Use pnpm. Pin dependency versions.
2. **One test file per chapter.** `tests/NN-<id>.test.ts`. Tests exercise the public surface of that chapter's `expected_files`. Keep the whole suite under 30 seconds.
3. **One e2e test.** `tests/e2e.test.ts` drives the whole feature end to end.
4. **Offline by default.** Use fixtures, in-memory fakes, or a mock at the network boundary. A learner with no network must pass every chapter.
5. **Credentials.** When the topic needs a live credential (an API key), the e2e reads it from an environment variable. When the variable is absent, the e2e skips itself with a clear message that names the variable, for example `describe.skipIf(!process.env.ANTHROPIC_API_KEY)("e2e (ANTHROPIC_API_KEY not set: skipped)", ...)`. A skipped e2e exits 0. Chapter tests never need credentials.
6. **Implement the solution.** Write the code in `src/` until `pnpm install && pnpm vitest run` is green in `reference-app/`. Run each chapter's command too (`pnpm vitest run tests/NN-<id>.test.ts`).
7. **Decide `solution_files`.** List every file the conductor must write at runtime. Scaffold, config, fixtures, and tests are not solution files. Check the seed: copy `reference-app/` to a temp dir, delete the solution files, run the install command. The install must succeed and the tests must fail on missing modules, not crash the runner.

## Step 4: Chapter briefs and manifests

Write `<lesson>/chapters.json` from `chapters.json.tmpl`. One entry per planned chapter with `id`, `title`, `brief_md`, `key_idea`, `expected_files`, `tests`, and `verification`. Per-chapter `verification` is `{ "mode": "test-suite", "command": "pnpm vitest run tests/NN-<id>.test.ts" }`. `final_verification` is `{ "mode": "test-suite", "command": "pnpm vitest run" }`. Modes: `compile`, `test-suite`. Pass is exit 0.

Write one `<lesson>/chapters/NN-<id>.md` per chapter from `chapter.md.tmpl`. Three parts:

- **What we implement**: learner-facing, 3 to 6 lines. What the code does after this chapter and why it matters.
- **Done when**: one bullet per test in this chapter's test files. Test name plus what it asserts. Use the real names from the test files.
- **Implementation notes**: for the agent. Which `docs/` file to read first, pitfalls, constraints such as "do not touch package.json".

Write `<lesson>/lesson.json` from `lesson.json.tmpl`. Fill `slug`, `title`, `summary`, `prerequisites`, `docs`, `workspace.solution_files`, and any personalization. `workspace.host` is `reference-app`. Keep `workspace.files` empty unless a chapter needs a starter file that the solution does not contain.

Never put `{{ }}` in a path-shaped field. Substitution runs on briefs only.

## Step 5: Description

Write `<lesson>/description.md` from `description.md.tmpl`. What the learner will build, why it matters, prerequisites, estimated time. Keep it under 30 lines. The course-engine renders it right after `selectLesson`.

## Step 6: Validation pass

Prove that an agent can implement the lesson from the briefs and the docs alone.

1. Create a fresh temp workspace: `mktemp -d`. Copy `<lesson>/reference-app/` into it. Delete every `solution_files` entry. Run `host_install_command`.
2. Dispatch ONE learner sub-agent with the `Agent` tool (`subagent_type: general-purpose`). Prompt:

   > You implement an ACC lesson as its conductor would. Lesson directory: `<abs lesson dir>`. Workspace: `<abs temp dir>`. Never read `<abs lesson dir>/reference-app/`. For every chapter in `chapters.json`, in order: read `chapters/NN-<id>.md`, `docs/INDEX.md` and the docs files it points at, and the chapter's test files. Edit only the chapter's `expected_files` inside the workspace. Run `verification.command` from the workspace until it exits 0, at most 5 attempts per chapter; then stop and report. After the last chapter run `final_verification.command`. Report: chapters passed out of total, the final exit code, and the last 60 lines of test output.

3. Write `<lesson>/validation.json`:

   ```json
   {
     "ran_at": "<ISO-8601>",
     "exit_code": 0,
     "chapters_passed": 4,
     "total_chapters": 4,
     "transcript_excerpt": "<last 60 lines>"
   }
   ```

4. On failure (`exit_code !== 0`, or `chapters_passed < total_chapters`): find the failing chapter in the transcript. Ask the user: refine the brief, the docs, or the tests, or accept the failure as a known issue. If refining, edit and re-run this step in a new temp workspace. If accepting, add a `known_issues` array to `validation.json` with one entry per failure.

Remove the temp workspace when done.

## Step 7: Hand-off

Summarize the lesson: chapters, test counts, docs files, validation result. Recommend `git add` + commit inside the course repo. Do not run git commands from this skill. The user audits the diff first.

Tell the user how to run it: enable the course plugin, then run `/<course>:start`.

## Skipping validation

If the user asks to skip Step 6 (`--skip-validation`), still write `validation.json` as a placeholder:

```json
{
  "ran_at": "<ISO-8601>",
  "validation_skipped": true,
  "reason": "<user-provided reason>"
}
```

Never skip silently, so a reviewer can tell an unvalidated lesson apart from a validated one.
