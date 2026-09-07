import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runStart } from './tools/start.js';
import { runPreflightProbe } from './tools/runPreflightProbe.js';
import { runSelectLesson } from './tools/selectLesson.js';
import { runSetPersonalization } from './tools/setPersonalization.js';
import { runSetOutputStyle } from './tools/setOutputStyle.js';
import { runNextChapter } from './tools/nextChapter.js';
import { runVerifyChapter } from './tools/verifyChapter.js';
import { runConfigureWorkspace } from './tools/configureWorkspace.js';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';

// Re-export SDK seams for the in-process harness so it can resolve all
// classes from a single import without needing @modelcontextprotocol/sdk
// installed at the workspace root.
export { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export { Client } from '@modelcontextprotocol/sdk/client/index.js';
export { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

export const ACC_VERSION = '0.3.0';

function json(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}

export function registerTools(server: McpServer): void {
  server.tool(
    'start',
    'Start an ACC session — returns the lesson catalog (aggregated across enabled course plugins), the advisory output-style status ({ active, recommended: "Concise", ok }), current state, and warnings. Never runs preflight probes.',
    {
      projectRoot: z.string().describe('Absolute path to the project root'),
    },
    async ({ projectRoot }) => json(await runStart({ projectRoot })),
  );

  server.tool(
    'runPreflightProbe',
    `Run a single declarative probe by id. Probe ids are resolved against the union of every enabled course plugin's accContent.probes — ACC ships no domain probes itself. Use remediate: true to execute the probe's shell remediation (if it has one) and re-run the probe afterwards.`,
    {
      probeId: z.string().describe('The probe id to run'),
      remediate: z
        .boolean()
        .optional()
        .describe('If true and the probe fails with a shell action, execute the remediation'),
    },
    async ({ probeId, remediate }) => json(await runPreflightProbe({ probeId, remediate })),
  );

  server.tool(
    'selectLesson',
    'Pick a lesson by namespaced slug (`<course>/<lesson>`). Mints fresh v5 state, seeds the workspace (host copy minus solution_files, plus starters), and returns description, prerequisites, personalization prompts and first-run setup info.',
    {
      projectRoot: z.string().describe('Absolute path to the project root'),
      slug: z.string().describe('Namespaced lesson slug (course-plugin/lesson)'),
    },
    async ({ projectRoot, slug }) => json(await runSelectLesson({ projectRoot, slug })),
  );

  server.tool(
    'setPersonalization',
    'Persist personalization values for the active lesson. Pass empty object {} to use all defaults.',
    {
      projectRoot: z.string().describe('Absolute path to the project root'),
      values: z.record(z.unknown()).describe('Personalization key-value pairs'),
    },
    async ({ projectRoot, values }) =>
      json(await runSetPersonalization({ projectRoot, values: values as Record<string, unknown> })),
  );

  server.tool(
    'setOutputStyle',
    'Write the recommended Claude Code output style ("Concise") into ~/.claude/settings.json. Call only after the learner explicitly agreed. Returns the previous value and a note on how to apply it to the running session.',
    {
      style: z.literal('Concise').describe('The only accepted value'),
    },
    async ({ style }) => json(await runSetOutputStyle({ style })),
  );

  server.tool(
    'nextChapter',
    'Read the current chapter: brief (personalization rendered), key_idea, expected_files, tests, verification, docs_dir, workspace_path, artifact_path and artifact_conventions_path. Returns done: true with final_verification when every chapter passed and the e2e gate is pending; done + completed once the e2e passed.',
    {
      projectRoot: z.string().describe('Absolute path to the project root'),
    },
    async ({ projectRoot }) => json(await runNextChapter({ projectRoot })),
  );

  server.tool(
    'verifyChapter',
    "Run the current chapter's verification, or final_verification (the e2e gate) when every chapter already passed. On pass: advances chapter_cursor (or sets completed_at) and records the chapter's artifact path when the file exists. On fail: leaves the cursor unchanged and returns the captured output.",
    {
      projectRoot: z.string().describe('Absolute path to the project root'),
    },
    async ({ projectRoot }) => json(await runVerifyChapter({ projectRoot })),
  );

  server.tool(
    'configureWorkspace',
    'Read or update the user-level ACC config at ~/.acc/config.json. With no args, returns the current effective config (defaults filled in) and whether it came from disk. With `workspace_root` and/or `course_paths`, deep-merges the patch and persists atomically. Used by the course-engine for the one-time first-run prompt and for on-demand path overrides.',
    {
      workspace_root: z
        .string()
        .optional()
        .describe('New workspace_root (e.g. "~/workspace"). Replaces the existing value.'),
      course_paths: z
        .record(
          z.union([
            z.null(),
            z.record(z.union([z.string(), z.null()])),
          ]),
        )
        .optional()
        .describe('Per-course path overrides: { "<plugin-key>": { "<path-id>": "<override>" } }. Deep-merged. Pass `null` for a path-id to delete it; pass `null` for a plugin-key to delete its whole block.'),
    },
    async ({ workspace_root, course_paths }) => {
      const args: { workspace_root?: string; course_paths?: Record<string, Record<string, string | null> | null> } = {};
      if (workspace_root !== undefined) args.workspace_root = workspace_root;
      if (course_paths !== undefined) args.course_paths = course_paths;
      return json(await runConfigureWorkspace(args));
    },
  );
}

// Only start the stdio transport when this file is executed directly as a
// script. Resolve both sides through realpath so the comparison survives
// symlinks — Claude Code installs plugins under `~/.claude/plugins/...`
// and on some hosts that path is a symlink to a checkout in `~/workspace/`.
function _isMainEntrypoint(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    const realArgv = fs.realpathSync(argvPath);
    const realImport = fs.realpathSync(fileURLToPath(import.meta.url));
    return realArgv === realImport;
  } catch {
    return false;
  }
}

if (_isMainEntrypoint()) {
  const server = new McpServer({
    name: 'agentic-community-college',
    version: ACC_VERSION,
  });
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
