import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Spy-mode mocks for fs surfaces.
vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Mock state.ts with the cycle-2/3/4 hoisted pattern so requestHint sees stub
// loadState/saveState. Tests override per-call via mockImplementation.
const stateMock = vi.hoisted(() => {
  return {
    loadState: vi.fn<(root: string) => Promise<unknown>>(async () => ({ kind: 'absent' })),
    saveState: vi.fn<(root: string, state: unknown) => Promise<void>>(async () => {}),
    STATE_SCHEMA_VERSION: 1 as const,
  };
});
vi.mock('../mcp/server/src/state.js', () => ({
  loadState: stateMock.loadState,
  saveState: stateMock.saveState,
  STATE_SCHEMA_VERSION: stateMock.STATE_SCHEMA_VERSION,
}));

// Mock outputStyle so we can flip the gate without writing a fake settings.json.
const outputStyleMock = vi.hoisted(() => {
  return {
    probeOutputStyle: vi.fn<() => Promise<unknown>>(async () => ({ ok: true })),
  };
});
vi.mock('../mcp/server/src/outputStyle.js', () => ({
  probeOutputStyle: outputStyleMock.probeOutputStyle,
}));

// Module under test — does not exist at red phase.
import { runRequestHint } from '../mcp/server/src/tools/requestHint.js';
import { registerTools } from '../mcp/server/src/index.js';
import { runVerifySpot } from '../mcp/server/src/tools/verifySpot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let tempRoots: string[] = [];

function makeTempRoot(prefix = 'sui-course-requesthint-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function seedOrderbookFixture(root: string): void {
  const slugDir = path.join(root, 'paths', '01-orderbook-viewer');
  const rungDir = path.join(slugDir, 'rungs', 'p1-spot-1');
  fs.mkdirSync(rungDir, { recursive: true });
  fs.writeFileSync(
    path.join(slugDir, 'path.json'),
    JSON.stringify({
      slug: '01-orderbook-viewer',
      title: 'Orderbook Viewer',
      summary: 'fixture',
      personalization_options: ['poll_interval_ms', 'pool_subset'],
      build_command: 'pnpm build',
      personalization_ranges: {
        poll_interval_ms: { min: 1000, max: 30000, default: 3000 },
        pool_subset: { values: ['both', 'DEEP_SUI', 'SUI_USDC'], default: 'both' },
      },
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(slugDir, 'phases.json'),
    JSON.stringify({
      phases: [
        {
          id: 'p1-bootstrap',
          spots: [
            {
              id: 'p1-spot-1',
              target_file: 'src/App.tsx',
              target_range: '10-15',
              prompt: 'Wire {{ pool_subset }}',
              rungs: {
                hint_md: 'rungs/p1-spot-1/hint.md',
                reference_md: 'rungs/p1-spot-1/reference.md',
                auto_write_md: 'rungs/p1-spot-1/auto.md',
              },
              verification: { mode: 'compile', command: 'pnpm build' },
            },
          ],
        },
        {
          id: 'p2-retry',
          spots: [
            {
              id: 'p2-spot-1',
              target_file: 'src/App.tsx',
              target_range: '20-25',
              prompt: 'TBD',
              verification: { mode: 'compile', command: 'pnpm build' },
            },
          ],
        },
      ],
    }),
    'utf8',
  );
  fs.writeFileSync(path.join(rungDir, 'hint.md'), 'HINT for {{ pool_subset }}\n', 'utf8');
  fs.writeFileSync(path.join(rungDir, 'reference.md'), 'REFERENCE for {{ pool_subset }}\n', 'utf8');
  fs.writeFileSync(
    path.join(rungDir, 'auto.md'),
    'AUTO1 {{ pool_subset }}\nAUTO2\nAUTO3\nAUTO4\nAUTO5\nAUTO6',
    'utf8',
  );
  const lines: string[] = [];
  for (let i = 1; i <= 30; i++) lines.push(`SRC${i}`);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'App.tsx'), lines.join('\n'), 'utf8');
}

function makeState(opts: {
  ladder?: Record<string, Partial<{
    hint_used: boolean;
    reference_shown: boolean;
    auto_completed: boolean;
    auto_write_attempted: boolean;
  }>>;
  cursor?: { phase_id: string; spot_id: string };
  personalization?: Record<string, unknown>;
  selected_path?: string | undefined;
} = {}): any {
  const fullLadder: Record<string, any> = {};
  for (const [id, rung] of Object.entries(opts.ladder ?? {})) {
    fullLadder[id] = {
      hint_used: rung.hint_used ?? false,
      reference_shown: rung.reference_shown ?? false,
      auto_completed: rung.auto_completed ?? false,
      auto_write_attempted: rung.auto_write_attempted ?? false,
    };
  }
  return {
    schema_version: 1,
    selected_path: opts.selected_path === undefined ? '01-orderbook-viewer' : opts.selected_path,
    personalization: opts.personalization ?? { pool_subset: 'DEEP_SUI', poll_interval_ms: 3000 },
    cursor: opts.cursor ?? { phase_id: 'p1-bootstrap', spot_id: 'p1-spot-1' },
    ladder: fullLadder,
    history: [],
  };
}

function deepFindShellKind(node: unknown): boolean {
  if (node === null || node === undefined) return false;
  if (typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((i) => deepFindShellKind(i));
  const obj = node as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, 'kind') && obj.kind === 'shell') return true;
  for (const v of Object.values(obj)) if (deepFindShellKind(v)) return true;
  return false;
}

beforeEach(() => {
  stateMock.loadState.mockReset();
  stateMock.saveState.mockReset();
  stateMock.saveState.mockImplementation(async () => {});
  outputStyleMock.probeOutputStyle.mockReset();
  outputStyleMock.probeOutputStyle.mockImplementation(async () => ({ ok: true }));
});

afterEach(() => {
  vi.restoreAllMocks();
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
// A1: registerTools registers the seventh tool
// ---------------------------------------------------------------------------

describe('registerTools — nine tools after PR 2 (A1)', () => {
  it('T-001: registers exactly nine tools including requestHint, selectStyle, and getNextPrompt', () => {
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
    expect(registered.length).toBe(9);
    expect(registered).toContain('requestHint');
    expect(registered).toContain('start');
    expect(registered).toContain('runPreflightProbe');
    expect(registered).toContain('selectPath');
    expect(registered).toContain('setPersonalization');
    expect(registered).toContain('selectStyle');
    expect(registered).toContain('getNextPrompt');
    expect(registered).toContain('nextSpot');
    expect(registered).toContain('verifySpot');
  });

  it('T-002: requestHint registration declares rung as z.union of literals 1, 2, 3', () => {
    const schemas: Record<string, any> = {};
    const stubServer = {
      tool: (name: string, _description: string, schemaArg: unknown, ..._rest: unknown[]) => {
        schemas[name] = schemaArg;
      },
      registerTool: (name: string, ...rest: unknown[]) => {
        const cfg = rest.find((r) => r && typeof r === 'object') as any;
        if (cfg && cfg.inputSchema !== undefined) schemas[name] = cfg.inputSchema;
        else if (rest[1] !== undefined) schemas[name] = rest[1];
      },
    } as any;
    registerTools(stubServer);
    const requestHintSchema = schemas['requestHint'];
    expect(requestHintSchema).toBeTruthy();
    const rungSchema = (requestHintSchema as any).rung;
    expect(rungSchema).toBeTruthy();
    expect(typeof rungSchema.safeParse).toBe('function');
    expect(rungSchema.safeParse(1).success).toBe(true);
    expect(rungSchema.safeParse(2).success).toBe(true);
    expect(rungSchema.safeParse(3).success).toBe(true);
    expect(rungSchema.safeParse(0).success).toBe(false);
    expect(rungSchema.safeParse(4).success).toBe(false);
    expect(rungSchema.safeParse('1').success).toBe(false);
    expect(rungSchema.safeParse(null).success).toBe(false);
    expect(rungSchema.safeParse(undefined).success).toBe(false);
  });

  it('T-003: index.ts contains the literal "requestHint" exactly once at the registration site', () => {
    const sourcePath = path.join(REPO_ROOT, 'mcp', 'server', 'src', 'index.ts');
    const content = fs.readFileSync(sourcePath, 'utf8');
    const matches = content.match(/'requestHint'/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('T-004: tools/ directory contains exactly nine .ts handler files (PR 2 added getNextPrompt)', () => {
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

  it('T-106: registerTools registers no tenth tool (PR 2 expanded the registered set to nine)', () => {
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
    const expected = new Set([
      'start',
      'runPreflightProbe',
      'selectPath',
      'setPersonalization',
      'selectStyle',
      'getNextPrompt',
      'nextSpot',
      'verifySpot',
      'requestHint',
    ]);
    const actual = new Set(registered);
    expect([...actual].sort()).toEqual([...expected].sort());
    expect(registered.length).toBe(expected.size);
  });
});

// ---------------------------------------------------------------------------
// A2/A4: rung-1 happy path + response shape
// ---------------------------------------------------------------------------

describe('runRequestHint(rung=1) happy path (A2/A4)', () => {
  it('T-005: returns ok:true with rendered hint payload (substituted) and no autoVerifyResult', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    stateMock.loadState.mockImplementation(async () => ({ kind: 'ok', state: makeState() }));
    const result: any = await runRequestHint({ projectRoot: root, rung: 1 });
    expect(result.ok).toBe(true);
    expect(typeof result.payload).toBe('string');
    expect(result.payload).toContain('HINT');
    expect(result.payload).toContain('DEEP_SUI');
    expect(result.payload).not.toContain('{{');
    expect(result.newLadder).toBeTruthy();
    expect(result.autoVerifyResult).toBeUndefined();
  });

  it('T-006: rung 1 flips state.ladder[spot.id].hint_used=true and saves it', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    let saved: any = null;
    stateMock.loadState.mockImplementation(async () => ({ kind: 'ok', state: makeState() }));
    stateMock.saveState.mockImplementation(async (_r, s) => {
      saved = s;
    });
    const result: any = await runRequestHint({ projectRoot: root, rung: 1 });
    expect(result.ok).toBe(true);
    expect(saved).toBeTruthy();
    expect(saved.ladder['p1-spot-1'].hint_used).toBe(true);
    expect(result.newLadder.hint_used).toBe(true);
  });

  it('T-007: rung 1 does NOT call runAutoWrite or write target_file/snapshots', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    stateMock.loadState.mockImplementation(async () => ({ kind: 'ok', state: makeState() }));
    const writeSpy = vi.spyOn(fsPromises, 'writeFile');
    const writeBefore = writeSpy.mock.calls.length;
    await runRequestHint({ projectRoot: root, rung: 1 });
    const snapDir = path.join(root, '.sui-deepbook-course', 'snapshots');
    expect(fs.existsSync(snapDir)).toBe(false);
    for (const c of writeSpy.mock.calls.slice(writeBefore)) {
      const p = String(c[0]);
      expect(p.includes('snapshots')).toBe(false);
    }
    const tgt = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');
    expect(tgt.startsWith('SRC1')).toBe(true);
    expect(tgt).not.toContain('AUTO1');
  });

  it('T-104: rung-1 response: autoVerifyResult is undefined/absent', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    stateMock.loadState.mockImplementation(async () => ({ kind: 'ok', state: makeState() }));
    const result: any = await runRequestHint({ projectRoot: root, rung: 1 });
    expect(result.ok).toBe(true);
    expect(result.autoVerifyResult).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, 'autoVerifyResult')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A3: rung gating
// ---------------------------------------------------------------------------

describe('runRequestHint — rung gating (A3, AC-5.1)', () => {
  it('T-008: rung 2 with hint_used=false returns rung-out-of-order; no state mutation; no auto-write', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeState({ ladder: { 'p1-spot-1': { hint_used: false, reference_shown: false } } }),
    }));
    const result: any = await runRequestHint({ projectRoot: root, rung: 2 });
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('rung-out-of-order');
    expect(result.error.requestedRung).toBe(2);
    expect(result.error.requiredPriorRung).toBe(1);
    expect(result.error.missingFlag).toBe('hint_used');
    expect(typeof result.error.message).toBe('string');
    expect(stateMock.saveState).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, '.sui-deepbook-course', 'snapshots'))).toBe(false);
  });

  it('T-010: rung 3 with reference_shown=false returns rung-out-of-order; missingFlag=reference_shown', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeState({ ladder: { 'p1-spot-1': { hint_used: true, reference_shown: false } } }),
    }));
    const result: any = await runRequestHint({ projectRoot: root, rung: 3 });
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('rung-out-of-order');
    expect(result.error.requestedRung).toBe(3);
    expect(result.error.requiredPriorRung).toBe(2);
    expect(result.error.missingFlag).toBe('reference_shown');
    expect(stateMock.saveState).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, '.sui-deepbook-course', 'snapshots'))).toBe(false);
    const tgt = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');
    expect(tgt.split('\n')[9]).toBe('SRC10');
  });

  it('T-011: gated rejection occurs BEFORE any side effect', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeState({ ladder: { 'p1-spot-1': { hint_used: true, reference_shown: false } } }),
    }));
    const writeSpy = vi.spyOn(fsPromises, 'writeFile');
    const mkdirSpy = vi.spyOn(fsPromises, 'mkdir');
    const result: any = await runRequestHint({ projectRoot: root, rung: 3 });
    expect(result.ok).toBe(false);
    expect(stateMock.saveState).not.toHaveBeenCalled();
    for (const c of writeSpy.mock.calls) {
      expect(String(c[0]).includes('.sui-deepbook-course')).toBe(false);
    }
    for (const c of mkdirSpy.mock.calls) {
      expect(String(c[0]).includes('snapshots')).toBe(false);
    }
  });

  it('T-012: rung 1 is always callable regardless of prior ladder state', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeState({
        ladder: {
          'p1-spot-1': {
            hint_used: true,
            reference_shown: true,
            auto_completed: true,
            auto_write_attempted: true,
          },
        },
      }),
    }));
    const result: any = await runRequestHint({ projectRoot: root, rung: 1 });
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A4: rung-2 happy path (append-only)
// ---------------------------------------------------------------------------

describe('runRequestHint(rung=2) happy path (A4)', () => {
  it('T-009: rung 2 flips reference_shown to true; hint_used preserved', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    let saved: any = null;
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeState({ ladder: { 'p1-spot-1': { hint_used: true, reference_shown: false } } }),
    }));
    stateMock.saveState.mockImplementation(async (_r, s) => {
      saved = s;
    });
    const result: any = await runRequestHint({ projectRoot: root, rung: 2 });
    expect(result.ok).toBe(true);
    expect(typeof result.payload).toBe('string');
    expect(result.payload).toContain('REFERENCE');
    expect(result.payload).toContain('DEEP_SUI');
    expect(saved.ladder['p1-spot-1'].reference_shown).toBe(true);
    expect(saved.ladder['p1-spot-1'].hint_used).toBe(true);
  });

  it('T-105: rung-2 response: autoVerifyResult is undefined/absent', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeState({ ladder: { 'p1-spot-1': { hint_used: true, reference_shown: false } } }),
    }));
    const result: any = await runRequestHint({ projectRoot: root, rung: 2 });
    expect(result.ok).toBe(true);
    expect(result.autoVerifyResult).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, 'autoVerifyResult')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A5/A6: rung-3 happy + sad paths, auto_completed durability
// ---------------------------------------------------------------------------

describe('runRequestHint(rung=3) happy + sad paths (A5/A6)', () => {
  function rungReadyState(): any {
    return makeState({
      ladder: {
        'p1-spot-1': {
          hint_used: true,
          reference_shown: true,
          auto_completed: false,
          auto_write_attempted: false,
        },
      },
    });
  }

  it('T-013: rung 3 with verifySpot pass: snapshot+overwrite+auto_completed=true+cursor advance', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    let saved: any = null;
    let firstLoad = true;
    stateMock.loadState.mockImplementation(async () => {
      if (saved && !firstLoad) return { kind: 'ok', state: saved };
      firstLoad = false;
      return { kind: 'ok', state: rungReadyState() };
    });
    stateMock.saveState.mockImplementation(async (_r, s) => {
      saved = s;
    });
    const stubSpawn = (() => ({ status: 0, stdout: 'built', stderr: '' })) as any;
    const result: any = await runRequestHint(
      { projectRoot: root, rung: 3 },
      { spawn: stubSpawn },
    );
    expect(result.ok).toBe(true);
    expect(typeof result.payload).toBe('string');
    expect(result.payload).toContain('AUTO1');
    expect(result.payload).toContain('DEEP_SUI');
    expect(result.autoVerifyResult).toBeTruthy();
    expect(result.autoVerifyResult.pass).toBe(true);
    expect(result.autoVerifyResult.advanced).toBe(true);
    const bakPath = path.join(root, '.sui-deepbook-course', 'snapshots', 'p1-spot-1.bak');
    expect(fs.existsSync(bakPath)).toBe(true);
    const bak = fs.readFileSync(bakPath, 'utf8');
    expect(bak).toContain('SRC10');
    expect(bak).not.toContain('AUTO1');
    const tgt = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8').split('\n');
    expect(tgt[9]).toContain('AUTO1');
    expect(tgt[9]).toContain('DEEP_SUI');
    expect(saved).toBeTruthy();
    expect(saved.ladder['p1-spot-1'].auto_completed).toBe(true);
    expect(saved.cursor.phase_id).toBe('p2-retry');
    expect(saved.cursor.spot_id).toBe('p2-spot-1');
  });

  it('T-014: rung 3 with verifySpot fail: side effects committed, cursor unchanged, auto_completed=true', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    const savedHistory: any[] = [];
    let firstLoad = true;
    stateMock.loadState.mockImplementation(async () => {
      if (savedHistory.length > 0 && !firstLoad) {
        return { kind: 'ok', state: savedHistory[savedHistory.length - 1] };
      }
      firstLoad = false;
      return { kind: 'ok', state: rungReadyState() };
    });
    stateMock.saveState.mockImplementation(async (_r, s) => {
      savedHistory.push(s);
    });
    const stubSpawn = (() => ({ status: 1, stdout: '', stderr: 'TS2304' })) as any;
    const result: any = await runRequestHint(
      { projectRoot: root, rung: 3 },
      { spawn: stubSpawn },
    );
    expect(result.ok).toBe(true);
    expect(result.autoVerifyResult).toBeTruthy();
    expect(result.autoVerifyResult.pass).toBe(false);
    expect(result.autoVerifyResult.advanced).toBe(false);
    const bakPath = path.join(root, '.sui-deepbook-course', 'snapshots', 'p1-spot-1.bak');
    expect(fs.existsSync(bakPath)).toBe(true);
    const tgt = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8').split('\n');
    expect(tgt[9]).toContain('AUTO1');
    expect(savedHistory.length).toBeGreaterThan(0);
    const last = savedHistory[savedHistory.length - 1];
    expect(last.ladder['p1-spot-1'].auto_completed).toBe(true);
    expect(last.cursor.phase_id).toBe('p1-bootstrap');
    expect(last.cursor.spot_id).toBe('p1-spot-1');
  });

  it('T-015: auto_completed remains true across a subsequent verifySpot fail on the same spot', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    const savedHistory: any[] = [];
    let firstLoad = true;
    stateMock.loadState.mockImplementation(async () => {
      if (savedHistory.length > 0 && !firstLoad) {
        return { kind: 'ok', state: savedHistory[savedHistory.length - 1] };
      }
      firstLoad = false;
      return { kind: 'ok', state: rungReadyState() };
    });
    stateMock.saveState.mockImplementation(async (_r, s) => {
      savedHistory.push(s);
    });
    const failSpawn = (() => ({ status: 1, stdout: '', stderr: 'TS2304' })) as any;
    await runRequestHint({ projectRoot: root, rung: 3 }, { spawn: failSpawn });
    const lastAfterRung3 = savedHistory[savedHistory.length - 1];
    expect(lastAfterRung3.ladder['p1-spot-1'].auto_completed).toBe(true);
    await runVerifySpot({ projectRoot: root }, { spawn: failSpawn });
    const lastAfterVerify = savedHistory[savedHistory.length - 1];
    expect(lastAfterVerify.ladder['p1-spot-1'].auto_completed).toBe(true);
  });

  it('T-016: auto_completed remains true after subsequent verifySpot pass that advances cursor', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    const savedHistory: any[] = [];
    let firstLoad = true;
    stateMock.loadState.mockImplementation(async () => {
      if (savedHistory.length > 0 && !firstLoad) {
        return { kind: 'ok', state: savedHistory[savedHistory.length - 1] };
      }
      firstLoad = false;
      return { kind: 'ok', state: rungReadyState() };
    });
    stateMock.saveState.mockImplementation(async (_r, s) => {
      savedHistory.push(s);
    });
    const failSpawn = (() => ({ status: 1, stdout: '', stderr: 'TS2304' })) as any;
    const passSpawn = (() => ({ status: 0, stdout: 'built', stderr: '' })) as any;
    await runRequestHint({ projectRoot: root, rung: 3 }, { spawn: failSpawn });
    const verifyResult: any = await runVerifySpot({ projectRoot: root }, { spawn: passSpawn });
    expect(verifyResult.pass).toBe(true);
    expect(verifyResult.advanced).toBe(true);
    const last = savedHistory[savedHistory.length - 1];
    expect(last.cursor.spot_id).toBe('p2-spot-1');
    expect(last.ladder['p1-spot-1'].auto_completed).toBe(true);
  });

  it('T-017: re-attempt after failed rung 3 — verifySpot pass advances cursor exactly once', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    const savedHistory: any[] = [];
    let firstLoad = true;
    stateMock.loadState.mockImplementation(async () => {
      if (savedHistory.length > 0 && !firstLoad) {
        return { kind: 'ok', state: savedHistory[savedHistory.length - 1] };
      }
      firstLoad = false;
      return { kind: 'ok', state: rungReadyState() };
    });
    stateMock.saveState.mockImplementation(async (_r, s) => {
      savedHistory.push(s);
    });
    const failSpawn = (() => ({ status: 1, stdout: '', stderr: 'TS2304' })) as any;
    const passSpawn = (() => ({ status: 0, stdout: 'built', stderr: '' })) as any;
    await runRequestHint({ projectRoot: root, rung: 3 }, { spawn: failSpawn });
    expect(savedHistory[savedHistory.length - 1].cursor.spot_id).toBe('p1-spot-1');
    const result: any = await runVerifySpot({ projectRoot: root }, { spawn: passSpawn });
    expect(result.pass).toBe(true);
    expect(result.advanced).toBe(true);
    expect(savedHistory[savedHistory.length - 1].cursor.phase_id).toBe('p2-retry');
    expect(savedHistory[savedHistory.length - 1].cursor.spot_id).toBe('p2-spot-1');
    expect(savedHistory[savedHistory.length - 1].ladder['p1-spot-1'].auto_completed).toBe(true);
  });

  it('T-018: second rung-3 rotates existing .bak to .bak.<timestamp>; auto_completed stays true', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    const savedHistory: any[] = [];
    let firstLoad = true;
    stateMock.loadState.mockImplementation(async () => {
      if (savedHistory.length > 0 && !firstLoad) {
        return { kind: 'ok', state: savedHistory[savedHistory.length - 1] };
      }
      firstLoad = false;
      return { kind: 'ok', state: rungReadyState() };
    });
    stateMock.saveState.mockImplementation(async (_r, s) => {
      savedHistory.push(s);
    });
    const failSpawn = (() => ({ status: 1, stdout: '', stderr: 'TS2304' })) as any;
    await runRequestHint({ projectRoot: root, rung: 3 }, { spawn: failSpawn });
    const tgtPath = path.join(root, 'src', 'App.tsx');
    const lines = fs.readFileSync(tgtPath, 'utf8').split('\n');
    for (let i = 9; i <= 14; i++) lines[i] = `MID${i + 1}`;
    fs.writeFileSync(tgtPath, lines.join('\n'), 'utf8');
    await runRequestHint({ projectRoot: root, rung: 3 }, { spawn: failSpawn });
    const snapDir = path.join(root, '.sui-deepbook-course', 'snapshots');
    const entries = fs.readdirSync(snapDir);
    const bak = entries.filter((n) => n === 'p1-spot-1.bak');
    expect(bak.length).toBe(1);
    const rotated = entries.filter((n) => /^p1-spot-1\.bak\..+/.test(n));
    expect(rotated.length).toBe(1);
    expect(/^p1-spot-1\.bak\.\d{4}-\d{2}-\d{2}T\d{2}\d{2}\d{2}/.test(rotated[0])).toBe(true);
    const currentBak = fs.readFileSync(path.join(snapDir, 'p1-spot-1.bak'), 'utf8');
    expect(currentBak).toContain('MID');
    const rotatedBak = fs.readFileSync(path.join(snapDir, rotated[0]), 'utf8');
    expect(rotatedBak).toContain('SRC');
    expect(rotatedBak).not.toContain('MID');
    expect(savedHistory[savedHistory.length - 1].ladder['p1-spot-1'].auto_completed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A8: re-attempt semantics
// ---------------------------------------------------------------------------

describe('runRequestHint — re-attempt semantics (A8)', () => {
  it('T-008b: post-fail edit + verifySpot pass invokes saveState exactly once more', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    const savedHistory: any[] = [];
    let firstLoad = true;
    stateMock.loadState.mockImplementation(async () => {
      if (savedHistory.length > 0 && !firstLoad) {
        return { kind: 'ok', state: savedHistory[savedHistory.length - 1] };
      }
      firstLoad = false;
      return {
        kind: 'ok',
        state: makeState({
          ladder: { 'p1-spot-1': { hint_used: true, reference_shown: true } },
        }),
      };
    });
    stateMock.saveState.mockImplementation(async (_r, s) => {
      savedHistory.push(s);
    });
    const failSpawn = (() => ({ status: 1, stdout: '', stderr: 'X' })) as any;
    const passSpawn = (() => ({ status: 0, stdout: 'OK', stderr: '' })) as any;
    await runRequestHint({ projectRoot: root, rung: 3 }, { spawn: failSpawn });
    const before = savedHistory.length;
    await runVerifySpot({ projectRoot: root }, { spawn: passSpawn });
    const after = savedHistory.length;
    expect(after - before).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A13: outputStyle gate
// ---------------------------------------------------------------------------

describe('runRequestHint — outputStyleOk gate (A13)', () => {
  it('T-022: outputStyleOk=false short-circuits with output-style-disabled and zero writes', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    outputStyleMock.probeOutputStyle.mockImplementation(async () => ({ ok: false }));
    const writeSpy = vi.spyOn(fsPromises, 'writeFile');
    const renameSpy = vi.spyOn(fsPromises, 'rename');
    const mkdirSpy = vi.spyOn(fsPromises, 'mkdir');
    for (const rung of [1, 2, 3] as const) {
      const result: any = await runRequestHint({ projectRoot: root, rung });
      expect(result.ok).toBe(false);
      expect(result.error.kind).toBe('output-style-disabled');
      expect(typeof result.error.message).toBe('string');
    }
    expect(stateMock.loadState).not.toHaveBeenCalled();
    for (const c of writeSpy.mock.calls) {
      expect(String(c[0]).includes('.sui-deepbook-course')).toBe(false);
    }
    for (const c of renameSpy.mock.calls) {
      expect(String(c[1]).includes('.sui-deepbook-course')).toBe(false);
    }
    for (const c of mkdirSpy.mock.calls) {
      expect(String(c[0]).includes('snapshots')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// A12: state-save-failed wrap
// ---------------------------------------------------------------------------

describe('runRequestHint — state-save-failed (A12)', () => {
  it('T-023: rung 1 saveState rejection surfaces structured error', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    stateMock.loadState.mockImplementation(async () => ({ kind: 'ok', state: makeState() }));
    stateMock.saveState.mockImplementation(async () => {
      const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      throw err;
    });
    let caught: unknown;
    let result: any;
    try {
      result = await runRequestHint({ projectRoot: root, rung: 1 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeUndefined();
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('state-save-failed');
    expect(typeof result.error.message).toBe('string');
    expect(result.error.message).toMatch(/EACCES/);
  });

  it('T-024: rung 3 saveState rejection after auto-write surfaces structured error', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeState({
        ladder: { 'p1-spot-1': { hint_used: true, reference_shown: true } },
      }),
    }));
    stateMock.saveState.mockImplementation(async () => {
      const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      throw err;
    });
    const stubSpawn = (() => ({ status: 0, stdout: 'built', stderr: '' })) as any;
    let caught: unknown;
    let result: any;
    try {
      result = await runRequestHint({ projectRoot: root, rung: 3 }, { spawn: stubSpawn });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeUndefined();
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('state-save-failed');
    expect(typeof result.error.message).toBe('string');
    const bakPath = path.join(root, '.sui-deepbook-course', 'snapshots', 'p1-spot-1.bak');
    expect(fs.existsSync(bakPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A2: error branches
// ---------------------------------------------------------------------------

describe('runRequestHint — error branches (A2)', () => {
  it('T-025: loadState absent → no-state', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    stateMock.loadState.mockImplementation(async () => ({ kind: 'absent' }));
    const result: any = await runRequestHint({ projectRoot: root, rung: 1 });
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('no-state');
    expect(stateMock.saveState).not.toHaveBeenCalled();
  });

  it('T-026: state has no selected_path → no-path-selected', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    const stateNoPath = makeState({ selected_path: '' });
    stateMock.loadState.mockImplementation(async () => ({ kind: 'ok', state: stateNoPath }));
    const result: any = await runRequestHint({ projectRoot: root, rung: 1 });
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('no-path-selected');
    expect(stateMock.saveState).not.toHaveBeenCalled();
  });

  it('T-027: loadState corrupt → state-corrupt', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    stateMock.loadState.mockImplementation(async () => ({ kind: 'corrupt', message: 'invalid JSON' }));
    const result: any = await runRequestHint({ projectRoot: root, rung: 1 });
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('state-corrupt');
    expect(stateMock.saveState).not.toHaveBeenCalled();
  });

  it('T-028: loadState schema-mismatch → state-schema-mismatch', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'schema-mismatch',
      foundVersion: 999,
      message: 'incompatible',
    }));
    const result: any = await runRequestHint({ projectRoot: root, rung: 1 });
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('state-schema-mismatch');
    expect(stateMock.saveState).not.toHaveBeenCalled();
  });

  it('T-029: phases.json missing → phases-load-failed', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    fs.rmSync(path.join(root, 'paths', '01-orderbook-viewer', 'phases.json'));
    stateMock.loadState.mockImplementation(async () => ({ kind: 'ok', state: makeState() }));
    const result: any = await runRequestHint({ projectRoot: root, rung: 1 });
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('phases-load-failed');
    expect(stateMock.saveState).not.toHaveBeenCalled();
  });

  it('T-030: cursor done (past last spot) → no-active-spot', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    const doneState = makeState({ cursor: { phase_id: '__done__', spot_id: '__done__' } });
    stateMock.loadState.mockImplementation(async () => ({ kind: 'ok', state: doneState }));
    const result: any = await runRequestHint({ projectRoot: root, rung: 1 });
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('no-active-spot');
    expect(stateMock.saveState).not.toHaveBeenCalled();
  });

  it('T-031: rung 3 with auto.md absent → rung-content-missing; no snapshot, no overwrite', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    fs.rmSync(path.join(root, 'paths', '01-orderbook-viewer', 'rungs', 'p1-spot-1', 'auto.md'));
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeState({
        ladder: { 'p1-spot-1': { hint_used: true, reference_shown: true } },
      }),
    }));
    const result: any = await runRequestHint({ projectRoot: root, rung: 3 });
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('rung-content-missing');
    expect(fs.existsSync(path.join(root, '.sui-deepbook-course', 'snapshots'))).toBe(false);
    const tgt = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');
    expect(tgt.split('\n')[9]).toBe('SRC10');
    expect(stateMock.saveState).not.toHaveBeenCalled();
  });

  it('T-032: rung 1 with hint.md absent → rung-content-missing; saveState NOT called', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    fs.rmSync(path.join(root, 'paths', '01-orderbook-viewer', 'rungs', 'p1-spot-1', 'hint.md'));
    stateMock.loadState.mockImplementation(async () => ({ kind: 'ok', state: makeState() }));
    const result: any = await runRequestHint({ projectRoot: root, rung: 1 });
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('rung-content-missing');
    expect(stateMock.saveState).not.toHaveBeenCalled();
  });

  it('T-033: rung 3 with target_file missing → auto-write-failed; no auto_completed flip', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    fs.rmSync(path.join(root, 'src', 'App.tsx'));
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeState({
        ladder: { 'p1-spot-1': { hint_used: true, reference_shown: true } },
      }),
    }));
    const result: any = await runRequestHint({ projectRoot: root, rung: 3 });
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('auto-write-failed');
    expect(stateMock.saveState).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A10: substitution scoping
// ---------------------------------------------------------------------------

describe('runRequestHint — substitution scope (A10)', () => {
  it('T-034: rung-3 payload is substituted via substitutePromptOnly before write', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    let saved: any = null;
    let firstLoad = true;
    stateMock.loadState.mockImplementation(async () => {
      if (saved && !firstLoad) return { kind: 'ok', state: saved };
      firstLoad = false;
      return {
        kind: 'ok',
        state: makeState({
          ladder: { 'p1-spot-1': { hint_used: true, reference_shown: true } },
          personalization: { pool_subset: 'DEEP_SUI', poll_interval_ms: 5000 },
        }),
      };
    });
    stateMock.saveState.mockImplementation(async (_r, s) => {
      saved = s;
    });
    const stubSpawn = (() => ({ status: 0, stdout: '', stderr: '' })) as any;
    await runRequestHint({ projectRoot: root, rung: 3 }, { spawn: stubSpawn });
    const tgt = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');
    expect(tgt).toContain('DEEP_SUI');
    expect(tgt).not.toContain('{{ pool_subset }}');
    expect(tgt).not.toContain('{{pool_subset}}');
  });
});

// ---------------------------------------------------------------------------
// A9: kind:'shell' surface guards
// ---------------------------------------------------------------------------

describe('runRequestHint — shell-action surface guards (A9)', () => {
  it('T-035: requestHint.ts source contains zero kind:"shell" literals', () => {
    const sourcePath = path.join(REPO_ROOT, 'mcp', 'server', 'src', 'tools', 'requestHint.ts');
    const content = fs.readFileSync(sourcePath, 'utf8');
    expect(/kind\s*:\s*'shell'/.test(content)).toBe(false);
    expect(/kind\s*:\s*"shell"/.test(content)).toBe(false);
  });

  it('T-037: every documented response branch serializes without kind:"shell" anywhere', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    const responses: any[] = [];
    stateMock.loadState.mockImplementation(async () => ({ kind: 'ok', state: makeState() }));
    responses.push(await runRequestHint({ projectRoot: root, rung: 1 }));
    outputStyleMock.probeOutputStyle.mockImplementationOnce(async () => ({ ok: false }));
    responses.push(await runRequestHint({ projectRoot: root, rung: 1 }));
    stateMock.loadState.mockImplementationOnce(async () => ({ kind: 'absent' }));
    responses.push(await runRequestHint({ projectRoot: root, rung: 1 }));
    stateMock.loadState.mockImplementationOnce(async () => ({ kind: 'corrupt', message: 'broken' }));
    responses.push(await runRequestHint({ projectRoot: root, rung: 1 }));
    stateMock.loadState.mockImplementationOnce(async () => ({
      kind: 'schema-mismatch',
      foundVersion: 9,
      message: 'no',
    }));
    responses.push(await runRequestHint({ projectRoot: root, rung: 1 }));
    for (const r of responses) {
      expect(deepFindShellKind(r)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// A6: append-only auto_completed source guards
// ---------------------------------------------------------------------------

describe('runRequestHint — append-only auto_completed source guards (A6)', () => {
  it('T-039: requestHint.ts contains zero "auto_completed = false" assignments', () => {
    const sourcePath = path.join(REPO_ROOT, 'mcp', 'server', 'src', 'tools', 'requestHint.ts');
    const content = fs.readFileSync(sourcePath, 'utf8');
    expect(/auto_completed\s*=\s*false/.test(content)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A12: warnings.ts kinds
// ---------------------------------------------------------------------------

describe('warnings.ts new kinds for cycle 5 (A12, A13)', () => {
  function readWarnings(): string {
    return fs.readFileSync(path.join(REPO_ROOT, 'mcp', 'server', 'src', 'warnings.ts'), 'utf8');
  }
  it('T-085: warnings.ts exports state-save-failed kind', () => {
    expect(readWarnings()).toContain('state-save-failed');
  });
  it('T-086: warnings.ts exports auto-write-failed kind', () => {
    expect(readWarnings()).toContain('auto-write-failed');
  });
  it('T-087: warnings.ts exports output-style-disabled kind', () => {
    expect(readWarnings()).toContain('output-style-disabled');
  });
});

// ---------------------------------------------------------------------------
// A17: registry-warning baseline
// ---------------------------------------------------------------------------

describe('registry warning kinds remain exactly 8 (A17)', () => {
  it('T-088: registry.ts emits exactly the 8 baseline kinds', () => {
    const sourcePath = path.join(REPO_ROOT, 'mcp', 'server', 'src', 'registry.ts');
    const content = fs.readFileSync(sourcePath, 'utf8');
    const kindRe = /kind\s*:\s*['"]([a-z0-9-]+)['"]/g;
    const found = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = kindRe.exec(content)) !== null) {
      found.add(m[1]);
    }
    const expected = new Set([
      'no-paths-dir',
      'empty-paths-dir',
      'missing-path-json',
      'malformed-path-json',
      'invalid-path-json',
      'missing-phases-json',
      'malformed-phases-json',
      'invalid-phases-json',
    ]);
    expect([...found].sort()).toEqual([...expected].sort());
    expect(found.has('state-save-failed')).toBe(false);
    expect(found.has('auto-write-failed')).toBe(false);
    expect(found.has('output-style-disabled')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A17: cycle invariants
// ---------------------------------------------------------------------------

describe('cycle 1-4 invariants preserved on cycle-5 surface (A17)', () => {
  function walkTs(root: string, out: string[] = []): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walkTs(full, out);
      } else if (entry.isFile() && full.endsWith('.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it('T-089: engine code outside paths/ contains zero "01-orderbook-viewer" string literals', () => {
    const SLUG = '01-orderbook-viewer';
    const SCAN_ROOTS = [path.join(REPO_ROOT, 'mcp', 'server', 'src')];
    const offenders: string[] = [];
    for (const r of SCAN_ROOTS) {
      for (const f of walkTs(r)) {
        const c = fs.readFileSync(f, 'utf8');
        if (c.indexOf(SLUG) !== -1) offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('T-090: engine code contains zero setSpawnOverride / setVerifyOverride symbols', () => {
    const files = walkTs(path.join(REPO_ROOT, 'mcp', 'server', 'src'));
    let setSpawn = 0;
    let setVerify = 0;
    for (const f of files) {
      const c = fs.readFileSync(f, 'utf8');
      if (/setSpawnOverride/.test(c)) setSpawn += 1;
      if (/setVerifyOverride/.test(c)) setVerify += 1;
    }
    expect(setSpawn).toBe(0);
    expect(setVerify).toBe(0);
  });

  it('T-091: kind:"shell" literal is confined to runPreflightProbe.ts, preflight.ts (type def), and probes/manifest.ts (probe #7 emitter)', () => {
    // Cycle 5 amendment: cycle 3's contract established that probe #7
    // (sandbox-manifest-reachable, in probes/manifest.ts) is the legitimate
    // emitter of `kind: 'shell'` actions, and the type union has lived in
    // preflight.ts since cycle 3. The cycle-1 / cycle-4 invariant being
    // protected here is "no NEW tool emits shell actions" — the runPreflightProbe
    // tool stays the only TOOL that may surface a shell action, but the
    // production code path that constructs it legitimately runs through
    // probe #7 (manifest.ts) and references the type from preflight.ts.
    const files = walkTs(path.join(REPO_ROOT, 'mcp', 'server', 'src'));
    const ALLOWED = new Set([
      'runPreflightProbe.ts',
      'preflight.ts',
      'manifest.ts',
    ]);
    const offenders: string[] = [];
    for (const f of files) {
      const c = fs.readFileSync(f, 'utf8');
      if (/kind\s*:\s*['"]shell['"]/.test(c)) offenders.push(f);
    }
    for (const f of offenders) {
      expect(ALLOWED.has(path.basename(f)), `unexpected shell-literal in ${f}`).toBe(true);
    }
  });

  it('T-092: substitutePromptOnly remains the only {{...}} resolver in engine code', () => {
    const files = walkTs(path.join(REPO_ROOT, 'mcp', 'server', 'src'));
    const offenders: string[] = [];
    for (const f of files) {
      if (path.basename(f) === 'personalization.ts') continue;
      const c = fs.readFileSync(f, 'utf8');
      if (/\{\{\s*[a-zA-Z_]/.test(c)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A18: schema additions are append-only
// ---------------------------------------------------------------------------

describe('schema additions are append-only (A18)', () => {
  it('T-093: STATE_SCHEMA_VERSION remains at 1 after cycle 5', async () => {
    const mod = await import('../mcp/server/src/state.js');
    expect(mod.STATE_SCHEMA_VERSION).toBe(1);
  });

  it('T-094: existing state.json without auto_write_attempted loads to kind:"ok" (back-compat)', async () => {
    const mod = await import('../mcp/server/src/schemas/state.js');
    const legacyShape = {
      schema_version: 1,
      selected_path: '01-orderbook-viewer',
      personalization: {},
      cursor: { phase_id: 'p1-bootstrap', spot_id: 'p1-spot-1' },
      ladder: {
        'p1-spot-1': {
          hint_used: true,
          reference_shown: false,
          auto_completed: false,
        },
      },
      history: [],
    };
    const result = mod.validateState(legacyShape);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ladder['p1-spot-1'].auto_write_attempted).toBe(false);
    }
  });

  it('T-095: rung-3 sets BOTH auto_completed AND auto_write_attempted to true on disk', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    // Stateful mock: subsequent loadState calls see what saveState wrote.
    // Without this, runVerifySpot's internal reload sees the stale seed state
    // (without rung-3 flags) and saves an advanced state that lacks them —
    // which doesn't reflect production where the disk state IS updated by
    // the rung-3 saveState before runVerifySpot loads.
    let current: any = makeState({
      ladder: { 'p1-spot-1': { hint_used: true, reference_shown: true } },
    });
    const allSaves: any[] = [];
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: current,
    }));
    stateMock.saveState.mockImplementation(async (_r, s) => {
      current = s;
      allSaves.push(s);
    });
    const stubSpawn = (() => ({ status: 0, stdout: '', stderr: '' })) as any;
    await runRequestHint({ projectRoot: root, rung: 3 }, { spawn: stubSpawn });
    // Both the rung-3 saveState AND any subsequent verifySpot advance-save
    // must preserve auto_completed + auto_write_attempted (append-only).
    expect(allSaves.length).toBeGreaterThan(0);
    for (const s of allSaves) {
      expect(s.ladder['p1-spot-1'].auto_completed).toBe(true);
      expect(s.ladder['p1-spot-1'].auto_write_attempted).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// A2/A7: read-first ordering for rung 3 + step ordering
// ---------------------------------------------------------------------------

describe('runRequestHint — rung-3 read-first + step ordering (A2/A7)', () => {
  it('T-102: rung-3 with auto.md absent returns BEFORE any snapshot side effect', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    fs.rmSync(path.join(root, 'paths', '01-orderbook-viewer', 'rungs', 'p1-spot-1', 'auto.md'));
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeState({
        ladder: { 'p1-spot-1': { hint_used: true, reference_shown: true } },
      }),
    }));
    const mkdirSpy = vi.spyOn(fsPromises, 'mkdir');
    const writeSpy = vi.spyOn(fsPromises, 'writeFile');
    const result: any = await runRequestHint({ projectRoot: root, rung: 3 });
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('rung-content-missing');
    for (const c of mkdirSpy.mock.calls) {
      expect(String(c[0]).includes('snapshots')).toBe(false);
    }
    for (const c of writeSpy.mock.calls) {
      expect(/\.bak/.test(String(c[0]))).toBe(false);
    }
    const tgt = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');
    expect(tgt.split('\n')[9]).toBe('SRC10');
  });

  it('T-103: rung-3 happy step ordering — snapshot.bak < target_file < saveState', async () => {
    const root = makeTempRoot();
    seedOrderbookFixture(root);
    let saved: any = null;
    let saveOrder = -1;
    let writeCounter = 0;
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeState({
        ladder: { 'p1-spot-1': { hint_used: true, reference_shown: true } },
      }),
    }));
    stateMock.saveState.mockImplementation(async (_r, s) => {
      saved = s;
      saveOrder = writeCounter;
    });
    const writeOrder: { p: string; idx: number }[] = [];
    // Spy-mode mock at module top forwards to real fs.promises by default,
    // so we just record the order of calls in a side-table without
    // reinstalling a recursive mockImplementation.
    const writeSpy = vi.spyOn(fsPromises, 'writeFile');
    const writeWatch = vi.fn(async (...args: unknown[]) => {
      writeCounter += 1;
      writeOrder.push({ p: String(args[0]), idx: writeCounter });
    });
    // Wrap each real call: invoke writeWatch (records order), then forward.
    // We do this by chaining mockImplementation through fs.writeFileSync.
    writeSpy.mockImplementation(async (p: any, bytes: any, opts?: any) => {
      writeCounter += 1;
      writeOrder.push({ p: String(p), idx: writeCounter });
      // Forward synchronously (not intercepted by the fsPromises spy).
      const writeOpts: fs.WriteFileOptions =
        typeof opts === 'string' ? opts : (opts ?? {});
      fs.writeFileSync(p, bytes, writeOpts);
    });
    void writeWatch;
    const stubSpawn = (() => ({ status: 0, stdout: '', stderr: '' })) as any;
    await runRequestHint({ projectRoot: root, rung: 3 }, { spawn: stubSpawn });
    const bakIdx = writeOrder.findIndex((w) => /\.bak$/.test(w.p) || /\.bak\..+$/.test(w.p));
    const tgtIdx = writeOrder.findIndex((w) => w.p.endsWith(path.join('src', 'App.tsx')));
    expect(bakIdx).toBeGreaterThanOrEqual(0);
    expect(tgtIdx).toBeGreaterThanOrEqual(0);
    expect(writeOrder[bakIdx].idx).toBeLessThan(writeOrder[tgtIdx].idx);
    // saveOrder captures the writeCounter at the moment saveState fires.
    // Since saveState itself is not a writeFile call, the counter doesn't
    // tick again after the target write. So `saveOrder >= tgtIdx` is the
    // load-bearing claim ("saveState fires AT-OR-AFTER the target write" —
    // never before it).
    expect(saveOrder).toBeGreaterThanOrEqual(writeOrder[tgtIdx].idx);
    expect(saved).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// A16: course-conductor.md
// ---------------------------------------------------------------------------

describe('agents/course-conductor.md content (A16)', () => {
  const conductorPath = path.join(REPO_ROOT, 'agents', 'course-conductor.md');

  it('T-059: course-conductor.md exists', () => {
    expect(fs.existsSync(conductorPath)).toBe(true);
  });

  it('T-060: course-conductor.md mentions all three rungs by name (hint, reference, auto)', () => {
    const content = fs.readFileSync(conductorPath, 'utf8').toLowerCase();
    expect(content).toContain('hint');
    expect(content).toContain('reference');
    expect(content).toContain('auto');
  });

  it('T-061: course-conductor.md does not declare Bash as an allowed tool', () => {
    const content = fs.readFileSync(conductorPath, 'utf8');
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const fm = fmMatch[1];
      const toolsMatch = fm.match(/tools:\s*(\[[^\]]*\]|\S.*)/);
      if (toolsMatch) {
        const toolsRaw = toolsMatch[1];
        if (/\[\s*\]/.test(toolsRaw)) {
          expect(true).toBe(true);
        } else {
          expect(/\bBash\b/i.test(toolsRaw)).toBe(false);
        }
      }
    }
  });

  it('T-062: course-conductor.md disclaims direct shell side effects for rung 3', () => {
    const content = fs.readFileSync(conductorPath, 'utf8');
    expect(content).toContain('requestHint');
    expect(/(shell|Bash|side channel)/i.test(content)).toBe(true);
  });
});
