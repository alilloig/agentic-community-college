# Agentic Community College (ACC)

A Claude Code plugin that turns a Claude Code session into an interactive coding tutor. ACC is the **framework** — it ships the MCP server, the conductor agent, and the authoring skills. **Courses** are separate content plugins that declare `accContent: { lessons: "./lessons/" }` in their `plugin.json`; ACC auto-discovers them at runtime.

## What lives here

| Piece | Path |
|---|---|
| Plugin manifest | `.claude-plugin/plugin.json` |
| Entry-point command | `commands/start.md` → `/agentic-community-college:start` |
| Course conductor agent | `agents/course-conductor.md` |
| Entry-point skill | `skills/course-engine/SKILL.md` |
| Lesson authoring skill | `skills/lesson-creator/SKILL.md` |
| MCP server | `mcp/server/` |
| Tests | `tests/` |

ACC ships no learning content of its own — you install (or build) a course plugin alongside it.

## Recommended companion plugin: `toolkit@contract-hero`

ACC's authoring flow and runtime conductor delegate several HTML-deliverable tasks (per-section SVG diagrams, post-lesson snapshot publishing, project-intro drafts) to skills bundled by [`toolkit@contract-hero`](https://github.com/alilloig/contract-hero-marketplace). It's not required — lessons still run without it — but you'll get the full author / learner experience by installing it alongside ACC. The course-creator template pre-seeds a `toolkit-installed` probe so every new course you scaffold knows about the dependency.

## Vocabulary

- **Course** — a content plugin (one git repo, one domain). Declares `accContent`. The first one is [`acc-deepbook-course`](https://github.com/alilloig/acc-deepbook-course).
- **Lesson** — a single end-to-end learning experience inside a course (`lessons/<slug>/`).
- **Section** — a single prompt step inside a lesson; the learner advances section by section.

## How a session runs

1. The learner runs `/agentic-community-college:start`.
2. ACC discovers installed course plugins and lists their lessons.
3. The learner picks a lesson; `selectLesson` mints session state.
4. The learner picks an output mode (`learning` leaves TODOs for them, `explanatory` implements + narrates).
5. The conductor walks the section sequence — each section advances the HTML artifact and gates on a small `vitest` check.

## Build & test

```bash
pnpm install
cd mcp/server && pnpm install && pnpm build
pnpm test    # from the repo root
```

The plugin manifest spawns `node mcp/server/dist/index.js` over stdio, so `pnpm build` is required after any change in `mcp/server/src/`.

## Authoring a new lesson

Invoke the `lesson-creator` skill. It will ask you which discovered course to target, then seed a reference codebase into it, draft the section sequence and test suite, scaffold an evolving HTML artifact, and run a learner sub-agent validation pass under both output modes before committing.

## Configurable paths

Courses can declare named filesystem paths their probes and reference apps need (e.g. a `sandbox` checkout, a `docs` mirror). Each path has a default that's resolved under the learner's chosen `workspace_root`, and any learner can override per-path via `~/.acc/config.json`.

### For learners — `~/.acc/config.json`

```json
{
  "workspace_root": "~/workspace",
  "course_paths": {
    "acc-deepbook-course@local": {
      "sandbox": "~/dev/deepbook-sandbox"
    }
  }
}
```

- `workspace_root` is the parent directory ACC assumes for project checkouts. Set once on first run via the `configureWorkspace` MCP tool (the conductor prompts you the first time you start a lesson; the default is `~/workspace`).
- `course_paths.<plugin-key>.<path-id>` is optional per-course override. Missing entries derive from `${workspace_root}/${manifest-default}`.

You can hand-edit the file or call `configureWorkspace` from any ACC-enabled session. Partial updates are deep-merged — patching one id won't blow away unrelated entries. To delete an entry, pass `null` for the value (`{ course_paths: { "x@1": { "sandbox": null } } }` removes just that id; `{ course_paths: { "x@1": null } }` removes the entire plugin block). Override values must be either absolute paths or `~/`-prefixed; bare relative values are anchored under `workspace_root`. Embedded `..` segments are rejected at load time.

### For course authors — `accContent.paths`

Declare paths in your course's `plugin.json`:

```json
{
  "accContent": {
    "lessons": "./lessons/",
    "paths": [
      {
        "id": "sandbox",
        "default": "deepbook-sandbox",
        "description": "DeepBook sandbox checkout."
      }
    ],
    "probes": [
      {
        "id": "sandbox-repo-present",
        "kind": "filesystem-exists",
        "message_pass": "sandbox checkout found",
        "message_fail": "sandbox not found",
        "params": { "path": "${paths.sandbox}" },
        "remediation": {
          "kind": "shell",
          "command": "git clone https://github.com/MystenLabs/deepbook-sandbox.git \"${paths.sandbox}\""
        }
      }
    ]
  }
}
```

- `id`: lowercase letters, digits, `_` and `-`. Stable; this is the substitution key.
- `default`: single path segment under `workspace_root`. No `/`, `\`, `..`, or leading `~/`.
- `description`: free-form, surfaced in error messages.

### `${paths.<id>}` substitution scope

Substitution happens **before** the probe runner sees its params, in two places only:

1. Probe `params` (any string field, including arrays — e.g. `args`).
2. Probe `remediation.command` and `remediation.cwd`.

Substitution **does not** flow into section bodies — those continue to use the personalization `{{ key }}` channel scoped by `substitutePromptOnly`. The two systems are deliberately separate; never reach across them.

If a `${paths.<id>}` reference doesn't match a declared id on the same manifest, plugin discovery surfaces a `course-plugin-paths-invalid` warning and drops the entire probe set for that course (so a learner gets a clear configuration error instead of a runtime substitution crash).

### Env vars for reference apps

The seeded workspace under `~/.acc/workspaces/<slug>/` receives a `.env.acc-paths` file and the `host_install_command` spawn inherits the same env. Each path id mints two variables:

- `ACC_PATHS_<ID_UPPER>` — raw resolved absolute path.
- `VITE_ACC_PATHS_<ID_UPPER>` — Vite-prefixed mirror for build-time inlining.

In a Vite reference app:

```ts
const sandbox = import.meta.env.VITE_ACC_PATHS_SANDBOX ?? '/fallback/path';
```

In a Node script:

```ts
const sandbox = process.env.ACC_PATHS_SANDBOX ?? '/fallback/path';
```

The fallback makes the app work outside ACC (e.g. when the author runs `pnpm dev` directly without going through `selectLesson`).

If the user changes `workspace_root` or a `course_paths` override after a workspace was seeded, the next `selectLesson` call rewrites `.env.acc-paths` automatically — the host signature only fingerprints the lesson's seed tarball, not user-level overrides, so the workspace itself is reused.
