import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Modules under test — none of these exist yet at red phase. Their imports
// failing causes vitest to fail the suite, which is the meaningful red signal.
import {
  loadPhases,
  getCurrentSpot,
  advanceCursor,
  LoadPhasesError,
} from '../mcp/server/src/phaseEngine.js';
import { validatePhases } from '../mcp/server/src/schemas/phases.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// SHA-256 of ~/workspace/deepbook-sandbox-evaluation-apps/01-orderbook-viewer/src/App.tsx
// Computed at test-list time on the author's machine. T-224 below uses this
// constant as the cross-machine ground truth so the test does not need to
// re-read the upstream file when present (it does, when present, to fail loud
// if a developer mutates that file locally).
const REFERENCE_APP_TSX_SHA256_AT_AUTHOR =
  'fa063add7bf7382ab65548118459b21f055d3319b7e3d774d32d2b1b77570ab2';

let tempRoots: string[] = [];

function makeTempRoot(prefix = 'sui-course-phase-engine-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function writeRaw(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function seedPath(projectRoot: string, slug: string, phasesValue: unknown): string {
  const slugDir = path.join(projectRoot, 'paths', slug);
  writeJson(path.join(slugDir, 'path.json'), {
    slug,
    title: slug,
    summary: 'fixture',
    personalization_options: ['poll_interval_ms', 'pool_subset'],
    build_command: 'pnpm build',
  });
  writeJson(path.join(slugDir, 'phases.json'), phasesValue);
  return slugDir;
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

const VALID_FULL_PHASES = {
  phases: [
    {
      id: 'p1-bootstrap',
      title: 'Phase 1',
      explainer_md: 'phases/p1-bootstrap.md',
      spots: [
        {
          id: 'p1-spot-1',
          target_file: 'src/App.tsx',
          target_range: '39-58',
          prompt: 'Implement packageIds, coinMap, poolMap. Wire {{ pool_subset }}.',
          rungs: {
            hint_md: 'rungs/p1-spot-1/hint.md',
            reference_md: 'rungs/p1-spot-1/reference.md',
            auto_write_md: 'rungs/p1-spot-1/auto.md',
          },
          doc_links: ['.sui-docs/x.mdx', '.ts-sdk-docs/y.mdx'],
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
};

// ---------------------------------------------------------------------------
// validatePhases — schema invariants (A2 / AC-4.1)
// ---------------------------------------------------------------------------

describe('validatePhases — cycle 4 schema invariants', () => {
  it('T-181: rejects phases.json with zero phases', () => {
    const result = validatePhases({ phases: [] });
    expect(result.ok).toBe(false);
    expect(/at least one phase|empty/i.test(((result as any).error ?? '').toString())).toBe(true);
  });

  it('T-182: rejects a phase whose spots array is empty (names the offending phase id)', () => {
    const result = validatePhases({ phases: [{ id: 'p1', spots: [] }] });
    expect(result.ok).toBe(false);
    const msg = ((result as any).error ?? '').toString();
    expect(msg).toContain('spots');
    expect(msg).toContain('p1');
  });

  it('T-183: requires each spot to declare target_file as a string', () => {
    const bad = {
      phases: [
        {
          id: 'p1',
          spots: [
            {
              id: 's1',
              // target_file missing
              target_range: '1-10',
              prompt: 'x',
              verification: { mode: 'compile', command: 'pnpm build' },
            },
          ],
        },
      ],
    };
    const result = validatePhases(bad);
    expect(result.ok).toBe(false);
    expect(/target_file/i.test(((result as any).error ?? '').toString())).toBe(true);
  });

  it('T-184: requires each spot to declare target_range as a string', () => {
    const bad = {
      phases: [
        {
          id: 'p1',
          spots: [
            {
              id: 's1',
              target_file: 'src/App.tsx',
              // target_range missing
              prompt: 'x',
              verification: { mode: 'compile', command: 'pnpm build' },
            },
          ],
        },
      ],
    };
    const result = validatePhases(bad);
    expect(result.ok).toBe(false);
    expect(/target_range/i.test(((result as any).error ?? '').toString())).toBe(true);
  });

  it('T-185: requires each spot to declare prompt as a string', () => {
    const bad = {
      phases: [
        {
          id: 'p1',
          spots: [
            {
              id: 's1',
              target_file: 'src/App.tsx',
              target_range: '1-10',
              // prompt missing
              verification: { mode: 'compile', command: 'pnpm build' },
            },
          ],
        },
      ],
    };
    const result = validatePhases(bad);
    expect(result.ok).toBe(false);
    expect(/prompt/i.test(((result as any).error ?? '').toString())).toBe(true);
  });

  it('T-186: requires verification.mode to be one of compile|test|simulate|custom', () => {
    const bad = {
      phases: [
        {
          id: 'p1',
          spots: [
            {
              id: 's1',
              target_file: 'src/App.tsx',
              target_range: '1-10',
              prompt: 'x',
              verification: { mode: 'unknown', command: 'x' },
            },
          ],
        },
      ],
    };
    const badResult = validatePhases(bad);
    expect(badResult.ok).toBe(false);
    expect(/verification|mode/i.test(((badResult as any).error ?? '').toString())).toBe(true);

    // compile mode passes when command is present
    const ok = validatePhases({
      phases: [
        {
          id: 'p1',
          spots: [
            {
              id: 's1',
              target_file: 'src/App.tsx',
              target_range: '1-10',
              prompt: 'x',
              verification: { mode: 'compile', command: 'pnpm build' },
            },
          ],
        },
      ],
    });
    expect(ok.ok).toBe(true);
  });

  it('T-187: requires verification.command for compile mode', () => {
    const bad = {
      phases: [
        {
          id: 'p1',
          spots: [
            {
              id: 's1',
              target_file: 'src/App.tsx',
              target_range: '1-10',
              prompt: 'x',
              verification: { mode: 'compile' },
            },
          ],
        },
      ],
    };
    const result = validatePhases(bad);
    expect(result.ok).toBe(false);
    expect(/command/i.test(((result as any).error ?? '').toString())).toBe(true);
  });

  it('T-188: requires endpoint+expected_status for simulate mode', () => {
    const bad = {
      phases: [
        {
          id: 'p1',
          spots: [
            {
              id: 's1',
              target_file: 'src/App.tsx',
              target_range: '1-10',
              prompt: 'x',
              verification: { mode: 'simulate' },
            },
          ],
        },
      ],
    };
    expect(validatePhases(bad).ok).toBe(false);

    const ok = validatePhases({
      phases: [
        {
          id: 'p1',
          spots: [
            {
              id: 's1',
              target_file: 'src/App.tsx',
              target_range: '1-10',
              prompt: 'x',
              verification: {
                mode: 'simulate',
                endpoint: 'http://localhost:9009/manifest',
                expected_status: 200,
              },
            },
          ],
        },
      ],
    });
    expect(ok.ok).toBe(true);
  });

  it('T-189: requires expected_stdout_regex for custom mode', () => {
    const bad = {
      phases: [
        {
          id: 'p1',
          spots: [
            {
              id: 's1',
              target_file: 'src/App.tsx',
              target_range: '1-10',
              prompt: 'x',
              verification: { mode: 'custom', command: 'echo x' },
            },
          ],
        },
      ],
    };
    const result = validatePhases(bad);
    expect(result.ok).toBe(false);
    expect(/expected_stdout_regex/i.test(((result as any).error ?? '').toString())).toBe(true);
  });

  it('T-190: when rungs are present requires hint_md, reference_md, auto_write_md as strings', () => {
    const partial = {
      phases: [
        {
          id: 'p1',
          spots: [
            {
              id: 's1',
              target_file: 'src/App.tsx',
              target_range: '1-10',
              prompt: 'x',
              rungs: { hint_md: 'a.md' },
              verification: { mode: 'compile', command: 'pnpm build' },
            },
          ],
        },
      ],
    };
    const result = validatePhases(partial);
    expect(result.ok).toBe(false);
    expect(/reference_md|auto_write_md/i.test(((result as any).error ?? '').toString())).toBe(true);

    const full = {
      phases: [
        {
          id: 'p1',
          spots: [
            {
              id: 's1',
              target_file: 'src/App.tsx',
              target_range: '1-10',
              prompt: 'x',
              rungs: {
                hint_md: 'a.md',
                reference_md: 'b.md',
                auto_write_md: 'c.md',
              },
              verification: { mode: 'compile', command: 'pnpm build' },
            },
          ],
        },
      ],
    };
    expect(validatePhases(full).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadPhases (A4)
// ---------------------------------------------------------------------------

describe('loadPhases', () => {
  it('T-191: reads and validates paths/<slug>/phases.json from projectRoot', async () => {
    const root = makeTempRoot();
    seedPath(root, '01-orderbook-viewer', VALID_FULL_PHASES);
    const phases = await loadPhases(root, '01-orderbook-viewer');
    expect((phases as any).phases).toBeTruthy();
    expect((phases as any).phases.length).toBe(3);
    expect((phases as any).phases[0].id).toBe('p1-bootstrap');
  });

  it('T-192: throws LoadPhasesError when phases.json is missing for the slug', async () => {
    const root = makeTempRoot();
    const slugDir = path.join(root, 'paths', '01-orderbook-viewer');
    writeJson(path.join(slugDir, 'path.json'), {
      slug: '01-orderbook-viewer',
      title: 'x',
      summary: 'y',
      personalization_options: [],
      build_command: 'pnpm build',
    });
    // Intentionally NO phases.json
    let caught: unknown;
    try {
      await loadPhases(root, '01-orderbook-viewer');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LoadPhasesError);
    const msg = (caught as Error).message ?? '';
    expect(msg).toContain('01-orderbook-viewer');
  });

  it('T-193: throws LoadPhasesError when phases.json is malformed JSON', async () => {
    const root = makeTempRoot();
    const slugDir = path.join(root, 'paths', '01-orderbook-viewer');
    writeJson(path.join(slugDir, 'path.json'), {
      slug: '01-orderbook-viewer',
      title: 'x',
      summary: 'y',
      personalization_options: [],
      build_command: 'pnpm build',
    });
    writeRaw(path.join(slugDir, 'phases.json'), '{ not json');
    let caught: unknown;
    try {
      await loadPhases(root, '01-orderbook-viewer');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LoadPhasesError);
    expect(/parse|JSON/i.test((caught as Error).message ?? '')).toBe(true);
  });

  it('T-194: throws LoadPhasesError when phases.json is JSON-valid but schema-invalid (zero spots)', async () => {
    const root = makeTempRoot();
    seedPath(root, '01-orderbook-viewer', { phases: [{ id: 'p1', spots: [] }] });
    let caught: unknown;
    try {
      await loadPhases(root, '01-orderbook-viewer');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LoadPhasesError);
    expect(/spots/i.test((caught as Error).message ?? '')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getCurrentSpot (A4)
// ---------------------------------------------------------------------------

describe('getCurrentSpot', () => {
  function makePhases() {
    return {
      phases: [
        {
          id: 'p1',
          spots: [
            { id: 's1', target_file: 'a.tsx', target_range: '1-10', prompt: '', verification: { mode: 'compile', command: 'pnpm build' } },
            { id: 's2', target_file: 'a.tsx', target_range: '11-20', prompt: '', verification: { mode: 'compile', command: 'pnpm build' } },
          ],
        },
        {
          id: 'p2',
          spots: [
            { id: 's3', target_file: 'b.tsx', target_range: '1-10', prompt: '', verification: { mode: 'compile', command: 'pnpm build' } },
          ],
        },
      ],
    };
  }

  function makeState(phaseId: string, spotId: string) {
    return {
      schema_version: 1,
      selected_path: '01-orderbook-viewer',
      personalization: { poll_interval_ms: 3000, pool_subset: 'both' },
      cursor: { phase_id: phaseId, spot_id: spotId },
      ladder: {},
      history: [],
    };
  }

  it('T-195: returns the resolved phase + spot for a state.cursor pointing inside the manifest', () => {
    const phases = makePhases();
    const state = makeState('p1', 's2');
    const result: any = getCurrentSpot(state as any, phases as any);
    expect(result.done).not.toBe(true);
    expect(result.phase.id).toBe('p1');
    expect(result.spot.id).toBe('s2');
  });

  it('T-196: returns { done: true } when state.cursor names a phase_id absent from the manifest', () => {
    const phases = { phases: [{ id: 'p1', spots: [{ id: 's1', target_file: 'a.tsx', target_range: '1-10', prompt: '', verification: { mode: 'compile', command: 'pnpm build' } }] }] };
    const state = makeState('p9', 'sX');
    const result: any = getCurrentSpot(state as any, phases as any);
    expect(result.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// advanceCursor (A4)
// ---------------------------------------------------------------------------

describe('advanceCursor', () => {
  function makePhases() {
    return {
      phases: [
        {
          id: 'p1',
          spots: [
            { id: 's1', target_file: 'a.tsx', target_range: '1-10', prompt: '', verification: { mode: 'compile', command: 'pnpm build' } },
            { id: 's2', target_file: 'a.tsx', target_range: '11-20', prompt: '', verification: { mode: 'compile', command: 'pnpm build' } },
          ],
        },
        {
          id: 'p2',
          spots: [
            { id: 's3', target_file: 'b.tsx', target_range: '1-10', prompt: '', verification: { mode: 'compile', command: 'pnpm build' } },
            { id: 's4', target_file: 'b.tsx', target_range: '11-20', prompt: '', verification: { mode: 'compile', command: 'pnpm build' } },
          ],
        },
      ],
    };
  }

  function makeState(phaseId: string, spotId: string) {
    return {
      schema_version: 1,
      selected_path: '01-orderbook-viewer',
      personalization: { poll_interval_ms: 3000, pool_subset: 'both' },
      cursor: { phase_id: phaseId, spot_id: spotId },
      ladder: {},
      history: [],
    };
  }

  it('T-197: moves to the next spot within the same phase', () => {
    const phases = makePhases();
    const state = makeState('p1', 's1');
    const advanced: any = advanceCursor(state as any, phases as any);
    expect(advanced.cursor.phase_id).toBe('p1');
    expect(advanced.cursor.spot_id).toBe('s2');
    // immutability
    expect(advanced.cursor).not.toBe(state.cursor);
  });

  it('T-198: crosses a phase boundary onto the first spot of the next phase', () => {
    const phases = {
      phases: [
        { id: 'p1', spots: [{ id: 's1', target_file: 'a.tsx', target_range: '1-10', prompt: '', verification: { mode: 'compile', command: 'pnpm build' } }] },
        {
          id: 'p2',
          spots: [
            { id: 's3', target_file: 'b.tsx', target_range: '1-10', prompt: '', verification: { mode: 'compile', command: 'pnpm build' } },
            { id: 's4', target_file: 'b.tsx', target_range: '11-20', prompt: '', verification: { mode: 'compile', command: 'pnpm build' } },
          ],
        },
      ],
    };
    const state = makeState('p1', 's1');
    const advanced: any = advanceCursor(state as any, phases as any);
    expect(advanced.cursor.phase_id).toBe('p2');
    expect(advanced.cursor.spot_id).toBe('s3');
  });

  it('T-199: on the last spot of the last phase moves the cursor into a done-marked state', () => {
    const phases = {
      phases: [
        { id: 'p1', spots: [{ id: 's1', target_file: 'a.tsx', target_range: '1-10', prompt: '', verification: { mode: 'compile', command: 'pnpm build' } }] },
        { id: 'p2', spots: [{ id: 's2', target_file: 'b.tsx', target_range: '1-10', prompt: '', verification: { mode: 'compile', command: 'pnpm build' } }] },
      ],
    };
    const state = makeState('p2', 's2');
    const advanced: any = advanceCursor(state as any, phases as any);
    const sub: any = getCurrentSpot(advanced as any, phases as any);
    expect(sub.done).toBe(true);
  });

  it('T-200: throws when called past the end (already done)', () => {
    const phases = {
      phases: [
        { id: 'p1', spots: [{ id: 's1', target_file: 'a.tsx', target_range: '1-10', prompt: '', verification: { mode: 'compile', command: 'pnpm build' } }] },
      ],
    };
    const state = makeState('p1', 's1');
    const once = advanceCursor(state as any, phases as any);
    // After one advance we're done. Another should throw.
    let threw = false;
    try {
      advanceCursor(once as any, phases as any);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reference snapshot fidelity — A9
// ---------------------------------------------------------------------------

describe('reference snapshot fidelity (A9)', () => {
  const REFERENCE_BUNDLED = path.join(
    REPO_ROOT,
    'paths',
    '01-orderbook-viewer',
    'reference',
    'App.tsx',
  );
  const REFERENCE_SOURCE = path.join(
    os.homedir(),
    'workspace',
    'deepbook-sandbox-evaluation-apps',
    '01-orderbook-viewer',
    'src',
    'App.tsx',
  );

  it.skipIf(!fs.existsSync(REFERENCE_SOURCE))(
    'T-224: reference/App.tsx is byte-for-byte equal to ~/workspace/deepbook-sandbox-evaluation-apps/01-orderbook-viewer/src/App.tsx (SHA-256)',
    () => {
      const sourceBuf = fs.readFileSync(REFERENCE_SOURCE);
      const sourceHash = crypto.createHash('sha256').update(sourceBuf).digest('hex');
      // Defense in depth: assert the source on this machine matches the
      // author's recorded hash. If it doesn't, the source was mutated locally.
      expect(sourceHash).toBe(REFERENCE_APP_TSX_SHA256_AT_AUTHOR);

      const bundledBuf = fs.readFileSync(REFERENCE_BUNDLED);
      const bundledHash = crypto.createHash('sha256').update(bundledBuf).digest('hex');
      expect(bundledHash).toBe(sourceHash);
      expect(bundledBuf.length).toBe(sourceBuf.length);
    },
  );

  it('T-225: reference/App.tsx exists and has size > 0 unconditionally', () => {
    expect(fs.existsSync(REFERENCE_BUNDLED)).toBe(true);
    const stat = fs.statSync(REFERENCE_BUNDLED);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// paths/01-orderbook-viewer/phases.json — content invariants
// ---------------------------------------------------------------------------

describe('paths/01-orderbook-viewer/phases.json content', () => {
  const PHASES_FILE = path.join(REPO_ROOT, 'paths', '01-orderbook-viewer', 'phases.json');

  function readPhases(): any {
    return JSON.parse(fs.readFileSync(PHASES_FILE, 'utf8'));
  }

  it('T-279: fully populates phase 1 with verification.mode=compile and command=pnpm build', () => {
    const obj = readPhases();
    expect(obj.phases[0].id).toBe('p1-bootstrap');
    expect(obj.phases[0].spots[0].id).toBe('p1-spot-1');
    expect(obj.phases[0].spots[0].target_file).toBe('src/App.tsx');
    expect(obj.phases[0].spots[0].target_range).toBe('39-58');
    expect(obj.phases[0].spots[0].verification).toEqual({ mode: 'compile', command: 'pnpm build' });
    expect(obj.phases[0].spots[0].rungs.hint_md).toBe('rungs/p1-spot-1/hint.md');
    expect(obj.phases[0].spots[0].rungs.reference_md).toBe('rungs/p1-spot-1/reference.md');
    expect(obj.phases[0].spots[0].rungs.auto_write_md).toBe('rungs/p1-spot-1/auto.md');
    expect(Array.isArray(obj.phases[0].spots[0].doc_links)).toBe(true);
    expect(obj.phases[0].spots[0].doc_links.length).toBeGreaterThan(0);
  });

  it('T-280: phase-1 prompt mentions {{ pool_subset }} (substitution exercised)', () => {
    const obj = readPhases();
    const prompt = obj.phases[0].spots[0].prompt as string;
    expect(/\{\{\s*pool_subset\s*\}\}/.test(prompt)).toBe(true);
  });

  it('T-281: phases 2 and 3 are real lessons (cycle 6 H001 fills p2-retry / p3-poll)', () => {
    // Cycle 6 H001 / AC-6.3: cycles 1-5 left phases 2 & 3 as TBD placeholders;
    // Phase F flagged that as the largest e2e failure. The remediation fills
    // them in with p2-retry (target 103-114, compile verification) and
    // p3-poll (target 116-145, simulate verification, with the
    // {{ poll_interval_ms }} substitution placeholder).
    const obj = readPhases();
    expect(obj.phases.length).toBe(3);
    expect(obj.phases[1].id).toBe('p2-retry');
    expect(obj.phases[2].id).toBe('p3-poll');
    expect(obj.phases[1].spots.length).toBe(1);
    expect(obj.phases[2].spots.length).toBe(1);
    expect(obj.phases[1].spots[0].target_range).toBe('103-114');
    expect(obj.phases[2].spots[0].target_range).toBe('116-145');
    expect(obj.phases[2].spots[0].prompt).toContain('{{ poll_interval_ms }}');
    expect(obj.phases[1].spots[0].verification.mode).toBe('compile');
    expect(obj.phases[2].spots[0].verification.mode).toBe('simulate');
    const result = validatePhases(obj);
    expect(result.ok).toBe(true);
  });
});

describe('paths/01-orderbook-viewer/phases/p1-bootstrap.md', () => {
  it('T-290: exists and has a non-trivial body', () => {
    const f = path.join(REPO_ROOT, 'paths', '01-orderbook-viewer', 'phases', 'p1-bootstrap.md');
    const stat = fs.statSync(f);
    expect(stat.size).toBeGreaterThan(0);
    const content = fs.readFileSync(f, 'utf8');
    expect(content.length).toBeGreaterThanOrEqual(200);
  });
});

describe('paths/01-orderbook-viewer/rungs/p1-spot-1/{hint,reference,auto}.md', () => {
  it('T-291: exist with non-empty bodies; reference includes load-bearing identifiers; hint exercises substitution', () => {
    const base = path.join(REPO_ROOT, 'paths', '01-orderbook-viewer', 'rungs', 'p1-spot-1');
    for (const f of ['hint.md', 'reference.md', 'auto.md']) {
      const full = path.join(base, f);
      const stat = fs.statSync(full);
      expect(stat.size, full).toBeGreaterThan(0);
    }
    const reference = fs.readFileSync(path.join(base, 'reference.md'), 'utf8');
    expect(/packageIds|coinMap|poolMap/.test(reference)).toBe(true);
    const hint = fs.readFileSync(path.join(base, 'hint.md'), 'utf8');
    expect(/\{\{\s*pool_subset\s*\}\}/.test(hint)).toBe(true);
  });
});
