import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Modules under test — none of these exist (in their cycle-2 shape) at red
// phase. The import failures will surface as the meaningful red signal.
//
// We deliberately do NOT import the @modelcontextprotocol/sdk client/server/
// transport modules directly — the SDK is only installed under
// mcp/server/node_modules (it is a workspace dep of the server package, not
// of the test root). Instead, we exercise the transport seam through the
// harness API: the harness must internally construct the McpServer, mount
// tools via registerTools, and connect a Client over InMemoryTransport.
import { registerTools } from '../mcp/server/src/index.js';
import { bootHarness } from '../scripts/e2e/harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'state');

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

let tempRoots: string[] = [];

function makeTempProjectRoot(prefix = 'sui-course-harness-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function withCorruptState(projectRoot: string): string {
  const stateDir = path.join(projectRoot, '.sui-deepbook-course');
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'state.json');
  const bytes = fs.readFileSync(path.join(FIXTURES_DIR, 'corrupt.json'), 'utf8');
  fs.writeFileSync(stateFile, bytes, 'utf8');
  return stateFile;
}

function withValidState(projectRoot: string): string {
  const stateDir = path.join(projectRoot, '.sui-deepbook-course');
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'state.json');
  const bytes = fs.readFileSync(
    path.join(FIXTURES_DIR, 'valid-cursor-p2.json'),
    'utf8',
  );
  fs.writeFileSync(stateFile, bytes, 'utf8');
  return stateFile;
}

function withFutureSchemaState(projectRoot: string): string {
  const stateDir = path.join(projectRoot, '.sui-deepbook-course');
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'state.json');
  const bytes = fs.readFileSync(
    path.join(FIXTURES_DIR, 'future-schema.json'),
    'utf8',
  );
  fs.writeFileSync(stateFile, bytes, 'utf8');
  return stateFile;
}

function listArchives(projectRoot: string): string[] {
  const stateDir = path.join(projectRoot, '.sui-deepbook-course');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(stateDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && /^state\.corrupt-.*\.json$/.test(e.name))
    .map((e) => path.join(stateDir, e.name));
}

/**
 * Parse the JSON-encoded payload that an MCP `tools/call` result wraps in its
 * `content[0].text` field.
 */
function parseTextResult(result: any): any {
  expect(result).toBeTruthy();
  expect(typeof result).toBe('object');
  expect(Array.isArray(result.content)).toBe(true);
  expect(result.content.length).toBeGreaterThan(0);
  expect(result.content[0].type).toBe('text');
  expect(typeof result.content[0].text).toBe('string');
  return JSON.parse(result.content[0].text);
}

afterEach(() => {
  for (const dir of tempRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  }
  tempRoots = [];
});

// ---------------------------------------------------------------------------
// T-085: registerTools registers tools on a passed McpServer
// ---------------------------------------------------------------------------

describe('registerTools — index.ts factory', () => {
  it('T-085: registerTools(server) registers `start` (and other cycle-1+2 tools) on the server', () => {
    expect(typeof registerTools).toBe('function');

    // Use a minimal stub server that records every `.tool(...)` registration.
    // The McpServer.tool() signature is `tool(name, description, paramsSchema, handler)`
    // (4-arg form). registerTools should invoke this for at least 'start'.
    const registered: string[] = [];
    const stubServer = {
      tool: (name: string, ..._rest: unknown[]) => {
        registered.push(name);
      },
      // Other McpServer methods registerTools might call. We provide minimal
      // no-ops so the implementer is free to use whichever surface the SDK
      // currently exposes; if a method isn't here it will throw, which the
      // implementer can read as a directive to use `.tool(...)` form.
      registerTool: (name: string, ..._rest: unknown[]) => {
        registered.push(name);
      },
    } as any;

    expect(() => registerTools(stubServer)).not.toThrow();
    expect(registered).toContain('start');
  });
});

// ---------------------------------------------------------------------------
// T-086 / T-087: harness boot + real MCP framing
// ---------------------------------------------------------------------------

describe('harness — MCP transport seam', () => {
  it('T-086: bootHarness exposes callTool that round-trips through a real MCP client over InMemoryTransport', async () => {
    const projectRoot = makeTempProjectRoot();

    const harness: any = await bootHarness({ projectRoot });
    try {
      const callTool = harness.callTool ?? harness.invokeTool ?? harness.call;
      expect(typeof callTool).toBe('function');

      const response: any = await callTool('start', { projectRoot });

      // The harness must return the SDK's CallToolResult shape: an object
      // with a `content` array of `{ type: 'text', text: '<json>' }`.
      expect(response).toBeTruthy();
      expect(Array.isArray(response.content)).toBe(true);
      expect(response.content.length).toBeGreaterThan(0);
      expect(response.content[0].type).toBe('text');
      expect(typeof response.content[0].text).toBe('string');
    } finally {
      const shutdown = harness.shutdown ?? harness.close ?? harness.stop;
      if (typeof shutdown === 'function') await shutdown();
    }
  });

  it('T-087: harness response parses into the documented start payload (outputStyleOk, preflight, paths, state, warnings)', async () => {
    const projectRoot = makeTempProjectRoot();

    const harness: any = await bootHarness({ projectRoot });
    try {
      const callTool = harness.callTool ?? harness.invokeTool ?? harness.call;
      const response: any = await callTool('start', { projectRoot });

      const payload = parseTextResult(response);

      expect(typeof payload).toBe('object');
      expect(payload).not.toBeNull();
      expect(typeof payload.outputStyleOk).toBe('boolean');
      expect(payload.preflight).toBeTruthy();
      expect(Array.isArray(payload.paths)).toBe(true);
      expect(Array.isArray(payload.warnings)).toBe(true);
      // state may be null (absent) or an object (ok). The key must exist.
      expect(Object.prototype.hasOwnProperty.call(payload, 'state')).toBe(true);
    } finally {
      const shutdown = harness.shutdown ?? harness.close ?? harness.stop;
      if (typeof shutdown === 'function') await shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// T-088: source guard — no `runStart` import or per-tool if-branch
// ---------------------------------------------------------------------------

describe('harness source guards', () => {
  const harnessSourcePath = path.join(REPO_ROOT, 'scripts', 'e2e', 'harness.ts');

  it('T-088: harness.ts contains no runStart import and no per-tool if-branch on toolName', () => {
    const content = fs.readFileSync(harnessSourcePath, 'utf8');

    // No import binding `runStart` (covers `import { runStart }` and
    // `import { runStart as foo }`).
    expect(/import\s*\{[^}]*\brunStart\b[^}]*\}/.test(content)).toBe(false);

    // No relative import path that resolves to tools/start (covers .js or
    // .ts suffix variations).
    expect(/from\s+['"][^'"]*tools\/start/.test(content)).toBe(false);

    // No per-tool if-branch matching toolName === 'start'.
    expect(
      /if\s*\([^)]*toolName[^)]*===\s*['"]start['"]/.test(content),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-089 / T-090 / T-091: end-to-end state scenarios
// ---------------------------------------------------------------------------

describe('harness — E-006 corrupt state.json scenario', () => {
  it('T-089: corrupt state.json yields state-corrupt warning and a state.corrupt-* archive on disk', async () => {
    const projectRoot = makeTempProjectRoot();
    withCorruptState(projectRoot);

    const harness: any = await bootHarness({ projectRoot });
    try {
      const callTool = harness.callTool ?? harness.invokeTool ?? harness.call;
      const response: any = await callTool('start', { projectRoot });
      const payload = parseTextResult(response);

      expect(payload.state).toBeNull();

      // Surface the state warning either via warnings array or stateWarning slot.
      let warning: any = (payload as any).stateWarning;
      if (!warning && Array.isArray(payload.warnings)) {
        warning = payload.warnings.find(
          (w: any) =>
            w && typeof w.kind === 'string' && /^state-/.test(w.kind),
        );
      }
      expect(warning).toBeTruthy();
      expect(warning.kind).toBe('state-corrupt');

      // An archive file now exists under .sui-deepbook-course/.
      const archives = listArchives(projectRoot);
      expect(archives.length).toBeGreaterThan(0);
    } finally {
      const shutdown = harness.shutdown ?? harness.close ?? harness.stop;
      if (typeof shutdown === 'function') await shutdown();
    }
  });
});

describe('harness — E-015 valid state resume scenario', () => {
  it('T-090: valid state.json with cursor at p2-retry/p2-spot-1 surfaces resume cursor and ladder.p1-spot-1.hint_used', async () => {
    const projectRoot = makeTempProjectRoot();
    withValidState(projectRoot);

    const harness: any = await bootHarness({ projectRoot });
    try {
      const callTool = harness.callTool ?? harness.invokeTool ?? harness.call;
      const response: any = await callTool('start', { projectRoot });
      const payload = parseTextResult(response);

      expect(payload.state).toBeTruthy();
      expect(payload.state.cursor.phase_id).toBe('p2-retry');
      expect(payload.state.cursor.spot_id).toBe('p2-spot-1');
      expect(payload.state.ladder['p1-spot-1'].hint_used).toBe(true);

      // No state warning is surfaced for the ok path.
      let stateWarning: any = (payload as any).stateWarning;
      if (!stateWarning && Array.isArray(payload.warnings)) {
        stateWarning = payload.warnings.find(
          (w: any) =>
            w && typeof w.kind === 'string' && /^state-/.test(w.kind),
        );
      }
      expect(stateWarning).toBeFalsy();
    } finally {
      const shutdown = harness.shutdown ?? harness.close ?? harness.stop;
      if (typeof shutdown === 'function') await shutdown();
    }
  });
});

describe('harness — E-016 future schema_version scenario', () => {
  it('T-091: future schema state yields state-schema-mismatch warning, no archive file, canonical state.json unchanged', async () => {
    const projectRoot = makeTempProjectRoot();
    const stateFile = withFutureSchemaState(projectRoot);
    const beforeBytes = fs.readFileSync(stateFile, 'utf8');

    const harness: any = await bootHarness({ projectRoot });
    try {
      const callTool = harness.callTool ?? harness.invokeTool ?? harness.call;
      const response: any = await callTool('start', { projectRoot });
      const payload = parseTextResult(response);

      expect(payload.state).toBeNull();

      let warning: any = (payload as any).stateWarning;
      if (!warning && Array.isArray(payload.warnings)) {
        warning = payload.warnings.find(
          (w: any) =>
            w && typeof w.kind === 'string' && /^state-/.test(w.kind),
        );
      }
      expect(warning).toBeTruthy();
      expect(warning.kind).toBe('state-schema-mismatch');

      const haystack = JSON.stringify(warning);
      expect(haystack).toContain('999');
      expect(haystack).toMatch(/incompatible|migration/i);

      // No state.corrupt-* archive file appears.
      expect(listArchives(projectRoot)).toEqual([]);

      // Canonical state.json bytes are unchanged.
      expect(fs.readFileSync(stateFile, 'utf8')).toBe(beforeBytes);
    } finally {
      const shutdown = harness.shutdown ?? harness.close ?? harness.stop;
      if (typeof shutdown === 'function') await shutdown();
    }
  });
});
