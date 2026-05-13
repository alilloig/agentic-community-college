---
name: course-creator
description: Scaffold a new ACC content plugin (a "course") from scratch — emits a Claude Code plugin manifest that declares accContent.lessons + accContent.probes, plus README, CLAUDE.md, .gitignore, and an empty lessons/ directory. Walks the user through declaring the course's prerequisite probes interactively using the four supported kinds (filesystem-exists, http-get, shell-exit-zero, claude-plugin-enabled). Use when the user asks to "create a new course", "scaffold a course plugin", "start a new ACC course", "add a domain to ACC", "create a Walrus/Seal/Move course", or wants to start a fresh content plugin before authoring any lesson.
---

# Course Creator Skill

You are scaffolding a fresh ACC content plugin. The output is a new directory on disk that, when enabled in Claude Code, hosts one or more lessons authored later by `lesson-creator`.

ACC ships **zero domain probes** — every prerequisite check a future lesson in this course might need is declared here, in the course's `plugin.json`. Four probe kinds are supported, listed below.

## Step 1 — Target directory

Ask the user where the new course should live. Default suggestion: `~/workspace/acc-<domain>-course/` (e.g. `~/workspace/acc-walrus-course/`). Refuse to overwrite an existing non-empty directory — if the target exists, ask for a different path.

`mkdir -p <target>/` and `mkdir -p <target>/lessons/`. Initialize git: `cd <target> && git init --initial-branch=main`.

## Step 2 — Plugin identity

Collect:

- **Plugin name** (the `name` field in `plugin.json`). Convention: `acc-<domain>-course` (e.g. `acc-walrus-course`). Lowercase, kebab-case.
- **One-line description** for the manifest.
- **Author** — pick up `git config user.name` as default, ask to confirm.
- **Keywords** — comma-separated list (e.g. `walrus, storage, sui, course`).

## Step 3 — Probe declarations (the load-bearing step)

### Pre-seeded probe

The template ships with one probe already declared: **`toolkit-installed`** (kind: `claude-plugin-enabled`, key: `toolkit@contract-hero`). ACC's conductor and `lesson-creator` delegate to skills bundled by that plugin (`publish-html`, `html-artifact`, `for-dummies`, `move-call-chains`).

Most lessons should leave `prerequisites: []` — toolkit absence degrades gracefully (the conductor's offers become install hints). Only add `"toolkit-installed"` to a lesson's `prerequisites` when section bodies explicitly drive the learner to invoke a toolkit skill mid-lesson.

The author can delete the seeded probe if they object to the dependency, but advise against it — the conductor's affordances assume it's declared somewhere accessible.

### Adding more probes

Ask the user: "What *additional* prerequisites does any lesson in this course need?"

Common categories to prompt them through:

- **Tools on PATH** — `node`, `pnpm`, `sui`, `docker`, language toolchains. Each becomes a `shell-exit-zero` probe checking the binary responds to `--version` (or similar).
- **Sibling repos / fixture directories** — e.g. `~/workspace/deepbook-sandbox/`. Each becomes a `filesystem-exists` probe.
- **Local services** — RPC endpoints, faucet URLs, dev servers. Each becomes an `http-get` probe with `expected_status: 200` (and optionally a `pnpm <bring-up>` shell remediation).
- **Other Claude Code plugins** — e.g. `sui-pilot@<marketplace>`. Each becomes a `claude-plugin-enabled` probe reading `~/.claude/settings.json`.

For each probe the user declares, collect:

- `id` — kebab-case identifier unique within this course (e.g. `sandbox-manifest-reachable`).
- `kind` — one of the four supported kinds.
- `message_pass` — what the conductor surfaces on success (one short sentence).
- `message_fail` — what the conductor surfaces on failure. **Make this actionable** — name the command, URL, or file the user needs to fix.
- `params` — kind-specific (see table below).
- `remediation` (optional, only for kinds that have a sensible auto-fix) — `{ kind: "shell", command, cwd?, timeout_ms? }`.

### Probe-kind cheat sheet

| Kind | Required params | Optional params | Example use |
|---|---|---|---|
| `filesystem-exists` | `path` (supports `~/`, must be absolute or `~/`-prefixed) | — | sibling repo, fixture dir |
| `http-get` | `url` | `expected_status` (default 200), `timeout_ms` (default 5000), `expected_body_regex` | service is alive, manifest reachable |
| `shell-exit-zero` | `command` | `args[]`, `timeout_ms` (default 10000), `expected_stdout_regex` | `sui --version`, `docker info`, version range check via regex |
| `claude-plugin-enabled` | `plugin_key` | — | other Claude Code plugins this course depends on |

For probes where a **remediation** is natural (e.g. `pnpm deploy-all --quick` for a stale sandbox manifest), ask the user. If they say yes, gather `command`, optional `cwd` (supports `~/`), optional `timeout_ms` (default 60000).

Render each probe back to the user before adding it; if they want to refine, iterate. Skip the probes step entirely with the user's explicit confirmation — many courses have no prerequisites.

## Step 4 — Emit files

Generate, in order:

1. `<target>/.claude-plugin/plugin.json` — fill out `templates/plugin.json.tmpl` with the collected name, description, author, keywords, and the probes array. The template hardcodes `"commands": ["./commands/start.md"]` and `accContent.lessons = "./lessons/"`.
2. `<target>/commands/start.md` — fill out `templates/start.md.tmpl` with the plugin name and a one-paragraph **welcome** the user supplies (or a sensible default). This is the learner's entry point — `/<name>:start` — and it delegates to ACC's `course-engine` skill with a course filter pinned to this plugin.
3. `<target>/README.md` — fill out `templates/README.md.tmpl` with the plugin name + a paragraph explaining this is an ACC content plugin and how to enable it.
4. `<target>/CLAUDE.md` — fill out `templates/CLAUDE.md.tmpl` with the working-notes shape every content plugin carries.
5. `<target>/.gitignore` — fill out `templates/.gitignore.tmpl` (covers `node_modules/`, `.vite/`, `dist/`, `.acc/`, OS junk).
6. `<target>/lessons/.gitkeep` — empty placeholder so the directory is tracked.

Use the lightweight `{{ key }}` substitutor (same shape as the lesson-creator templates) — no external template engine. Substitution variables across the templates: `{{ name }}`, `{{ description }}`, `{{ description_short }}`, `{{ author }}`, `{{ keywords_json }}`, `{{ welcome_paragraph }}`.

## Step 5 — Verify + commit (optional)

Tell the user the next steps:

1. Push the new course's git repo to a remote and add it to a marketplace (or install it locally), then `claude plugins install <name>@<marketplace>` so ACC's discovery picks it up.
2. Run `/agentic-community-college:list` — the new course should appear under "Discovered courses" with an empty lesson catalog.
3. Run `/agentic-community-college:create-lesson` against this course to author the first lesson.
4. `git add -A && git commit -m "chore: scaffold <name>"` inside the target dir.

Do **not** run git commands from this skill — leave it to the user so they can audit the diff first. Do not push to a remote unless the user asks.
