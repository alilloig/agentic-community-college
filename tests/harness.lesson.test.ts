import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });
// T-286 spies on dynamically-imported child_process; ESM namespace bindings
// are non-writable, so without spy-mode mock vi.spyOn throws "Cannot redefine
// property: spawn".
vi.mock('node:child_process', { spy: true });

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { registerTools } from '../mcp/server/src/index.js';
import { bootHarness } from '../scripts/e2e/harness.js';
import { runStart } from '../mcp/server/src/tools/start.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const ENABLED_PLUGIN_KEY = 'learning-output-style@claude-plugins-official';

let originalHome: string | undefined;
let tempHome: string;
let tempRoots: string[] = [];

function makeTempRoot(prefix = 'sui-course-lesson-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writeSettings(content: string): void {
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), content, 'utf8');
}

/**
 * Copy paths/01-orderbook-viewer/ recursively from REPO_ROOT into <projectRoot>/paths/.
 * Used by E-001 / E-014 so the harness's MCP server has the real registry to scan.
 */
function copyOrderbookPathInto(projectRoot: string): void {
  const src = path.join(REPO_ROOT, 'paths', '01-orderbook-viewer');
  const dst = path.join(projectRoot, 'paths', '01-orderbook-viewer');
  function copyDir(s: string, d: string): void {
    fs.mkdirSync(d, { recursive: true });
    for (const entry of fs.readdirSync(s, { withFileTypes: true })) {
      const sp = path.join(s, entry.name);
      const dp = path.join(d, entry.name);
      if (entry.isDirectory()) copyDir(sp, dp);
      else if (entry.isFile()) fs.copyFileSync(sp, dp);
    }
  }
  copyDir(src, dst);
}

function parseTextResult(result: unknown): any {
  expect(result).toBeTruthy();
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  expect(Array.isArray(r.content)).toBe(true);
  expect(r.content!.length).toBeGreaterThan(0);
  expect(r.content![0].type).toBe('text');
  expect(typeof r.content![0].text).toBe('string');
  return JSON.parse(r.content![0].text!);
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sui-course-lesson-home-'));
  tempRoots.push(tempHome);
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
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
// A1: registerTools registers exactly six tools
// ---------------------------------------------------------------------------

describe('registerTools — nine tools after PR 2 (A1)', () => {
  it('T-179: registers exactly nine tools including getNextPrompt for the prompted-agentic style', () => {
    const registered: string[] = [];
    const stubServer = {
      tool: (name: string, ..._rest: unknown[]) => {
        registered.push(name);
      },
      registerTool: (name: string, ..._rest: unknown[]) => {
        registered.push(name);
      },
    } as any;

    registerTools(stubServer);

    const sorted = [...registered].sort();
    // PR 2 adds getNextPrompt (the 9th tool) — drives the prompted-agentic flow.
    const expected = [
      'getNextPrompt',
      'nextSpot',
      'requestHint',
      'runPreflightProbe',
      'selectPath',
      'selectStyle',
      'setPersonalization',
      'start',
      'verifySpot',
    ].sort();
    expect(sorted).toEqual(expected);
    expect(registered.length).toBe(9);
  });

  it('T-180: exactly nine handler files exist under mcp/server/src/tools/', () => {
    const toolsDir = path.join(REPO_ROOT, 'mcp', 'server', 'src', 'tools');
    const entries = fs.readdirSync(toolsDir, { withFileTypes: true });
    const tsFiles = entries
      .filter((e) => e.isFile() && path.extname(e.name) === '.ts')
      .map((e) => e.name)
      .sort();
    expect(tsFiles).toEqual([
      'getNextPrompt.ts',
      'nextSpot.ts',
      'requestHint.ts',
      'runPreflightProbe.ts',
      'selectPath.ts',
      'selectStyle.ts',
      'setPersonalization.ts',
      'start.ts',
      'verifySpot.ts',
    ]);
  });
});

// ---------------------------------------------------------------------------
// A11: cycle 1 / 2 / 3 invariants preserved
// ---------------------------------------------------------------------------

describe('engine source parametricity (A11)', () => {
  it("T-272: engine code (mcp/server/src/, commands/, skills/course-engine/, scripts/e2e/) contains zero '01-orderbook-viewer' literals", () => {
    // Restricted to *engine* directories per cycle 1 T-027's pattern. Test
    // files under tests/ legitimately reference the slug for fixture setup
    // (selectPath/nextSpot/verifySpot tests need to seed real path data),
    // and tests/ are not engine code. The earlier wider scan accidentally
    // caught those legitimate test-side references.
    const SLUG = '01-orderbook-viewer';
    const SCAN_ROOTS = [
      path.join(REPO_ROOT, 'mcp', 'server', 'src'),
      path.join(REPO_ROOT, 'commands'),
      path.join(REPO_ROOT, 'skills', 'course-engine'),
      path.join(REPO_ROOT, 'scripts', 'e2e'),
    ];
    const ALLOWED_EXTS = new Set(['.ts', '.tsx', '.md', '.json']);

    const offenders: string[] = [];
    function walk(dir: string): void {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!ALLOWED_EXTS.has(path.extname(entry.name))) continue;
        const content = fs.readFileSync(full, 'utf8');
        if (content.indexOf(SLUG) !== -1) offenders.push(full);
      }
    }
    for (const root of SCAN_ROOTS) walk(root);

    expect(offenders).toEqual([]);
  });
});

describe('cycle-4 tools — no kind:"shell" literals (A11)', () => {
  it('T-273: selectPath/setPersonalization/nextSpot/verifySpot source files contain zero kind:"shell" literals', () => {
    const files = [
      'mcp/server/src/tools/selectPath.ts',
      'mcp/server/src/tools/setPersonalization.ts',
      'mcp/server/src/tools/nextSpot.ts',
      'mcp/server/src/tools/verifySpot.ts',
    ];
    for (const rel of files) {
      const full = path.join(REPO_ROOT, rel);
      const content = fs.readFileSync(full, 'utf8');
      expect(/kind\s*:\s*'shell'/.test(content), rel).toBe(false);
      expect(/kind\s*:\s*"shell"/.test(content), rel).toBe(false);
    }
  });
});

describe('AC-1.3 zero-write preserved on cycle-4 surface (A11)', () => {
  it('T-274: outputStyleOk=false → no new tool\'s saveState is called and no project files mutated', async () => {
    // No settings.json under tempHome → outputStyle probe returns ok=false.
    const projectRoot = makeTempRoot();
    copyOrderbookPathInto(projectRoot);

    // Pre-snapshot under projectRoot.
    function snapshot(root: string): { rel: string; bytes: string }[] {
      const out: { rel: string; bytes: string }[] = [];
      function walk(dir: string): void {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.isFile()) {
            out.push({
              rel: path.relative(root, full),
              bytes: fs.readFileSync(full, 'utf8'),
            });
          }
        }
      }
      walk(root);
      out.sort((a, b) => a.rel.localeCompare(b.rel));
      return out;
    }

    const before = snapshot(projectRoot);

    // Run start, expect outputStyleOk:false. None of the new tools should
    // execute writes from this entry point.
    const response = await runStart({ projectRoot });
    expect(response.outputStyleOk).toBe(false);

    const after = snapshot(projectRoot);
    expect(after).toEqual(before);

    // No state.json appeared.
    const stateFile = path.join(projectRoot, '.sui-deepbook-course', 'state.json');
    expect(fs.existsSync(stateFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A16: tsc --noEmit passes
// ---------------------------------------------------------------------------

describe('TypeScript strict surface compiles (cycle 4 additions)', () => {
  it('T-282: tsc --noEmit on mcp/server/ exits zero', () => {
    const result = spawnSync(
      'pnpm',
      ['--filter', './mcp/server', 'exec', 'tsc', '--noEmit'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E-001 + E-014 — through-the-MCP-transport scenarios (A1 + A7 + A8)
// ---------------------------------------------------------------------------

describe('E-001 cold-start happy path (A1)', () => {
  it('T-283: cold-start through MCP transport: start → selectPath → setPersonalization (defaults) → nextSpot → verifySpot', async () => {
    const projectRoot = makeTempRoot();
    copyOrderbookPathInto(projectRoot);

    // Enable both plugins so outputStyle returns ok.
    writeSettings(
      JSON.stringify({
        enabledPlugins: {
          'sui-pilot@local': true,
          [ENABLED_PLUGIN_KEY]: true,
        },
      }),
    );

    const harness: any = await bootHarness({ projectRoot });
    try {
      // Stub verify so we don't actually shell out to pnpm.
      if (typeof harness.withVerifyStub === 'function') {
        await harness.withVerifyStub({ pass: true, output: 'built' });
      }

      // start
      const startResult = parseTextResult(await harness.callTool('start', { projectRoot }));
      expect(startResult.outputStyleOk).toBe(true);

      // selectPath
      const selectResult = parseTextResult(
        await harness.callTool('selectPath', { projectRoot, slug: '01-orderbook-viewer' }),
      );
      expect(selectResult.ok).toBe(true);

      // setPersonalization defaults
      const setResult = parseTextResult(
        await harness.callTool('setPersonalization', { projectRoot, values: {} }),
      );
      expect(setResult.ok).toBe(true);

      // nextSpot
      const next = parseTextResult(await harness.callTool('nextSpot', { projectRoot }));
      expect(next.spot.target_file).toBe('src/App.tsx');
      expect(next.spot.target_range).toBe('39-58');
      expect(next.phase.id).toBe('p1-bootstrap');

      // verifySpot
      const verify = parseTextResult(await harness.callTool('verifySpot', { projectRoot }));
      expect(verify.pass).toBe(true);
      expect(verify.advanced).toBe(true);

      // state persists
      const stateFile = path.join(projectRoot, '.sui-deepbook-course', 'state.json');
      expect(fs.existsSync(stateFile)).toBe(true);
    } finally {
      await harness.shutdown();
    }
  });
});

describe('E-014 personalization in spot (A7)', () => {
  it('T-284: setPersonalization custom values → nextSpot prompt is substituted, target_file/target_range unchanged', async () => {
    const projectRoot = makeTempRoot();
    copyOrderbookPathInto(projectRoot);
    writeSettings(
      JSON.stringify({
        enabledPlugins: {
          'sui-pilot@local': true,
          [ENABLED_PLUGIN_KEY]: true,
        },
      }),
    );

    const harness: any = await bootHarness({ projectRoot });
    try {
      if (typeof harness.withVerifyStub === 'function') {
        await harness.withVerifyStub({ pass: true, output: 'built' });
      }

      await harness.callTool('start', { projectRoot });
      const sel = parseTextResult(
        await harness.callTool('selectPath', { projectRoot, slug: '01-orderbook-viewer' }),
      );
      expect(sel.ok).toBe(true);

      const set = parseTextResult(
        await harness.callTool('setPersonalization', {
          projectRoot,
          values: { poll_interval_ms: 5000, pool_subset: 'DEEP_SUI' },
        }),
      );
      expect(set.ok).toBe(true);

      const next = parseTextResult(await harness.callTool('nextSpot', { projectRoot }));
      expect(next.spot.prompt.indexOf('DEEP_SUI')).toBeGreaterThan(-1);
      expect(next.spot.prompt.indexOf('{{ pool_subset }}')).toBe(-1);
      expect(next.spot.prompt.indexOf('{{pool_subset}}')).toBe(-1);
      // Manifest target_file/target_range unchanged byte-for-byte.
      expect(next.spot.target_file).toBe('src/App.tsx');
      expect(next.spot.target_range).toBe('39-58');
    } finally {
      await harness.shutdown();
    }
  });
});

describe('harness fixture wrappers (A1)', () => {
  it('T-285: harness exposes selectPath/setPersonalization/nextSpot/verifySpot wrappers that delegate to callTool', async () => {
    const projectRoot = makeTempRoot();
    copyOrderbookPathInto(projectRoot);
    writeSettings(
      JSON.stringify({
        enabledPlugins: {
          'sui-pilot@local': true,
          [ENABLED_PLUGIN_KEY]: true,
        },
      }),
    );
    const harness: any = await bootHarness({ projectRoot });
    try {
      for (const name of ['selectPath', 'setPersonalization', 'nextSpot', 'verifySpot']) {
        expect(typeof harness[name]).toBe('function');
      }
      const callSpy = vi.spyOn(harness, 'callTool');
      await harness.selectPath({ projectRoot, slug: '01-orderbook-viewer' });
      expect(callSpy).toHaveBeenCalledTimes(1);
      expect(callSpy.mock.calls[0][0]).toBe('selectPath');
    } finally {
      await harness.shutdown();
    }
  });
});

describe('harness withVerifyStub fixture (A8)', () => {
  it('T-286: withVerifyStub keeps verifySpot from invoking subprocess spawn', async () => {
    const projectRoot = makeTempRoot();
    copyOrderbookPathInto(projectRoot);
    writeSettings(
      JSON.stringify({
        enabledPlugins: {
          'sui-pilot@local': true,
          [ENABLED_PLUGIN_KEY]: true,
        },
      }),
    );
    const harness: any = await bootHarness({ projectRoot });
    try {
      expect(typeof harness.withVerifyStub).toBe('function');
      await harness.withVerifyStub({ pass: true, output: 'built' });

      // Spy on subprocess spawn; expect zero invocations.
      const childProcess = await import('node:child_process');
      const spawnSpy = vi.spyOn(childProcess, 'spawn');
      const spawnSyncSpy = vi.spyOn(childProcess, 'spawnSync');

      // Drive the full flow up to verifySpot.
      await harness.callTool('start', { projectRoot });
      await harness.callTool('selectPath', { projectRoot, slug: '01-orderbook-viewer' });
      await harness.callTool('setPersonalization', { projectRoot, values: {} });
      await harness.callTool('nextSpot', { projectRoot });
      const verify = parseTextResult(await harness.callTool('verifySpot', { projectRoot }));
      expect(verify.pass).toBe(true);
      expect(verify.output).toBe('built');

      expect(spawnSpy).not.toHaveBeenCalled();
      expect(spawnSyncSpy).not.toHaveBeenCalled();
    } finally {
      await harness.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// Cycle-5 E-004 traversal — full hint→reference→auto-finish loop (A2/A6/A8/A13)
// ---------------------------------------------------------------------------

function setupCycle5Project(): { projectRoot: string } {
  const projectRoot = makeTempRoot();
  copyOrderbookPathInto(projectRoot);
  writeSettings(
    JSON.stringify({
      enabledPlugins: {
        'sui-pilot@local': true,
        [ENABLED_PLUGIN_KEY]: true,
      },
    }),
  );
  // Seed a target src/App.tsx so rung-3 has a file to read+overwrite.
  // The fixture's reference/App.tsx already has 219 lines, but we copy a
  // smaller version so target_range 39-58 is in-bounds.
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= 100; i++) lines.push(`SRC${i}`);
  fs.writeFileSync(path.join(projectRoot, 'src', 'App.tsx'), lines.join('\n'), 'utf8');
  return { projectRoot };
}

describe('E-004 cycle-5 full ladder traversal (A2)', () => {
  it('T-096: hint→reference→auto-finish (verify pass) → cursor advances; ladder flags monotonically true', async () => {
    const { projectRoot } = setupCycle5Project();
    const harness: any = await bootHarness({ projectRoot });
    try {
      // verifySpot stub: fail for the first 3 calls, then pass for rung-3 dispatch.
      // We toggle the stub between calls.
      await harness.callTool('start', { projectRoot });
      await harness.callTool('selectPath', { projectRoot, slug: '01-orderbook-viewer' });
      await harness.callTool('setPersonalization', { projectRoot, values: {} });
      await harness.callTool('nextSpot', { projectRoot });

      await harness.withVerifyStub({ pass: false, output: 'TS2304' });
      const v1 = parseTextResult(await harness.callTool('verifySpot', { projectRoot }));
      expect(v1.pass).toBe(false);

      const r1 = parseTextResult(
        await harness.callTool('requestHint', { projectRoot, rung: 1 }),
      );
      expect(r1.ok).toBe(true);
      expect(typeof r1.payload).toBe('string');

      // After rung 1 the persisted ladder flag flips.
      const stateAfter1 = JSON.parse(
        fs.readFileSync(
          path.join(projectRoot, '.sui-deepbook-course', 'state.json'),
          'utf8',
        ),
      );
      expect(stateAfter1.ladder['p1-spot-1'].hint_used).toBe(true);

      const v2 = parseTextResult(await harness.callTool('verifySpot', { projectRoot }));
      expect(v2.pass).toBe(false);

      const r2 = parseTextResult(
        await harness.callTool('requestHint', { projectRoot, rung: 2 }),
      );
      expect(r2.ok).toBe(true);

      const stateAfter2 = JSON.parse(
        fs.readFileSync(
          path.join(projectRoot, '.sui-deepbook-course', 'state.json'),
          'utf8',
        ),
      );
      expect(stateAfter2.ladder['p1-spot-1'].hint_used).toBe(true);
      expect(stateAfter2.ladder['p1-spot-1'].reference_shown).toBe(true);

      const v3 = parseTextResult(await harness.callTool('verifySpot', { projectRoot }));
      expect(v3.pass).toBe(false);

      // Switch to PASS stub for the rung-3 auto-verify dispatch.
      await harness.withVerifyStub({ pass: true, output: 'built' });
      const r3 = parseTextResult(
        await harness.callTool('requestHint', { projectRoot, rung: 3 }),
      );
      expect(r3.ok).toBe(true);
      expect(r3.autoVerifyResult).toBeTruthy();
      expect(r3.autoVerifyResult.pass).toBe(true);
      expect(r3.autoVerifyResult.advanced).toBe(true);

      // F-005: snapshot now lives under the workspace (<workspace>/.course-snapshots/)
      // for workspace-aware paths, not the legacy <projectRoot>/.sui-deepbook-course/snapshots/.
      const stateFinal = JSON.parse(
        fs.readFileSync(
          path.join(projectRoot, '.sui-deepbook-course', 'state.json'),
          'utf8',
        ),
      );
      const expectedSnapshotsRoot = stateFinal.workspace_path
        ? path.join(stateFinal.workspace_path, '.course-snapshots')
        : path.join(projectRoot, '.sui-deepbook-course', 'snapshots');
      const bakPath = path.join(expectedSnapshotsRoot, 'p1-spot-1.bak');
      expect(fs.existsSync(bakPath)).toBe(true);

      // Cursor advanced and ladder reflects all three rungs.
      expect(stateFinal.ladder['p1-spot-1'].hint_used).toBe(true);
      expect(stateFinal.ladder['p1-spot-1'].reference_shown).toBe(true);
      expect(stateFinal.ladder['p1-spot-1'].auto_completed).toBe(true);
      expect(stateFinal.ladder['p1-spot-1'].auto_write_attempted).toBe(true);
      expect(stateFinal.cursor.spot_id).not.toBe('p1-spot-1');
    } finally {
      await harness.shutdown();
    }
  }, 15000);

  it('T-097: post-rung-3 state survives a session restart (auto_completed permanence)', async () => {
    const { projectRoot } = setupCycle5Project();
    let harness: any = await bootHarness({ projectRoot });
    try {
      await harness.callTool('start', { projectRoot });
      await harness.callTool('selectPath', { projectRoot, slug: '01-orderbook-viewer' });
      await harness.callTool('setPersonalization', { projectRoot, values: {} });
      await harness.callTool('nextSpot', { projectRoot });
      await harness.withVerifyStub({ pass: false, output: 'X' });
      await harness.callTool('verifySpot', { projectRoot });
      await harness.callTool('requestHint', { projectRoot, rung: 1 });
      await harness.callTool('requestHint', { projectRoot, rung: 2 });
      await harness.withVerifyStub({ pass: true, output: 'OK' });
      await harness.callTool('requestHint', { projectRoot, rung: 3 });

      // Tear down and re-instantiate — state must survive.
      await harness.shutdown();

      harness = await bootHarness({ projectRoot });
      const startResult = parseTextResult(await harness.callTool('start', { projectRoot }));
      expect(startResult.outputStyleOk).toBe(true);
      // Read state.json directly to assert the auto_completed flag persisted.
      const persisted = JSON.parse(
        fs.readFileSync(
          path.join(projectRoot, '.sui-deepbook-course', 'state.json'),
          'utf8',
        ),
      );
      expect(persisted.ladder['p1-spot-1'].auto_completed).toBe(true);
    } finally {
      await harness.shutdown();
    }
  }, 15000);

  it('T-098: rung-3 verification failure → cursor unchanged; subsequent verifySpot pass advances cursor; auto_completed preserved', async () => {
    const { projectRoot } = setupCycle5Project();
    const harness: any = await bootHarness({ projectRoot });
    try {
      await harness.callTool('start', { projectRoot });
      await harness.callTool('selectPath', { projectRoot, slug: '01-orderbook-viewer' });
      await harness.callTool('setPersonalization', { projectRoot, values: {} });
      await harness.callTool('nextSpot', { projectRoot });

      await harness.withVerifyStub({ pass: false, output: 'X' });
      await harness.callTool('verifySpot', { projectRoot });
      await harness.callTool('requestHint', { projectRoot, rung: 1 });
      await harness.callTool('requestHint', { projectRoot, rung: 2 });
      // Rung 3 fails verification.
      const r3 = parseTextResult(
        await harness.callTool('requestHint', { projectRoot, rung: 3 }),
      );
      expect(r3.ok).toBe(true);
      expect(r3.autoVerifyResult.pass).toBe(false);
      expect(r3.autoVerifyResult.advanced).toBe(false);

      // Cursor still on p1-spot-1; auto_completed=true.
      const afterFail = JSON.parse(
        fs.readFileSync(
          path.join(projectRoot, '.sui-deepbook-course', 'state.json'),
          'utf8',
        ),
      );
      expect(afterFail.cursor.spot_id).toBe('p1-spot-1');
      expect(afterFail.ladder['p1-spot-1'].auto_completed).toBe(true);

      // F-005: snapshot under the workspace for workspace-aware paths,
      // legacy projectRoot location otherwise.
      const failSnapshotsRoot = afterFail.workspace_path
        ? path.join(afterFail.workspace_path, '.course-snapshots')
        : path.join(projectRoot, '.sui-deepbook-course', 'snapshots');
      expect(
        fs.existsSync(path.join(failSnapshotsRoot, 'p1-spot-1.bak')),
      ).toBe(true);

      // Switch to pass; verifySpot now advances.
      await harness.withVerifyStub({ pass: true, output: 'OK' });
      const v: any = parseTextResult(await harness.callTool('verifySpot', { projectRoot }));
      expect(v.pass).toBe(true);
      expect(v.advanced).toBe(true);

      const afterPass = JSON.parse(
        fs.readFileSync(
          path.join(projectRoot, '.sui-deepbook-course', 'state.json'),
          'utf8',
        ),
      );
      expect(afterPass.cursor.spot_id).not.toBe('p1-spot-1');
      // auto_completed preserved across cursor advance.
      expect(afterPass.ladder['p1-spot-1'].auto_completed).toBe(true);
    } finally {
      await harness.shutdown();
    }
  }, 15000);
});

describe('outputStyleOk gate across all five tools (A13)', () => {
  it('T-099: gate disabled → all five tools refuse to write to .sui-deepbook-course/', async () => {
    const projectRoot = makeTempRoot();
    copyOrderbookPathInto(projectRoot);
    // Write an explicit settings.json that DISABLES the learning style.
    writeSettings(
      JSON.stringify({
        enabledPlugins: {
          'sui-pilot@local': true,
          [ENABLED_PLUGIN_KEY]: false,
        },
      }),
    );
    const harness: any = await bootHarness({ projectRoot });
    try {
      await harness.callTool('selectPath', { projectRoot, slug: '01-orderbook-viewer' });
      await harness.callTool('setPersonalization', { projectRoot, values: {} });
      await harness.callTool('nextSpot', { projectRoot });
      await harness.callTool('verifySpot', { projectRoot });
      await harness.callTool('requestHint', { projectRoot, rung: 1 });

      // No state.json was created.
      const stateFile = path.join(projectRoot, '.sui-deepbook-course', 'state.json');
      expect(fs.existsSync(stateFile)).toBe(false);
      // No snapshots dir was created.
      const snapDir = path.join(projectRoot, '.sui-deepbook-course', 'snapshots');
      expect(fs.existsSync(snapDir)).toBe(false);
    } finally {
      await harness.shutdown();
    }
  }, 15000);
});

describe('harness requestHint helper + withRungContentMissing (A2/A9)', () => {
  it('T-100: harness.requestHint helper asserts response carries no shell action', async () => {
    const { projectRoot } = setupCycle5Project();
    const harness: any = await bootHarness({ projectRoot });
    try {
      expect(typeof harness.requestHint).toBe('function');
      await harness.callTool('start', { projectRoot });
      await harness.callTool('selectPath', { projectRoot, slug: '01-orderbook-viewer' });
      await harness.callTool('setPersonalization', { projectRoot, values: {} });
      await harness.callTool('nextSpot', { projectRoot });
      // Call helper — must not throw on a valid rung-1 request.
      const result = parseTextResult(await harness.requestHint({ projectRoot, rung: 1 }));
      expect(result.ok).toBe(true);
      // Helper itself can be inspected: the JSON should contain no kind:'shell'.
      const haystack = JSON.stringify(result);
      expect(haystack.includes('"kind":"shell"')).toBe(false);
      expect(haystack.includes("'kind':'shell'")).toBe(false);
    } finally {
      await harness.shutdown();
    }
  }, 15000);

  it('T-101: harness.withRungContentMissing temporarily renames auto.md and restores on cleanup', async () => {
    const { projectRoot } = setupCycle5Project();
    const harness: any = await bootHarness({ projectRoot });
    try {
      expect(typeof harness.withRungContentMissing).toBe('function');
      const autoMdPath = path.join(
        projectRoot,
        'paths',
        '01-orderbook-viewer',
        'rungs',
        'p1-spot-1',
        'auto.md',
      );
      expect(fs.existsSync(autoMdPath)).toBe(true);

      const fixture: any = await harness.withRungContentMissing('p1-spot-1');
      // While the helper is "active", auto.md should not be at its canonical path.
      expect(fs.existsSync(autoMdPath)).toBe(false);
      // Cleanup restores the file.
      if (typeof fixture?.cleanup === 'function') {
        await fixture.cleanup();
      }
      expect(fs.existsSync(autoMdPath)).toBe(true);
    } finally {
      await harness.shutdown();
    }
  }, 15000);
});

describe('cycle-5 full unit + integration suite green (A19)', () => {
  it('T-107: smoke marker — requestHint tool is registered and callable through MCP transport', async () => {
    const { projectRoot } = setupCycle5Project();
    const harness: any = await bootHarness({ projectRoot });
    try {
      await harness.callTool('start', { projectRoot });
      // The MCP transport must NOT report "tool not found" — requestHint
      // has to be a registered tool name.
      const result: any = await harness.callTool('requestHint', { projectRoot, rung: 1 });
      expect(result).toBeTruthy();
      // SDK error envelopes carry isError:true plus a content array describing
      // the missing tool. We expect the call to NOT be flagged as a tool-lookup
      // error.
      const isError = (result as any).isError === true;
      const text =
        (result as any).content?.[0]?.text ??
        (typeof (result as any).error === 'string' ? (result as any).error : '');
      const looksLikeMissingTool =
        isError && /tool|not found|unknown/i.test(String(text));
      expect(looksLikeMissingTool).toBe(false);
    } finally {
      await harness.shutdown();
    }
  }, 15000);
});
