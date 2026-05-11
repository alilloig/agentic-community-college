import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Spy-mode mocks so vi.spyOn works on ESM namespace bindings.
vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Module under test — does not exist at red phase.
import {
  recordRungUse,
  canAdvanceRung,
  runAutoWrite,
  AutoWriteError,
} from '../mcp/server/src/ladder.js';
import type { State, LadderRung } from '../mcp/server/src/schemas/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let tempRoots: string[] = [];

function makeTempRoot(prefix = 'sui-course-ladder-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function makeState(opts: {
  ladder?: Record<string, Partial<LadderRung>>;
  cursor?: { phase_id: string; spot_id: string };
  personalization?: Record<string, unknown>;
} = {}): State {
  const fullLadder: Record<string, LadderRung> = {};
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
    selected_path: '01-orderbook-viewer',
    personalization: opts.personalization ?? { pool_subset: 'both', poll_interval_ms: 3000 },
    cursor: opts.cursor ?? { phase_id: 'p1-bootstrap', spot_id: 'p1-spot-1' },
    ladder: fullLadder,
    history: [],
  };
}

function makeSpot(opts: {
  id?: string;
  target_file?: string;
  target_range?: string;
} = {}): { id: string; target_file: string; target_range: string } {
  return {
    id: opts.id ?? 'p1-spot-1',
    target_file: opts.target_file ?? 'src/App.tsx',
    target_range: opts.target_range ?? '10-15',
  };
}

function buildLines(prefix: string, count: number): string {
  const out: string[] = [];
  for (let i = 1; i <= count; i++) {
    out.push(`${prefix}${i}`);
  }
  return out.join('\n');
}

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
// recordRungUse — A4 (append-only ladder mutations)
// ---------------------------------------------------------------------------

describe('recordRungUse — flag flips and append-only invariants (A4)', () => {
  it('T-042: rung 1 flips hint_used and preserves other flags', () => {
    const state = makeState({
      ladder: {
        'p1-spot-1': {
          hint_used: false,
          reference_shown: true,
          auto_completed: false,
          auto_write_attempted: false,
        },
      },
    });
    const next = recordRungUse(state, 'p1-spot-1', 1);
    const r = next.ladder['p1-spot-1'];
    expect(r.hint_used).toBe(true);
    expect(r.reference_shown).toBe(true);
    expect(r.auto_completed).toBe(false);
    expect(r.auto_write_attempted).toBe(false);
    // New object reference, not in-place mutation
    expect(next).not.toBe(state);
    expect(state.ladder['p1-spot-1'].hint_used).toBe(false);
  });

  it('T-043: rung 2 flips reference_shown and preserves other flags', () => {
    const state = makeState({
      ladder: {
        'p1-spot-1': {
          hint_used: true,
          reference_shown: false,
          auto_completed: false,
          auto_write_attempted: false,
        },
      },
    });
    const next = recordRungUse(state, 'p1-spot-1', 2);
    const r = next.ladder['p1-spot-1'];
    expect(r.reference_shown).toBe(true);
    expect(r.hint_used).toBe(true);
    expect(r.auto_completed).toBe(false);
  });

  it('T-044: rung 3 flips BOTH auto_completed AND auto_write_attempted', () => {
    const state = makeState({
      ladder: {
        'p1-spot-1': {
          hint_used: true,
          reference_shown: true,
          auto_completed: false,
          auto_write_attempted: false,
        },
      },
    });
    const next = recordRungUse(state, 'p1-spot-1', 3);
    const r = next.ladder['p1-spot-1'];
    expect(r.auto_completed).toBe(true);
    expect(r.auto_write_attempted).toBe(true);
    expect(r.hint_used).toBe(true);
    expect(r.reference_shown).toBe(true);
  });

  it('T-045: never clears a flag — input all-true → output all-true for every rung', () => {
    const state = makeState({
      ladder: {
        'p1-spot-1': {
          hint_used: true,
          reference_shown: true,
          auto_completed: true,
          auto_write_attempted: true,
        },
      },
    });
    for (const rung of [1, 2, 3] as const) {
      const next = recordRungUse(state, 'p1-spot-1', rung);
      const r = next.ladder['p1-spot-1'];
      expect(r.hint_used, `rung=${rung}`).toBe(true);
      expect(r.reference_shown, `rung=${rung}`).toBe(true);
      expect(r.auto_completed, `rung=${rung}`).toBe(true);
      expect(r.auto_write_attempted, `rung=${rung}`).toBe(true);
    }
  });

  it('T-046: creates a default-all-false rung when spot has no ladder entry yet', () => {
    const state = makeState({ ladder: {} });
    const r1 = recordRungUse(state, 'p1-spot-1', 1).ladder['p1-spot-1'];
    expect(r1).toEqual({
      hint_used: true,
      reference_shown: false,
      auto_completed: false,
      auto_write_attempted: false,
    });

    const r2 = recordRungUse(state, 'p1-spot-1', 2).ladder['p1-spot-1'];
    expect(r2.reference_shown).toBe(true);
    expect(r2.hint_used).toBe(false);
    expect(r2.auto_completed).toBe(false);

    const r3 = recordRungUse(state, 'p1-spot-1', 3).ladder['p1-spot-1'];
    expect(r3.auto_completed).toBe(true);
    expect(r3.auto_write_attempted).toBe(true);
    expect(r3.hint_used).toBe(false);
    expect(r3.reference_shown).toBe(false);
  });

  it('T-047: does not mutate the input state object', () => {
    const state = makeState({
      ladder: {
        'p1-spot-1': {
          hint_used: false,
          reference_shown: false,
          auto_completed: false,
          auto_write_attempted: false,
        },
      },
    });
    const snapshot = JSON.parse(JSON.stringify(state));
    const next = recordRungUse(state, 'p1-spot-1', 3);
    // Input deep-equal to its snapshot (unchanged)
    expect(state).toEqual(snapshot);
    // Returned state has separate ladder object
    expect(next.ladder).not.toBe(state.ladder);
    expect(next.ladder['p1-spot-1']).not.toBe(state.ladder['p1-spot-1']);
  });
});

// ---------------------------------------------------------------------------
// canAdvanceRung — A3 (rung gating)
// ---------------------------------------------------------------------------

describe('canAdvanceRung — rung gating decisions (A3)', () => {
  it('T-048: rung 1 always returns ok:true regardless of ladder state', () => {
    for (const hint_used of [true, false]) {
      for (const reference_shown of [true, false]) {
        for (const auto_completed of [true, false]) {
          const state = makeState({
            ladder: {
              'p1-spot-1': {
                hint_used,
                reference_shown,
                auto_completed,
                auto_write_attempted: auto_completed,
              },
            },
          });
          const r = canAdvanceRung(state, 'p1-spot-1', 1);
          expect(r.ok, `hint=${hint_used} ref=${reference_shown} auto=${auto_completed}`).toBe(
            true,
          );
        }
      }
    }
    // Also: rung 1 callable when ladder entry is absent
    const empty = makeState({ ladder: {} });
    expect(canAdvanceRung(empty, 'p1-spot-1', 1).ok).toBe(true);
  });

  it('T-049: rung 2 returns ok:true iff hint_used === true', () => {
    const withHint = makeState({
      ladder: {
        'p1-spot-1': {
          hint_used: true,
          reference_shown: false,
          auto_completed: false,
          auto_write_attempted: false,
        },
      },
    });
    expect(canAdvanceRung(withHint, 'p1-spot-1', 2).ok).toBe(true);

    const withoutHint = makeState({
      ladder: {
        'p1-spot-1': {
          hint_used: false,
          reference_shown: true,
          auto_completed: false,
          auto_write_attempted: false,
        },
      },
    });
    const denied = canAdvanceRung(withoutHint, 'p1-spot-1', 2);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.missingFlag).toBe('hint_used');
      expect(denied.requiredPriorRung).toBe(1);
    }

    // No ladder entry → also denied
    const empty = makeState({ ladder: {} });
    const noEntry = canAdvanceRung(empty, 'p1-spot-1', 2);
    expect(noEntry.ok).toBe(false);
    if (!noEntry.ok) {
      expect(noEntry.missingFlag).toBe('hint_used');
    }
  });

  it('T-050: rung 3 returns ok:true iff reference_shown === true', () => {
    const withRef = makeState({
      ladder: {
        'p1-spot-1': {
          hint_used: true,
          reference_shown: true,
          auto_completed: false,
          auto_write_attempted: false,
        },
      },
    });
    expect(canAdvanceRung(withRef, 'p1-spot-1', 3).ok).toBe(true);

    const withoutRef = makeState({
      ladder: {
        'p1-spot-1': {
          hint_used: true,
          reference_shown: false,
          auto_completed: false,
          auto_write_attempted: false,
        },
      },
    });
    const denied = canAdvanceRung(withoutRef, 'p1-spot-1', 3);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.missingFlag).toBe('reference_shown');
      expect(denied.requiredPriorRung).toBe(2);
    }

    // No ladder entry → denied
    const empty = makeState({ ladder: {} });
    const noEntry = canAdvanceRung(empty, 'p1-spot-1', 3);
    expect(noEntry.ok).toBe(false);
    if (!noEntry.ok) {
      expect(noEntry.missingFlag).toBe('reference_shown');
    }
  });
});

// ---------------------------------------------------------------------------
// runAutoWrite — A7 (snapshot-then-overwrite)
// ---------------------------------------------------------------------------

describe('runAutoWrite — snapshot + overwrite (A7)', () => {
  it('T-051: happy path snapshots existing range, overwrites target_file with payload, returns backupPath and bytesWritten', async () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const targetPath = path.join(root, 'src', 'App.tsx');
    fs.writeFileSync(targetPath, buildLines('LINE', 100), 'utf8');
    const spot = makeSpot({ target_range: '10-15' });
    const payload = 'NEW1\nNEW2\nNEW3\nNEW4\nNEW5\nNEW6';

    const result = await runAutoWrite(root, spot, payload);

    // Snapshot exists at the canonical path
    const expectedBak = path.join(root, '.sui-deepbook-course', 'snapshots', 'p1-spot-1.bak');
    expect(result.backupPath).toBe(expectedBak);
    expect(fs.existsSync(expectedBak)).toBe(true);
    const bakContent = fs.readFileSync(expectedBak, 'utf8');
    // Snapshot contents should be the original lines 10..15
    expect(bakContent).toBe('LINE10\nLINE11\nLINE12\nLINE13\nLINE14\nLINE15');

    // Target file was rewritten with the payload at lines 10-15
    const newTarget = fs.readFileSync(targetPath, 'utf8').split('\n');
    expect(newTarget[8]).toBe('LINE9');     // line 9 unchanged
    expect(newTarget[9]).toBe('NEW1');      // line 10 → NEW1
    expect(newTarget[14]).toBe('NEW6');     // line 15 → NEW6
    expect(newTarget[15]).toBe('LINE16');   // line 16 unchanged
    expect(newTarget[99]).toBe('LINE100');  // line 100 unchanged

    expect(typeof result.bytesWritten).toBe('number');
    expect(result.bytesWritten).toBeGreaterThan(0);
  });

  it('T-052: second call rotates existing .bak to .bak.<ISO-timestamp-no-colons>', async () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const targetPath = path.join(root, 'src', 'App.tsx');
    fs.writeFileSync(targetPath, buildLines('LINE', 100), 'utf8');
    const spot = makeSpot({ target_range: '10-15' });

    // First call — creates initial .bak
    await runAutoWrite(root, spot, 'NEWA1\nNEWA2\nNEWA3\nNEWA4\nNEWA5\nNEWA6');

    // Mutate the target before the second call so the second snapshot has different bytes.
    const lines = fs.readFileSync(targetPath, 'utf8').split('\n');
    // Re-write lines 10-15 with markers we can recognise as the "second pre-state"
    for (let i = 9; i <= 14; i++) lines[i] = `MID${i + 1}`;
    fs.writeFileSync(targetPath, lines.join('\n'), 'utf8');

    // Second call — must rotate the existing .bak before writing the new one.
    await runAutoWrite(root, spot, 'NEWB1\nNEWB2\nNEWB3\nNEWB4\nNEWB5\nNEWB6');

    const bakPath = path.join(root, '.sui-deepbook-course', 'snapshots', 'p1-spot-1.bak');
    expect(fs.existsSync(bakPath)).toBe(true);
    const newBak = fs.readFileSync(bakPath, 'utf8');
    // The current .bak should reflect the SECOND pre-state (the MID-prefixed bytes).
    expect(newBak).toContain('MID10');
    expect(newBak).not.toContain('LINE10');

    // The rotated archive matching `.bak.<timestamp>` must exist with the prior pre-state.
    const snapshotsDir = path.join(root, '.sui-deepbook-course', 'snapshots');
    const entries = fs.readdirSync(snapshotsDir);
    const rotated = entries.filter((n) => /^p1-spot-1\.bak\..+/.test(n));
    expect(rotated.length).toBe(1);
    expect(/^p1-spot-1\.bak\.\d{4}-\d{2}-\d{2}T\d{2}\d{2}\d{2}/.test(rotated[0])).toBe(true);
    const rotatedContent = fs.readFileSync(path.join(snapshotsDir, rotated[0]), 'utf8');
    expect(rotatedContent).toContain('LINE10');
    expect(rotatedContent).not.toContain('MID10');
  });

  it('T-053: rejects with AutoWriteError kind:"target-file-missing" on ENOENT', async () => {
    const root = makeTempRoot();
    const spot = makeSpot({ target_file: 'src/Missing.tsx', target_range: '1-5' });
    let caught: unknown;
    try {
      await runAutoWrite(root, spot, 'X');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AutoWriteError);
    expect((caught as { kind?: string }).kind).toBe('target-file-missing');
    // Snapshots dir must NOT have been created
    expect(fs.existsSync(path.join(root, '.sui-deepbook-course', 'snapshots'))).toBe(false);
  });

  it('T-054: rejects with AutoWriteError kind:"target-range-invalid" on malformed/inverted/out-of-bounds ranges', async () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const targetPath = path.join(root, 'src', 'App.tsx');
    fs.writeFileSync(targetPath, buildLines('LINE', 50), 'utf8');

    const cases = [
      { target_range: 'abc-xyz' },
      { target_range: '10-5' },        // inverted
      { target_range: '0-5' },         // below 1
      { target_range: '49999-99999' }, // beyond file length
    ];
    for (const c of cases) {
      const spot = makeSpot(c);
      let caught: unknown;
      try {
        await runAutoWrite(root, spot, 'X');
      } catch (err) {
        caught = err;
      }
      expect(caught, `range=${c.target_range}`).toBeInstanceOf(AutoWriteError);
      expect((caught as { kind?: string }).kind, `range=${c.target_range}`).toBe(
        'target-range-invalid',
      );
    }
    // Target file must remain unchanged.
    expect(fs.readFileSync(targetPath, 'utf8')).toBe(buildLines('LINE', 50));
  });

  it('T-055: rejects with AutoWriteError kind:"snapshot-write-failed" when .bak write fails (target_file untouched)', async () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const targetPath = path.join(root, 'src', 'App.tsx');
    fs.writeFileSync(targetPath, buildLines('LINE', 30), 'utf8');
    const before = fs.readFileSync(targetPath, 'utf8');
    const spot = makeSpot({ target_range: '5-10' });

    // Stub writeFile to reject only when writing to the .bak path.
    const writeSpy = vi.spyOn(fsPromises, 'writeFile');
    writeSpy.mockImplementation(async (p: any, _bytes: any, _opts?: any) => {
      const s = String(p);
      if (s.includes('.sui-deepbook-course') && s.includes('.bak')) {
        const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
        throw err;
      }
      // Don't fall through to the real implementation — we want target_file untouched.
      // In practice the snapshot path is hit FIRST so this branch is never reached
      // if step ordering is correct. We make it explicit anyway.
      const err = Object.assign(
        new Error('snapshot ordering violated: target_file write attempted before snapshot succeeded'),
        { code: 'TEST_ASSERT' },
      );
      throw err;
    });

    let caught: unknown;
    try {
      await runAutoWrite(root, spot, 'X1\nX2\nX3\nX4\nX5\nX6');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AutoWriteError);
    expect((caught as { kind?: string }).kind).toBe('snapshot-write-failed');

    // target_file must NOT have been modified (snapshot-first ordering).
    expect(fs.readFileSync(targetPath, 'utf8')).toBe(before);
  });

  it('T-056: rejects with AutoWriteError kind:"overwrite-failed" when target_file write fails after successful snapshot', async () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const targetPath = path.join(root, 'src', 'App.tsx');
    fs.writeFileSync(targetPath, buildLines('LINE', 30), 'utf8');
    const spot = makeSpot({ target_range: '5-10' });

    // Spy that conditionally fails: allow .bak writes through (forward to
    // sync writeFileSync, which isn't intercepted by the fsPromises spy),
    // but reject target_file writes. Earlier mockImplementation pattern
    // captured `realWriteFile` AFTER spyOn was already installed and
    // recursed infinitely.
    const writeSpy = vi.spyOn(fsPromises, 'writeFile');
    writeSpy.mockImplementation(async (p: any, bytes: any, opts?: any) => {
      const s = String(p);
      if (s.includes('.sui-deepbook-course') && s.includes('.bak')) {
        // Forward via the underlying sync API (not intercepted).
        const writeOpts: fs.WriteFileOptions =
          typeof opts === 'string' ? opts : (opts ?? {});
        fs.writeFileSync(p, bytes, writeOpts);
        return;
      }
      // Reject the target_file write.
      const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      throw err;
    });

    let caught: unknown;
    try {
      await runAutoWrite(root, spot, 'X1\nX2\nX3\nX4\nX5\nX6');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AutoWriteError);
    expect((caught as { kind?: string }).kind).toBe('overwrite-failed');

    // The snapshot file IS present on disk (durability invariant).
    const bakPath = path.join(root, '.sui-deepbook-course', 'snapshots', 'p1-spot-1.bak');
    expect(fs.existsSync(bakPath)).toBe(true);
  });

  it('T-057: writeFile call ordering — .bak first, target_file second', async () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const targetPath = path.join(root, 'src', 'App.tsx');
    fs.writeFileSync(targetPath, buildLines('LINE', 50), 'utf8');
    const spot = makeSpot({ target_range: '20-25' });

    const writeOrder: string[] = [];
    const writeSpy = vi.spyOn(fsPromises, 'writeFile');
    writeSpy.mockImplementation(async (...args: any[]) => {
      writeOrder.push(String(args[0]));
      // Forward to a dummy success — actually write so the test environment is consistent.
      // Note: vi.spyOn with .mockImplementation REPLACES the implementation, so
      // we have to manually write to disk if we want subsequent reads to see it.
      // For ordering assertions, however, the call order is what matters — we
      // skip actual disk writes here.
      return undefined;
    });

    await runAutoWrite(root, spot, 'A1\nA2\nA3\nA4\nA5\nA6');

    expect(writeOrder.length).toBeGreaterThanOrEqual(2);
    // First write: snapshot path (matches /\.bak$/ or /\.bak\..+$/)
    expect(/\.bak(\..+)?$/.test(writeOrder[0])).toBe(true);
    expect(writeOrder[0]).toContain('.sui-deepbook-course');
    // Second write: target_file path
    expect(writeOrder[1]).toBe(targetPath);
  });

  it('T-058: 1-indexed inclusive range — 39-58 covers exactly 20 lines', async () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const targetPath = path.join(root, 'src', 'App.tsx');
    fs.writeFileSync(targetPath, buildLines('LINE', 100), 'utf8');
    const spot = makeSpot({ target_range: '39-58' });
    const payloadLines = buildLines('PAY', 20).split('\n');
    await runAutoWrite(root, spot, payloadLines.join('\n'));

    const bakPath = path.join(root, '.sui-deepbook-course', 'snapshots', 'p1-spot-1.bak');
    const bakLines = fs.readFileSync(bakPath, 'utf8').split('\n');
    expect(bakLines.length).toBe(20);
    expect(bakLines[0]).toBe('LINE39');
    expect(bakLines[19]).toBe('LINE58');

    const newTarget = fs.readFileSync(targetPath, 'utf8').split('\n');
    expect(newTarget[37]).toBe('LINE38');  // line 38 (0-indexed 37) preserved
    expect(newTarget[38]).toBe('PAY1');    // line 39 → PAY1
    expect(newTarget[57]).toBe('PAY20');   // line 58 → PAY20
    expect(newTarget[58]).toBe('LINE59');  // line 59 preserved
  });

  it('T-019: snapshot file is written with wx flag and mode 0o600 (durability)', async () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const targetPath = path.join(root, 'src', 'App.tsx');
    fs.writeFileSync(targetPath, buildLines('LINE', 30), 'utf8');
    const spot = makeSpot({ target_range: '5-8' });

    // Spy-mode mock at top of file (vi.mock('node:fs/promises', { spy: true }))
    // gives us a passthrough by default — vi.spyOn without mockImplementation
    // observes calls and forwards to the real fn. The earlier mockImplementation
    // pattern in this test caused infinite recursion (realWriteFile captured
    // AFTER spyOn was already the spy itself).
    const writeSpy = vi.spyOn(fsPromises, 'writeFile');

    await runAutoWrite(root, spot, 'A\nB\nC\nD');

    // Find the call that wrote to the .bak path.
    let bakCallOpts: any = undefined;
    for (const call of writeSpy.mock.calls) {
      const p = String(call[0]);
      if (p.includes('.sui-deepbook-course') && /\.bak$/.test(p)) {
        bakCallOpts = call[2];
        break;
      }
    }
    expect(bakCallOpts).toBeTruthy();
    // Accept either `{ flag, mode }` or a plain string flag form. We require
    // mode 0o600 specifically on the snapshot, mirroring state.ts.
    if (typeof bakCallOpts === 'string') {
      expect(bakCallOpts).toContain('wx');
    } else {
      expect(bakCallOpts.flag).toMatch(/wx/);
      expect(bakCallOpts.mode).toBe(0o600);
    }
  });

  it('T-020: snapshot directory is created via fsPromises.mkdir({ recursive: true }) on first use', async () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const targetPath = path.join(root, 'src', 'App.tsx');
    fs.writeFileSync(targetPath, buildLines('LINE', 30), 'utf8');
    const spot = makeSpot({ target_range: '5-8' });

    const mkdirSpy = vi.spyOn(fsPromises, 'mkdir');

    expect(fs.existsSync(path.join(root, '.sui-deepbook-course', 'snapshots'))).toBe(false);

    await runAutoWrite(root, spot, 'A\nB\nC\nD');

    // mkdir was called for the snapshots dir with recursive:true
    let sawSnapshotsMkdir = false;
    for (const call of mkdirSpy.mock.calls) {
      const p = String(call[0]);
      if (p.endsWith(path.join('.sui-deepbook-course', 'snapshots'))) {
        const opts = call[1] as any;
        if (opts && opts.recursive === true) sawSnapshotsMkdir = true;
      }
    }
    expect(sawSnapshotsMkdir).toBe(true);
    expect(fs.existsSync(path.join(root, '.sui-deepbook-course', 'snapshots'))).toBe(true);
  });

  it('T-021: snapshot path is exactly <projectRoot>/.sui-deepbook-course/snapshots/<spot.id>.bak — no substitution', async () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const targetPath = path.join(root, 'src', 'App.tsx');
    fs.writeFileSync(targetPath, buildLines('LINE', 30), 'utf8');
    const spot = makeSpot({ id: 'p1-spot-1', target_range: '5-8' });
    const result = await runAutoWrite(root, spot, 'A\nB\nC\nD');
    const expected = path.join(root, '.sui-deepbook-course', 'snapshots', 'p1-spot-1.bak');
    expect(result.backupPath).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
    // Sanity: dashes preserved verbatim, no template-like substitution
    expect(result.backupPath).toContain('p1-spot-1');
    expect(/\{\{/.test(result.backupPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Source-level invariants for ladder.ts
// ---------------------------------------------------------------------------

describe('ladder.ts source invariants (A6, A7, A9, A10)', () => {
  function readLadder(): string {
    return fs.readFileSync(path.join(REPO_ROOT, 'mcp', 'server', 'src', 'ladder.ts'), 'utf8');
  }

  it('T-036: ladder.ts contains zero kind:"shell" literals', () => {
    const content = readLadder();
    expect(/kind\s*:\s*'shell'/.test(content)).toBe(false);
    expect(/kind\s*:\s*"shell"/.test(content)).toBe(false);
  });

  it('T-038: ladder.ts contains zero {{ … }} substitution markers in source code', () => {
    const content = readLadder();
    // Re-implements personalization syntax would be /\{\{\s*[a-zA-Z_]/. Match
    // count must be 0 in engine source.
    expect(/\{\{\s*[a-zA-Z_]/.test(content)).toBe(false);
  });

  it('T-040: ladder.ts contains zero "auto_completed = false" assignments', () => {
    const content = readLadder();
    expect(/auto_completed\s*=\s*false/.test(content)).toBe(false);
  });

  it('T-041: ladder.ts contains exactly two writeFile call sites', () => {
    const content = readLadder();
    const matches = content.match(/\bwriteFile\s*\(/g) ?? [];
    expect(matches.length).toBe(2);
  });
});
