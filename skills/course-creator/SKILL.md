---
name: course-creator
description: Scaffold a new ACC content plugin (a "course") from scratch. Emits a Claude Code plugin manifest that declares accContent.lessons + accContent.probes, plus a start command, README, CLAUDE.md, .gitignore, and an empty lessons/ directory. Walks the user through declaring the course's prerequisite probes with the four supported kinds (filesystem-exists, http-get, shell-exit-zero, claude-plugin-enabled). Use when the user asks to "create a new course", "scaffold a course plugin", "start a new ACC course", "add a domain to ACC", or wants a fresh content plugin before authoring any lesson.
---

# Course Creator Skill

You are scaffolding a fresh ACC content plugin. The output is a new directory on disk that, once enabled in Claude Code, hosts one or more lessons authored later by `lesson-creator`.

ACC ships **zero domain probes**. Every prerequisite check a lesson in this course needs is declared here, in the course's `plugin.json`. Four probe kinds are supported.

## Step 1: Target directory

Ask the user where the new course should live. Default suggestion: `~/workspace/acc/acc-<domain>/` (for example `~/workspace/acc/acc-walrus/`). Refuse to overwrite an existing non-empty directory. If the target exists, ask for a different path.

`mkdir -p <target>/lessons/`. Initialize git: `cd <target> && git init --initial-branch=main`.

## Step 2: Plugin identity

Collect:

- **Plugin name** (the `name` field in `plugin.json`). Convention: `acc-<domain>` (for example `acc-claude-sdk`). Lowercase, kebab-case.
- **One-line description** for the manifest.
- **Author**: default to `git config user.name`, ask to confirm.
- **Keywords**: comma-separated list (for example `walrus, storage, sui, course`).

## Step 3: Probe declarations

Ask the user: "What prerequisites does any lesson in this course need?"

Common categories:

- **Tools on PATH**: `node`, `pnpm`, `sui`, `docker`, language toolchains. Each becomes a `shell-exit-zero` probe that runs the binary with `--version`.
- **Sibling repos or fixture directories**: each becomes a `filesystem-exists` probe.
- **Local services**: RPC endpoints, dev servers. Each becomes an `http-get` probe with `expected_status: 200`, optionally with a shell remediation that brings the service up.
- **Other Claude Code plugins**: each becomes a `claude-plugin-enabled` probe that reads `~/.claude/settings.json`.

For each probe collect:

- `id`: kebab-case, unique within this course (`sandbox-manifest-reachable`).
- `kind`: one of the four kinds.
- `message_pass`: one short sentence shown on success.
- `message_fail`: shown on failure. Make it actionable: name the command, URL, or file to fix.
- `params`: kind-specific, see the table.
- `remediation` (optional): `{ kind: "shell", command, cwd?, timeout_ms? }`.

### Probe-kind cheat sheet

| Kind | Required params | Optional params | Example use |
|---|---|---|---|
| `filesystem-exists` | `path` (absolute or `~/`-prefixed) | none | sibling repo, fixture dir |
| `http-get` | `url` | `expected_status` (default 200), `timeout_ms` (default 5000), `expected_body_regex` | service is alive, manifest reachable |
| `shell-exit-zero` | `command` | `args[]`, `timeout_ms` (default 10000), `expected_stdout_regex` | `sui --version`, `docker info` |
| `claude-plugin-enabled` | `plugin_key` | none | another Claude Code plugin this course depends on |

When a remediation is natural (for example `pnpm deploy-all --quick` for a stale sandbox manifest), ask the user. On yes, gather `command`, optional `cwd` (supports `~/`), optional `timeout_ms` (default 60000).

Render each probe back to the user before adding it. Skip this step with the user's explicit confirmation: many courses have no prerequisites, and `probes: []` is valid.

`toolkit@contract-hero` is optional. The conductor offers `publish-html` only when that plugin is enabled. Do not declare a probe for it.

## Step 4: Emit files

Generate, in order:

1. `<target>/.claude-plugin/plugin.json` from `templates/plugin.json.tmpl`: name, description, author, keywords, probes array. The template hardcodes `"commands": ["./commands/start.md"]` and `accContent.lessons = "./lessons/"`.
2. `<target>/commands/start.md` from `templates/start.md.tmpl`: plugin name plus a one-paragraph welcome the user supplies (or a sensible default). This is the learner's entry point, `/<name>:start`. It delegates to ACC's `course-engine` skill with a course filter pinned to this plugin.
3. `<target>/README.md` from `templates/README.md.tmpl`.
4. `<target>/CLAUDE.md` from `templates/CLAUDE.md.tmpl`.
5. `<target>/.gitignore` from `templates/.gitignore.tmpl` (`node_modules/`, `.vite/`, `dist/`, `.acc/`, OS junk).
6. `<target>/lessons/.gitkeep`.

Fill `{{ key }}` placeholders with a plain string replace. Variables: `{{ name }}`, `{{ description }}`, `{{ description_short }}`, `{{ author }}`, `{{ keywords_json }}`, `{{ probes_json }}`, `{{ welcome_paragraph }}`. `{{ probes_json }}` is the JSON array body (empty string when there are no probes).

## Step 5: Next steps

Tell the user:

1. Push the course repo to a remote and add it to a marketplace, or install it locally, then `claude plugins install <name>@<marketplace>` so ACC's discovery picks it up.
2. Run `/agentic-community-college:list`. The new course appears under "Discovered courses" with an empty catalog.
3. Run `/agentic-community-college:create-lesson` against this course to author the first lesson.
4. `git add -A && git commit -m "chore: scaffold <name>"` inside the target dir.

Do not run git commands from this skill. Do not push to a remote unless the user asks.
