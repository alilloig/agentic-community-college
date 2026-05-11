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

import { setPersonalization } from '../mcp/server/src/tools/setPersonalization.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let tempRoots: string[] = [];

function makeTempRoot(prefix = 'sui-course-setpersonalization-'): string {
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
        {
          id: 'p3',
          spots: [
            {
              id: 'p3-spot-1',
              target_file: 'src/App.tsx',
              target_range: '116-145',
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

function makeBaseState(personalization: any = { poll_interval_ms: 3000, pool_subset: 'both' }): any {
  return {
    schema_version: 1,
    selected_path: '01-orderbook-viewer',
    personalization,
    cursor: { phase_id: 'p1-bootstrap', spot_id: 'p1-spot-1' },
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

describe('setPersonalization — happy path (A5/A6)', () => {
  it('T-232: valid values persist into state.personalization', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    let saved: any = null;
    stateMock.loadState.mockImplementation(async () => ({ kind: 'ok', state: makeBaseState() }));
    stateMock.saveState.mockImplementation(async (_r, s) => {
      saved = s;
    });

    const result: any = await setPersonalization({
      projectRoot: root,
      values: { poll_interval_ms: 5000, pool_subset: 'DEEP_SUI' },
    });
    expect(result.ok).toBe(true);
    expect(saved).toBeTruthy();
    expect(saved.personalization.poll_interval_ms).toBe(5000);
    expect(saved.personalization.pool_subset).toBe('DEEP_SUI');
  });

  it('T-233: empty values uses path\'s declared defaults (Use defaults)', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    let saved: any = null;
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeBaseState({}),
    }));
    stateMock.saveState.mockImplementation(async (_r, s) => {
      saved = s;
    });

    const result: any = await setPersonalization({ projectRoot: root, values: {} });
    expect(result.ok).toBe(true);
    expect(saved.personalization.poll_interval_ms).toBe(3000);
    expect(saved.personalization.pool_subset).toBe('both');
  });

  it('T-237: preserves keys not under attack (partial update)', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    let saved: any = null;
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeBaseState({ poll_interval_ms: 5000, pool_subset: 'SUI_USDC' }),
    }));
    stateMock.saveState.mockImplementation(async (_r, s) => {
      saved = s;
    });

    const result: any = await setPersonalization({
      projectRoot: root,
      values: { poll_interval_ms: 7000 },
    });
    expect(result.ok).toBe(true);
    expect(saved.personalization.poll_interval_ms).toBe(7000);
    expect(saved.personalization.pool_subset).toBe('SUI_USDC');
  });
});

describe('setPersonalization — input validation (A5)', () => {
  it('T-234: rejects out-of-range poll_interval_ms with ok:false errors and writes nothing', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeBaseState(),
    }));

    const result: any = await setPersonalization({
      projectRoot: root,
      values: { poll_interval_ms: 100 },
    });
    expect(result.ok).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(/poll_interval_ms/i.test(result.errors.join('|'))).toBe(true);
    expect(stateMock.saveState).not.toHaveBeenCalled();
  });

  it('T-235: rejects unknown keys', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeBaseState(),
    }));

    const result: any = await setPersonalization({
      projectRoot: root,
      values: { render_style: 'pretty' },
    });
    expect(result.ok).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(/render_style|unknown/i.test(result.errors.join('|'))).toBe(true);
    expect(stateMock.saveState).not.toHaveBeenCalled();
  });

  it('T-236: refuses when state.selected_path is unset', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    stateMock.loadState.mockImplementation(async () => ({ kind: 'absent' }));

    const result: any = await setPersonalization({ projectRoot: root, values: {} });
    expect(result.ok).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(/selected_path|selectPath/i.test(result.errors.join('|'))).toBe(true);
    expect(stateMock.saveState).not.toHaveBeenCalled();
  });

  it('T-288: rejects values with wrong types and aggregates errors', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeBaseState(),
    }));

    const result: any = await setPersonalization({
      projectRoot: root,
      values: { poll_interval_ms: 'fast', pool_subset: 'WHATEVER' },
    });
    expect(result.ok).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    for (const e of result.errors) expect(typeof e).toBe('string');
    expect(stateMock.saveState).not.toHaveBeenCalled();
  });
});

describe('setPersonalization — no shell action (A11)', () => {
  it('T-238: response and source carry no shell action', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeBaseState(),
    }));
    const okResult = await setPersonalization({
      projectRoot: root,
      values: { poll_interval_ms: 5000 },
    });
    expect(deepFindShellKind(okResult)).toBe(false);

    const failResult = await setPersonalization({
      projectRoot: root,
      values: { poll_interval_ms: 100 },
    });
    expect(deepFindShellKind(failResult)).toBe(false);

    const sourcePath = path.join(REPO_ROOT, 'mcp', 'server', 'src', 'tools', 'setPersonalization.ts');
    const content = fs.readFileSync(sourcePath, 'utf8');
    expect(/kind\s*:\s*'shell'/.test(content)).toBe(false);
    expect(/kind\s*:\s*"shell"/.test(content)).toBe(false);
  });
});

describe('setPersonalization — state recovery short-circuit (A11)', () => {
  it('T-276: short-circuits when loadState returns kind:schema-mismatch', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    stateMock.loadState.mockImplementationOnce(async () => ({
      kind: 'schema-mismatch',
      foundVersion: 999,
      message: 'incompatible',
    }));
    const result: any = await setPersonalization({ projectRoot: root, values: {} });
    expect(result.ok).toBe(false);
    expect(stateMock.saveState).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cycle-5 carry-forwards: M002 (saveState rejection), L002 (outputStyleOk gate)
// ---------------------------------------------------------------------------

const cycle5OutputStyleMock = vi.hoisted(() => {
  return {
    probeOutputStyle: vi.fn<() => Promise<unknown>>(async () => ({ ok: true })),
  };
});
vi.mock('../mcp/server/src/outputStyle.js', () => ({
  probeOutputStyle: cycle5OutputStyleMock.probeOutputStyle,
}));

describe('setPersonalization — saveState rejection wrap (A12)', () => {
  it('T-070: saveState rejection surfaces { ok:false, errors:[/state-save-failed:/] }', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeBaseState(),
    }));
    stateMock.saveState.mockImplementation(async () => {
      const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      throw err;
    });
    let caught: unknown;
    let result: any;
    try {
      result = await setPersonalization({
        projectRoot: root,
        values: { poll_interval_ms: 5000 },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeUndefined();
    expect(result.ok).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.some((e: string) => /state-save-failed/i.test(e))).toBe(true);
  });
});

describe('setPersonalization — outputStyleOk gate (A13)', () => {
  it('T-071: outputStyleOk=false returns { ok:false, errors:["output-style-disabled"] } with zero state mutation', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    cycle5OutputStyleMock.probeOutputStyle.mockImplementationOnce(async () => ({ ok: false }));
    const result: any = await setPersonalization({ projectRoot: root, values: {} });
    expect(result.ok).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors).toContain('output-style-disabled');
    expect(stateMock.saveState).not.toHaveBeenCalled();
  });
});
