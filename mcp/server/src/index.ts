import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runStart } from './tools/start.js';
import { runPreflightProbe } from './tools/runPreflightProbe.js';
import { runSelectPath } from './tools/selectPath.js';
import { runSetPersonalization } from './tools/setPersonalization.js';
import { runSelectStyle } from './tools/selectStyle.js';
import { runNextSpot } from './tools/nextSpot.js';
import { runVerifySpot } from './tools/verifySpot.js';
import { runRequestHint } from './tools/requestHint.js';
import { runGetNextPrompt } from './tools/getNextPrompt.js';
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
    'Start the Sui DeepBook course — returns paths, output style status, and preflight info.',
    {
      projectRoot: z.string().describe('Absolute path to the project root'),
    },
    async ({ projectRoot }) => {
      const result = await runStart({ projectRoot });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result),
          },
        ],
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
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  server.tool(
    'selectPath',
    'Select a learning path by slug. Returns personalization prompts and initializes state.',
    {
      projectRoot: z.string().describe('Absolute path to the project root'),
      slug: z.string().describe('The path slug to select'),
    },
    async ({ projectRoot, slug }) => {
      const result = await runSelectPath({ projectRoot, slug });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  server.tool(
    'setPersonalization',
    'Set personalization values for the selected path. Pass empty object {} to use all defaults.',
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
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  server.tool(
    'selectStyle',
    "Select an exercise style ('fill-in-blank' or 'prompted-agentic') for a specific spot. PR 1 only honors 'fill-in-blank'; 'prompted-agentic' is reserved for PR 2.",
    {
      projectRoot: z.string().describe('Absolute path to the project root'),
      spotId: z.string().describe('The spot id whose style to set'),
      style: z
        .union([z.literal('fill-in-blank'), z.literal('prompted-agentic')])
        .describe("Exercise style: 'fill-in-blank' or 'prompted-agentic'"),
    },
    async ({ projectRoot, spotId, style }) => {
      const result = await runSelectStyle({ projectRoot, spotId, style });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  server.tool(
    'nextSpot',
    'Get the current spot in the phase loop. Returns phase info, the substituted spot view, and ladder state.',
    {
      projectRoot: z.string().describe('Absolute path to the project root'),
    },
    async ({ projectRoot }) => {
      const result = await runNextSpot({ projectRoot });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  server.tool(
    'verifySpot',
    'Verify the current spot. On pass, advances the cursor. On fail, leaves cursor unchanged.',
    {
      projectRoot: z.string().describe('Absolute path to the project root'),
    },
    async ({ projectRoot }) => {
      const result = await runVerifySpot({ projectRoot });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  server.tool(
    'getNextPrompt',
    "PR 2 — for spots in 'prompted-agentic' style, return the next markdown prompt the learner has not yet seen. Advances the per-spot prompt cursor on success. Returns done:true when the sequence is exhausted.",
    {
      projectRoot: z.string().describe('Absolute path to the project root'),
    },
    async ({ projectRoot }) => {
      const result = await runGetNextPrompt({ projectRoot });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  server.tool(
    'requestHint',
    'Request a hint, reference, or auto-write for the current spot. Rung 1=hint, 2=reference, 3=auto-write.',
    {
      projectRoot: z.string().describe('Absolute path to the project root'),
      rung: z.union([z.literal(1), z.literal(2), z.literal(3)]).describe('The rung to request (1=hint, 2=reference, 3=auto-write)'),
    },
    async ({ projectRoot, rung }) => {
      const result = await runRequestHint({ projectRoot, rung });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );
}

// Only start the stdio transport when this file is executed directly as a
// script. Resolve both sides through realpath so the comparison survives
// symlinks — Claude Code installs plugins under `~/.claude/plugins/...`
// which on this user's machine is a symlink to `~/workspace/dotfiles/.claude`,
// and `process.argv[1]` keeps the literal symlink path while
// `import.meta.url` resolves to the real path. A naive `===` would silently
// skip server startup in that case.
function _isMainEntrypoint(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return fs.realpathSync(argvPath) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (_isMainEntrypoint()) {
  const server = new McpServer({
    name: 'sui-deepbook-course',
    version: '1.0.0',
  });
  registerTools(server);
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err: unknown) => {
    process.stderr.write(String(err) + '\n');
    process.exit(1);
  });
}
