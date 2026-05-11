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

import { nextSpot } from '../mcp/server/src/tools/nextSpot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let tempRoots: string[] = [];

function makeTempRoot(prefix = 'sui-course-nextspot-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

interface SeedOptions {
  spotOverride?: any;
}

function seedOrderbookPath(root: string, opts: SeedOptions = {}): void {
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

  const defaultSpot = {
    id: 'p1-spot-1',
    target_file: 'src/App.tsx',
    target_range: '39-58',
    prompt:
      'Implement packageIds, coinMap, poolMap. Wire {{ pool_subset }} only.',
    rungs: {
      hint_md: 'rungs/p1-spot-1/hint.md',
      reference_md: 'rungs/p1-spot-1/reference.md',
      auto_write_md: 'rungs/p1-spot-1/auto.md',
    },
    doc_links: [
      '.sui-docs/develop/transactions/ptbs/inputs-and-results.mdx',
      '.ts-sdk-docs/sui/clients/grpc.mdx',
    ],
    verification: { mode: 'compile', command: 'pnpm build' },
  };

  fs.writeFileSync(
    path.join(slugDir, 'phases.json'),
    JSON.stringify({
      phases: [
        {
          id: 'p1-bootstrap',
          spots: [opts.spotOverride ?? defaultSpot],
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

function makeState(opts: {
  cursor?: { phase_id: string; spot_id: string };
  personalization?: any;
  ladder?: any;
} = {}): any {
  return {
    schema_version: 1,
    selected_path: '01-orderbook-viewer',
    personalization: opts.personalization ?? { poll_interval_ms: 3000, pool_subset: 'both' },
    cursor: opts.cursor ?? { phase_id: 'p1-bootstrap', spot_id: 'p1-spot-1' },
    ladder: opts.ladder ?? {},
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

describe('nextSpot — manifest fidelity (A3)', () => {
  it('T-239: returns the active spot view with byte-for-byte target_file/target_range from the manifest', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    stateMock.loadState.mockImplementation(async () => ({ kind: 'ok', state: makeState() }));
    const response: any = await nextSpot({ projectRoot: root });
    expect(response.spot).toBeTruthy();
    expect(response.spot.target_file).toBe('src/App.tsx');
    expect(response.spot.target_range).toBe('39-58');
    expect(response.phase.id).toBe('p1-bootstrap');
  });

  it('T-244: returns ladder state for the current spot (or default-rung when state.ladder[spot.id] is absent)', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeState({
        ladder: {
          'p1-spot-1': { hint_used: true, reference_shown: false, auto_completed: false },
        },
      }),
    }));
    const a: any = await nextSpot({ projectRoot: root });
    expect(a.ladder.hint_used).toBe(true);

    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeState({ ladder: {} }),
    }));
    const b: any = await nextSpot({ projectRoot: root });
    expect(b.ladder).toEqual(
      expect.objectContaining({ hint_used: false, reference_shown: false, auto_completed: false }),
    );
  });
});

describe('nextSpot — substitution scope (A7)', () => {
  it('T-240: substitutes {{ pool_subset }} into spot.prompt with the personalization value', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeState({ personalization: { poll_interval_ms: 3000, pool_subset: 'DEEP_SUI' } }),
    }));
    const response: any = await nextSpot({ projectRoot: root });
    expect(response.spot.prompt).toContain('DEEP_SUI');
    expect(response.spot.prompt.indexOf('{{ pool_subset }}')).toBe(-1);
    expect(response.spot.prompt.indexOf('{{pool_subset}}')).toBe(-1);
  });

  it('T-241: leaves target_file/target_range unsubstituted even when those fields contain literal {{ ... }} sequences (adversarial)', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root, {
      spotOverride: {
        id: 'p1-spot-1',
        target_file: '{{ poll_interval_ms }}/App.tsx',
        target_range: '{{ poll_interval_ms }}-58',
        prompt: 'plain',
        verification: { mode: 'compile', command: 'pnpm build' },
      },
    });
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeState({ personalization: { poll_interval_ms: 5000, pool_subset: 'both' } }),
    }));
    const response: any = await nextSpot({ projectRoot: root });
    // Byte-for-byte with the manifest. NO substitution.
    expect(response.spot.target_file).toBe('{{ poll_interval_ms }}/App.tsx');
    expect(response.spot.target_range).toBe('{{ poll_interval_ms }}-58');
  });

  it('T-242: leaves verification.command unsubstituted even when it contains a {{ ... }} sequence (adversarial)', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root, {
      spotOverride: {
        id: 'p1-spot-1',
        target_file: 'src/App.tsx',
        target_range: '39-58',
        prompt: 'plain',
        verification: { mode: 'compile', command: 'pnpm build {{ poll_interval_ms }}' },
      },
    });
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeState({ personalization: { poll_interval_ms: 5000, pool_subset: 'both' } }),
    }));
    const response: any = await nextSpot({ projectRoot: root });
    expect(response.spot.verification.command).toBe('pnpm build {{ poll_interval_ms }}');
  });
});

describe('nextSpot — doc_links and shape (A10)', () => {
  it('T-243: returns doc_links as path-only entries (cycle-4 baseline) verbatim from the manifest', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    stateMock.loadState.mockImplementation(async () => ({ kind: 'ok', state: makeState() }));
    const response: any = await nextSpot({ projectRoot: root });
    expect(Array.isArray(response.spot.doc_links)).toBe(true);
    expect(response.spot.doc_links.length).toBe(2);
    const paths = response.spot.doc_links.map((e: any) => e.path);
    expect(paths).toContain('.sui-docs/develop/transactions/ptbs/inputs-and-results.mdx');
    expect(paths).toContain('.ts-sdk-docs/sui/clients/grpc.mdx');
  });
});

describe('nextSpot — done and error paths (A4 / A11)', () => {
  it('T-245: returns { done: true, spot: undefined } at end-of-path', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    // Cursor walked off the last spot — use a phase_id that doesn't exist
    // (per getCurrentSpot's done semantics).
    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeState({ cursor: { phase_id: 'p9-done', spot_id: 'sX' } }),
    }));
    const response: any = await nextSpot({ projectRoot: root });
    expect(response.done).toBe(true);
    expect(response.spot === undefined || response.spot === null).toBe(true);
    expect(deepFindShellKind(response)).toBe(false);
  });

  it('T-246: response carries no action field', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    stateMock.loadState.mockImplementation(async () => ({ kind: 'ok', state: makeState() }));
    const active: any = await nextSpot({ projectRoot: root });
    expect((active as any).action).toBeUndefined();
    expect(deepFindShellKind(active)).toBe(false);

    stateMock.loadState.mockImplementation(async () => ({
      kind: 'ok',
      state: makeState({ cursor: { phase_id: 'p9-done', spot_id: 'sX' } }),
    }));
    const done: any = await nextSpot({ projectRoot: root });
    expect((done as any).action).toBeUndefined();
    expect(deepFindShellKind(done)).toBe(false);
  });

  it('T-247: when state.selected_path is unset returns a structured error (no throw)', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    stateMock.loadState.mockImplementation(async () => ({ kind: 'absent' }));
    let caught: unknown;
    let response: any;
    try {
      response = await nextSpot({ projectRoot: root });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeUndefined();
    // Either { error: ... } or { ok: false, errors: ... } — both are acceptable
    // structured shapes. The test asserts that *some* error surface exists.
    const haystack = JSON.stringify(response);
    expect(/no path|selected|error|errors|ok\s*"\s*:\s*false/i.test(haystack)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cycle-5 carry-forward: L002 (outputStyleOk gate)
// ---------------------------------------------------------------------------

const cycle5OutputStyleMock = vi.hoisted(() => {
  return {
    probeOutputStyle: vi.fn<() => Promise<unknown>>(async () => ({ ok: true })),
  };
});
vi.mock('../mcp/server/src/outputStyle.js', () => ({
  probeOutputStyle: cycle5OutputStyleMock.probeOutputStyle,
}));

describe('nextSpot — outputStyleOk gate (A13)', () => {
  it('T-072: outputStyleOk=false returns done:false with error:"output-style-disabled" and zero writes', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    cycle5OutputStyleMock.probeOutputStyle.mockImplementationOnce(async () => ({ ok: false }));
    const result: any = await nextSpot({ projectRoot: root });
    expect(result.done).toBe(false);
    expect(result.error).toBe('output-style-disabled');
    // The non-gated return shape (phase/spot/ladder) is preserved on the happy path,
    // but the gated branch does not require those fields.
    expect(stateMock.saveState).not.toHaveBeenCalled();
  });

  it('T-073: outputStyleOk gate runs before loadState', async () => {
    const root = makeTempRoot();
    seedOrderbookPath(root);
    cycle5OutputStyleMock.probeOutputStyle.mockImplementationOnce(async () => ({ ok: false }));
    await nextSpot({ projectRoot: root });
    expect(stateMock.loadState).not.toHaveBeenCalled();
  });
});
