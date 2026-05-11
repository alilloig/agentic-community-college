import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Spy-mode mocks for fs surfaces.
vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Mock state.ts BEFORE importing selectPath, so the tool consumes our stub
// loadState/saveState. Tests override per-call via mockResolvedValueOnce.
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

// Module under test.
import { selectPath } from '../mcp/server/src/tools/selectPath.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let tempRoots: string[] = [];

function makeTempRoot(prefix = 'sui-course-selectpath-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function seedOrderbookPath(root: string): void {
  const slugDir = path.join(root, 'paths', '01-orderbook-viewer');
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(
    path.join(slugDir, 'path.json'),
    JSON.stringify(
      {
        slug: '01-orderbook-viewer',
        title: 'Orderbook Viewer',
        summary: 'fixture',
        personalization_options: ['poll_interval_ms', 'pool_subset'],
        build_command: 'pnpm build',
        personalization_ranges: {
          poll_interval_ms: { min: 1000, max: 30000, default: 3000 },
          pool_subset: { values: ['both', 'DEEP_SUI', 'SUI_USDC'], default: 'both' },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  fs.writeFileSync(
    path.join(slugDir, 'phases.json'),
    JSON.stringify(
      {
        phases: [
          {
            id: 'p1-bootstrap',
            spots: [
              {
                id: 'p1-spot-1',
                target_file: 'src/App.tsx',
                target_range: '39-58',
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
      },
      null,
      2,
    ),
    'utf8',
  );
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
  stateMock.loadState.mockImplementation(async () => ({ kind: 'absent' }));
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

describe('selectPath — happy path', () => {
  it('T-226: valid slug returns ok with personalizationPrompts and initializes state', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    const result: any = await selectPath({ projectRoot: root, slug: '01-orderbook-viewer' });
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.personalizationPrompts)).toBe(true);
    expect(result.personalizationPrompts.length).toBe(2);
    expect(result.errors).toBeUndefined();

    expect(stateMock.saveState).toHaveBeenCalledTimes(1);
    const savedState = stateMock.saveState.mock.calls[0][1] as any;
    expect(savedState.selected_path).toBe('01-orderbook-viewer');
    expect(savedState.cursor).toEqual({ phase_id: 'p1-bootstrap', spot_id: 'p1-spot-1' });
    expect(savedState.ladder).toEqual({});
  });

  it('T-227: returns enumerable personalizationPrompts (integer + enum, no free text)', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    const result: any = await selectPath({ projectRoot: root, slug: '01-orderbook-viewer' });
    expect(result.ok).toBe(true);
    const prompts = result.personalizationPrompts as any[];
    expect(prompts.length).toBe(2);

    const byName: Record<string, any> = {};
    for (const p of prompts) byName[p.name] = p;

    expect(byName['poll_interval_ms']).toBeTruthy();
    expect(byName['poll_interval_ms'].type).toBe('integer');
    expect(byName['poll_interval_ms'].range).toEqual({ min: 1000, max: 30000, default: 3000 });

    expect(byName['pool_subset']).toBeTruthy();
    expect(byName['pool_subset'].type).toBe('enum');
    expect(byName['pool_subset'].enum).toEqual(['both', 'DEEP_SUI', 'SUI_USDC']);
    expect(byName['pool_subset'].default).toBe('both');

    for (const p of prompts) {
      expect(['integer', 'enum']).toContain(p.type);
    }
  });

  it('T-231: state persists via saveState round-trip (integration with state.ts loadState/saveState contract)', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    // Capture what selectPath wants to save, and have loadState return it.
    let saved: any = null;
    stateMock.saveState.mockImplementation(async (_r: string, s: unknown) => {
      saved = s;
    });
    stateMock.loadState.mockImplementation(async () => {
      if (saved) return { kind: 'ok', state: saved };
      return { kind: 'absent' };
    });

    await selectPath({ projectRoot: root, slug: '01-orderbook-viewer' });
    expect(saved).toBeTruthy();
    expect(saved.selected_path).toBe('01-orderbook-viewer');
    expect(saved.cursor.phase_id).toBe('p1-bootstrap');
    expect(saved.cursor.spot_id).toBe('p1-spot-1');
    expect(saved.ladder).toEqual({});
  });
});

describe('selectPath — input validation', () => {
  it('T-228: rejects an unknown slug with ok:false and no state mutation', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    const before = JSON.stringify(fs.readdirSync(root));
    const result: any = await selectPath({ projectRoot: root, slug: '99-fake' });
    expect(result.ok).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(stateMock.saveState).not.toHaveBeenCalled();
    const after = JSON.stringify(fs.readdirSync(root));
    expect(after).toBe(before);
  });

  it('T-230: input validation rejects missing slug with structured error (no throw)', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    let caught: unknown;
    let result: any;
    try {
      result = await selectPath({ projectRoot: root } as any);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeUndefined();
    expect(result.ok).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(/slug/i.test(result.errors.join('|'))).toBe(true);
    expect(stateMock.saveState).not.toHaveBeenCalled();
  });

  it('T-287: rejects non-string slug', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    let caught: unknown;
    let result: any;
    try {
      result = await selectPath({ projectRoot: root, slug: 42 as any });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeUndefined();
    expect(result.ok).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(/slug|string|type/i.test(result.errors.join('|'))).toBe(true);
    expect(stateMock.saveState).not.toHaveBeenCalled();
  });
});

describe('selectPath — no shell action (A11)', () => {
  it('T-229: response carries no shell action; source contains zero kind:"shell" literals', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);

    const okResult = await selectPath({ projectRoot: root, slug: '01-orderbook-viewer' });
    expect(deepFindShellKind(okResult)).toBe(false);

    const failResult = await selectPath({ projectRoot: root, slug: '99-fake' });
    expect(deepFindShellKind(failResult)).toBe(false);

    const sourcePath = path.join(REPO_ROOT, 'mcp', 'server', 'src', 'tools', 'selectPath.ts');
    const content = fs.readFileSync(sourcePath, 'utf8');
    expect(/kind\s*:\s*'shell'/.test(content)).toBe(false);
    expect(/kind\s*:\s*"shell"/.test(content)).toBe(false);
  });
});

describe('selectPath — short-circuits on state issues (A11)', () => {
  it('T-275: mints fresh state when loadState returns kind:corrupt+archivedTo (cycle 6 H003)', async () => {
    // Cycle 6 H003 / AC-7.2: previously this short-circuited with {ok:false}
    // on corrupt state, wedging the user. Remediation treats a corrupt slot
    // whose archive succeeded as `absent` and mints a fresh State via saveState.
    const root = makeTempRoot();
    seedOrderbookPath(root);
    stateMock.loadState.mockImplementationOnce(async () => ({
      kind: 'corrupt',
      archivedTo: '/x',
      message: 'corrupt',
    }));
    const result: any = await selectPath({ projectRoot: root, slug: '01-orderbook-viewer' });
    expect(result.ok).toBe(true);
    expect(stateMock.saveState).toHaveBeenCalled();
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

describe('selectPath — saveState rejection wrap (A12)', () => {
  it('T-067: saveState rejection surfaces { ok:false, errors:[/state-save-failed:/] }', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    stateMock.loadState.mockImplementation(async () => ({ kind: 'absent' }));
    stateMock.saveState.mockImplementation(async () => {
      const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      throw err;
    });
    let caught: unknown;
    let result: any;
    try {
      result = await selectPath({ projectRoot: root, slug: '01-orderbook-viewer' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeUndefined();
    expect(result.ok).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.some((e: string) => /state-save-failed/i.test(e))).toBe(true);
    expect(result.errors.some((e: string) => /EACCES/.test(e))).toBe(true);
  });
});

describe('selectPath — outputStyleOk gate (A13)', () => {
  it('T-068: outputStyleOk=false returns { ok:false, errors:["output-style-disabled"] } with zero state mutation', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    cycle5OutputStyleMock.probeOutputStyle.mockImplementationOnce(async () => ({ ok: false }));
    const result: any = await selectPath({ projectRoot: root, slug: '01-orderbook-viewer' });
    expect(result.ok).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors).toContain('output-style-disabled');
    expect(stateMock.saveState).not.toHaveBeenCalled();
  });

  it('T-069: outputStyleOk gate runs before loadState', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    cycle5OutputStyleMock.probeOutputStyle.mockImplementationOnce(async () => ({ ok: false }));
    await selectPath({ projectRoot: root, slug: '01-orderbook-viewer' });
    expect(stateMock.loadState).not.toHaveBeenCalled();
  });
});
