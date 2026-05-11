import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runStart } from './tools/start.js';
import { runPreflightProbe } from './tools/runPreflightProbe.js';
import { runSelectLesson } from './tools/selectLesson.js';
import { runSetOutputMode } from './tools/setOutputMode.js';
import { runSetPersonalization } from './tools/setPersonalization.js';
import { runNextSection } from './tools/nextSection.js';
import { runVerifySection } from './tools/verifySection.js';
import { runAdvanceArtifact } from './tools/advanceArtifact.js';
import { PROBE_ORDER } from './preflight.js';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';

// Re-export SDK seams for the in-process harness so it can resolve all
// classes from a single import without needing @modelcontextprotocol/sdk
// installed at the workspace root.
export { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export { Client } from '@modelcontextprotocol/sdk/client/index.js';
export { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

export function registerTools(server: McpServer): void {
  server.tool(
    'start',
    'Start an ACC session — returns the lesson catalog (aggregated across enabled course plugins), output-style status, and preflight info. Cycle-1 always skips preflight.',
    {
      projectRoot: z.string().describe('Absolute path to the project root'),
    },
    async ({ projectRoot }) => {
      const result = await runStart({ projectRoot });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
  );

  server.tool(
    'runPreflightProbe',
    `Run a single preflight probe by id. Valid probe ids (in order): ${PROBE_ORDER.join(', ')}. Use remediate: true to trigger shell action execution (e.g. pnpm deploy-all --quick for sandbox-manifest-reachable).`,
    {
      probeId: z.string().describe('The probe id to run'),
      remediate: z
        .boolean()
        .optional()
        .describe('If true and the probe fails with a shell action, execute the remediation'),
    },
    async ({ probeId, remediate }) => {
      const result = await runPreflightProbe({ probeId, remediate });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
  );

  server.tool(
    'selectLesson',
    'Pick a lesson by namespaced slug (`<course>/<lesson>`). Mints fresh v4 state, prepares the workspace if the lesson declares one, and returns description + personalization prompts + an output-mode picker.',
    {
      projectRoot: z.string().describe('Absolute path to the project root'),
      slug: z.string().describe('Namespaced lesson slug (course-plugin/lesson)'),
    },
    async ({ projectRoot, slug }) => {
      const result = await runSelectLesson({ projectRoot, slug });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
  );

  server.tool(
    'setOutputMode',
    "Persist the learner's chosen output mode (`learning` leaves load-bearing pieces as TODOs; `explanatory` implements + narrates). Call between selectLesson and setPersonalization.",
    {
      projectRoot: z.string().describe('Absolute path to the project root'),
      style: z
        .union([z.literal('learning'), z.literal('explanatory')])
        .describe('Output mode for the lesson'),
    },
    async ({ projectRoot, style }) => {
      const result = await runSetOutputMode({ projectRoot, style });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
  );

  server.tool(
    'setPersonalization',
    'Persist personalization values for the active lesson. Pass empty object {} to use all defaults.',
    {
      projectRoot: z.string().describe('Absolute path to the project root'),
      values: z.record(z.unknown()).describe('Personalization key-value pairs'),
    },
    async ({ projectRoot, values }) => {
      const result = await runSetPersonalization({
        projectRoot,
        values: values as Record<string, unknown>,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
  );

  server.tool(
    'nextSection',
    "Read the current section. Returns the substituted body, key_moment, expected_files, artifact_section_id, and optional per-section verification. Returns `done: true` when the cursor is past the lesson's last section.",
    {
      projectRoot: z.string().describe('Absolute path to the project root'),
    },
    async ({ projectRoot }) => {
      const result = await runNextSection({ projectRoot });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
  );

  server.tool(
    'verifySection',
    "Run the current section's verification (or final_verification when at the last section). On pass, advances section_cursor. On fail, leaves cursor unchanged. Captures stdout/stderr in state.test_status.",
    {
      projectRoot: z.string().describe('Absolute path to the project root'),
    },
    async ({ projectRoot }) => {
      const result = await runVerifySection({ projectRoot });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
  );

  server.tool(
    'advanceArtifact',
    "Rewrite the workspace's artifact-state.json so the open browser tab reveals the latest section. No-op when the lesson declares no artifact block. Should be called by the conductor right before each nextSection.",
    {
      projectRoot: z.string().describe('Absolute path to the project root'),
    },
    async ({ projectRoot }) => {
      const result = await runAdvanceArtifact({ projectRoot });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
  );
}

// Only start the stdio transport when this file is executed directly as a
// script. Resolve both sides through realpath so the comparison survives
// symlinks — Claude Code installs plugins under `~/.claude/plugins/...`
// and on some hosts that path is a symlink to a checkout in `~/workspace/`.
// `process.argv[1]` keeps the literal symlink path while `import.meta.url`
// resolves to the real path. A naive `===` would silently skip server
// startup in that case.
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
    version: '0.1.0',
  });
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
