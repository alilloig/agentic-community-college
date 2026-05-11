import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const verifyMock = vi.hoisted(() => {
  return {
    runVerification: vi.fn<
      (spec: any, projectRoot: string, opts?: any) => Promise<any>
    >(async () => ({ pass: true, output: 'built' })),
    VerificationModeUnsupportedError: class extends Error {
      mode: string;
      constructor(mode: string) {
        super('Mode not supported: ' + mode);
        this.mode = mode;
      }
    },
  };
});
vi.mock('../mcp/server/src/verify.js', () => ({
  runVerification: verifyMock.runVerification,
  VerificationModeUnsupportedError: verifyMock.VerificationModeUnsupportedError,
}));

import { verifySpot } from '../mcp/server/src/tools/verifySpot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let tempRoots: string[] = [];

function makeTempRoot(prefix = 'sui-course-verifyspot-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function seedOrderbookPath(root: string): void {
  const slugDir = path.join(root, 'paths', '01-orderbook-viewer');
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(
    path.join(slugDir, 'path.json'),
    JSON.stringify({
      slug: '01-orderbook-viewer',
      title: 'Orderbook Viewer',
      summary: 'fixture',
      personalization_options: ['poll_interval_ms', 'pool_subset'],
      build_command: 'pnpm build',
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
              target_range: '39-58',
              prompt: 'x',
              verification: { mode: 'compile', command: 'pnpm build' },
            },
          ],
        },
        {
          id: 'p2',
          spots: [
            {
              id: 'p2-spot-1',
              target_file: 'src/App.tsx',
              target_range: '103-114',
              prompt: 'TBD in cycle 5+',
              verification: { mode: 'compile', command: 'pnpm build' },
            },
          ],
        },
      ],
    }),
    'utf8',
  );
}

function makeState(opts: {
  cursor?: { phase_id: string; spot_id: string };
} = {}): any {
  return {
    schema_version: 1,
    selected_path: '01-orderbook-viewer',
    personalization: { poll_interval_ms: 3000, pool_subset: 'both' },
    cursor: opts.cursor ?? { phase_id: 'p1-bootstrap', spot_id: 'p1-spot-1' },
    ladder: {},
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
  verifyMock.runVerification.mockReset();
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

describe('verifySpot — pass/fail (A4)', () => {
  it('T-248: pass case advances cursor and returns { pass: true, advanced: true }', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    let saved: any = null;
    stateMock.loadState.mockImplementation(async () => ({ kind: 'ok', state: makeState() }));
    stateMock.saveState.mockImplementation(async (_r, s) => {
      saved = s;
    });
    verifyMock.runVerification.mockImplementation(async () => ({ pass: true, output: 'built' }));

    const result: any = await verifySpot({ projectRoot: root });
    expect(result.pass).toBe(true);
    expect(result.advanced).toBe(true);
    expect(typeof result.output === 'string' || result.output === undefined).toBe(true);
    expect(saved).toBeTruthy();
    // After advance from p1-spot-1 we should be on p2-spot-1.
    expect(saved.cursor.phase_id).toBe('p2');
    expect(saved.cursor.spot_id).toBe('p2-spot-1');
  });

  it('T-249: fail case leaves cursor untouched and returns { pass: false, advanced: false }', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    let saved: any = null;
    stateMock.loadState.mockImplementation(async () => ({ kind: 'ok', state: makeState() }));
    stateMock.saveState.mockImplementation(async (_r, s) => {
      saved = s;
    });
    verifyMock.runVerification.mockImplementation(async () => ({ pass: false, output: 'TS2304' }));

    const result: any = await verifySpot({ projectRoot: root });
    expect(result.pass).toBe(false);
    expect(result.advanced).toBe(false);
    expect(String(result.output ?? '')).toContain('TS2304');
    // Saved (if at all) should NOT have advanced the cursor.
    if (saved) {
      expect(saved.cursor).toEqual({ phase_id: 'p1-bootstrap', spot_id: 'p1-spot-1' });
    }
  });
});

describe('verifySpot — dispatch (A8)', () => {
  it("T-250: dispatches the spot's verification block to runVerification (compile case)", async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    stateMock.loadState.mockImplementation(async () => ({ kind: 'ok', state: makeState() }));
    verifyMock.runVerification.mockImplementation(async () => ({ pass: true, output: 'built' }));

    await verifySpot({ projectRoot: root });
    expect(verifyMock.runVerification).toHaveBeenCalledTimes(1);
    const [spec, projectRootArg] = verifyMock.runVerification.mock.calls[0] as any[];
    expect(spec).toEqual({ mode: 'compile', command: 'pnpm build' });
    expect(projectRootArg).toBe(root);
  });
});

describe('verifySpot — no shell action (A11)', () => {
  it('T-251: emits no shell action; source contains zero kind:"shell" literals', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    stateMock.loadState.mockImplementation(async () => ({ kind: 'ok', state: makeState() }));
    verifyMock.runVerification.mockImplementation(async () => ({ pass: true, output: 'built' }));
    const passResult = await verifySpot({ projectRoot: root });
    expect(deepFindShellKind(passResult)).toBe(false);

    verifyMock.runVerification.mockImplementation(async () => ({ pass: false, output: 'X' }));
    const failResult = await verifySpot({ projectRoot: root });
    expect(deepFindShellKind(failResult)).toBe(false);

    const sourcePath = path.join(REPO_ROOT, 'mcp', 'server', 'src', 'tools', 'verifySpot.ts');
    const content = fs.readFileSync(sourcePath, 'utf8');
    expect(/kind\s*:\s*'shell'/.test(content)).toBe(false);
    expect(/kind\s*:\s*"shell"/.test(content)).toBe(false);
  });
});

describe('verifySpot — error and end-of-path paths (A4)', () => {
  it('T-252: when state.selected_path is unset returns a structured error', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    stateMock.loadState.mockImplementation(async () => ({ kind: 'absent' }));
    let caught: unknown;
    let result: any;
    try {
      result = await verifySpot({ projectRoot: root });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeUndefined();
    expect(result.pass).toBe(false);
    const haystack = JSON.stringify(result);
    expect(/no path|selected|state|error/i.test(haystack)).toBe(true);
  });

  it('T-253: pass advancing past the last spot leaves state in done position (next nextSpot returns done)', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    let saved: any = null;
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeState({ cursor: { phase_id: 'p2', spot_id: 'p2-spot-1' } }),
    }));
    stateMock.saveState.mockImplementation(async (_r, s) => {
      saved = s;
    });
    verifyMock.runVerification.mockImplementation(async () => ({ pass: true, output: 'built' }));

    const result: any = await verifySpot({ projectRoot: root });
    expect(result.pass).toBe(true);
    expect(saved).toBeTruthy();
    // Saved cursor should be at done position — phase id outside the manifest's
    // active set, so getCurrentSpot would return done:true.
    // We cannot assert the exact done sentinel format (implementer's choice),
    // but we assert the saved cursor is NOT { phase_id: 'p2', spot_id: 'p2-spot-1' }.
    expect(saved.cursor).not.toEqual({ phase_id: 'p2', spot_id: 'p2-spot-1' });
  });
});

// ---------------------------------------------------------------------------
// Cycle-5 carry-forwards: M001 (verification mode unsupported), M002
// (saveState rejection), L002 (outputStyleOk gate)
// ---------------------------------------------------------------------------

// Mock outputStyle so we can flip the gate without writing a fake settings.json.
const cycle5OutputStyleMock = vi.hoisted(() => {
  return {
    probeOutputStyle: vi.fn<() => Promise<unknown>>(async () => ({ ok: true })),
  };
});
vi.mock('../mcp/server/src/outputStyle.js', () => ({
  probeOutputStyle: cycle5OutputStyleMock.probeOutputStyle,
}));

describe('verifySpot — VerificationModeUnsupportedError catch (A11)', () => {
  it('T-063: wraps VerificationModeUnsupportedError as { pass:false, error: /not yet supported/ }', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    // Override seed: rewrite phases.json so the spot's verification.mode is 'test'.
    fs.writeFileSync(
      path.join(root, 'paths', '01-orderbook-viewer', 'phases.json'),
      JSON.stringify({
        phases: [
          {
            id: 'p1-bootstrap',
            spots: [
              {
                id: 'p1-spot-1',
                target_file: 'src/App.tsx',
                target_range: '39-58',
                prompt: 'x',
                verification: { mode: 'test', command: 'pnpm test' },
              },
            ],
          },
          {
            id: 'p2',
            spots: [
              {
                id: 'p2-spot-1',
                target_file: 'src/App.tsx',
                target_range: '103-114',
                prompt: 'tbd',
                verification: { mode: 'compile', command: 'pnpm build' },
              },
            ],
          },
        ],
      }),
      'utf8',
    );
    stateMock.loadState.mockImplementation(async () => ({ kind: 'ok', state: makeState() }));
    verifyMock.runVerification.mockImplementation(async () => {
      throw new verifyMock.VerificationModeUnsupportedError('test');
    });

    let caught: unknown;
    let result: any;
    try {
      result = await verifySpot({ projectRoot: root });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeUndefined();
    expect(result.pass).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(/not yet supported/i.test(result.error)).toBe(true);
    expect(/test/i.test(result.error)).toBe(true);
    expect(result.advanced).toBe(false);
    expect(stateMock.saveState).not.toHaveBeenCalled();
  });
});

describe('verifySpot — saveState rejection on pass branch (A12)', () => {
  it('T-064: returns { pass:true, advanced:false, error:/state persist failed/ } and cursor not advanced', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    stateMock.loadState.mockImplementation(async () => ({ kind: 'ok', state: makeState() }));
    stateMock.saveState.mockImplementation(async () => {
      const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      throw err;
    });
    verifyMock.runVerification.mockImplementation(async () => ({ pass: true, output: 'built' }));
    let caught: unknown;
    let result: any;
    try {
      result = await verifySpot({ projectRoot: root });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeUndefined();
    expect(result.pass).toBe(true);
    expect(result.advanced).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(/verification passed but state persist failed/i.test(result.error)).toBe(true);
    expect(/EACCES/.test(result.error)).toBe(true);
  });
});

describe('verifySpot — outputStyleOk gate (A13)', () => {
  it('T-065: outputStyleOk=false short-circuits with { pass:false, error:"output-style-disabled" }', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    cycle5OutputStyleMock.probeOutputStyle.mockImplementationOnce(async () => ({ ok: false }));
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    const result: any = await verifySpot({ projectRoot: root });
    expect(result.pass).toBe(false);
    expect(result.error).toBe('output-style-disabled');
    expect(result.advanced).toBe(false);
    // No state writes
    for (const c of writeSpy.mock.calls) {
      expect(String(c[0]).includes('.sui-deepbook-course')).toBe(false);
    }
  });

  it('T-066: outputStyleOk gate runs BEFORE loadState and runVerification', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    cycle5OutputStyleMock.probeOutputStyle.mockImplementationOnce(async () => ({ ok: false }));
    await verifySpot({ projectRoot: root });
    expect(stateMock.loadState).not.toHaveBeenCalled();
    expect(verifyMock.runVerification).not.toHaveBeenCalled();
  });
});
