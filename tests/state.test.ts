import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Spy-mode mocks: ESM namespace bindings are non-writable, so vi.spyOn() on
// `node:fs` / `node:fs/promises` fails with "Cannot redefine property". The
// `{ spy: true }` mode wraps the real module so spies work while behavior
// passes through unchanged.
vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Modules under test — none of these exist yet at red phase. Their imports
// failing causes vitest to fail the suite, which is the meaningful red signal.
import {
  loadState,
  saveState,
  STATE_SCHEMA_VERSION,
} from '../mcp/server/src/state.js';
import { validateState } from '../mcp/server/src/schemas/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'state');

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

let tempRoots: string[] = [];

function makeTempProjectRoot(prefix = 'sui-course-state-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

function seedStateFile(projectRoot: string, content: string): string {
  const stateDir = path.join(projectRoot, '.sui-deepbook-course');
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'state.json');
  fs.writeFileSync(stateFile, content, 'utf8');
  return stateFile;
}

function seedStateFromFixture(projectRoot: string, fixtureName: string): string {
  return seedStateFile(projectRoot, readFixture(fixtureName));
}

interface FileSnapshot {
  relPath: string;
  size: number;
  mtimeMs: number;
  content: string;
}

function snapshot(root: string): FileSnapshot[] {
  const out: FileSnapshot[] = [];
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
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(full);
      out.push({
        relPath: path.relative(root, full),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        content: fs.readFileSync(full, 'utf8'),
      });
    }
  }
  walk(root);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
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

beforeEach(() => {
  // Reset any leftover spies from a previous test.
  vi.restoreAllMocks();
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
// loadState — absent paths
// ---------------------------------------------------------------------------

describe('loadState — absent paths', () => {
  it('T-044: returns kind=absent when .sui-deepbook-course/ does not exist', async () => {
    const root = makeTempProjectRoot();
    const result = await loadState(root);

    expect(result).toBeTruthy();
    expect(result.kind).toBe('absent');
    expect((result as any).archivedTo).toBeUndefined();
    expect((result as any).foundVersion).toBeUndefined();
    expect((result as any).state).toBeUndefined();
  });

  it('T-045: creates zero filesystem entries on absent dir (no mkdir, no writes)', async () => {
    const root = makeTempProjectRoot();

    // Spy on every write surface — sync, callback, and promise-based.
    const mkdirSpy = vi.spyOn(fs, 'mkdir');
    const mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync');
    const writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync');
    const writeFileSpy = vi.spyOn(fs, 'writeFile');
    const renameSpy = vi.spyOn(fs, 'rename');
    const renameSyncSpy = vi.spyOn(fs, 'renameSync');
    const openSyncSpy = vi.spyOn(fs, 'openSync');

    const promisesMkdirSpy = vi.spyOn(fsPromises, 'mkdir');
    const promisesWriteFileSpy = vi.spyOn(fsPromises, 'writeFile');
    const promisesRenameSpy = vi.spyOn(fsPromises, 'rename');

    const before = snapshot(root);
    await loadState(root);
    const after = snapshot(root);

    expect(after).toEqual(before);

    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(mkdirSyncSpy).not.toHaveBeenCalled();
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(renameSpy).not.toHaveBeenCalled();
    expect(renameSyncSpy).not.toHaveBeenCalled();
    expect(promisesMkdirSpy).not.toHaveBeenCalled();
    expect(promisesWriteFileSpy).not.toHaveBeenCalled();
    expect(promisesRenameSpy).not.toHaveBeenCalled();

    // openSync is allowed for read-only opens, but if it was called for write
    // flags we must catch that. Filter calls to those with a write flag.
    for (const call of openSyncSpy.mock.calls) {
      const flags = call[1];
      if (typeof flags === 'string') {
        expect(flags).not.toMatch(/[wa+]/);
      } else if (typeof flags === 'number') {
        // O_WRONLY=1, O_RDWR=2, O_CREAT=64, O_TRUNC=512
        // In practice we just want to ensure not write-flagged.
        expect(flags & 0x3).toBe(0);
      }
    }
  });

  it('T-046: returns kind=absent when .sui-deepbook-course/ exists but state.json does not', async () => {
    const root = makeTempProjectRoot();
    fs.mkdirSync(path.join(root, '.sui-deepbook-course'), { recursive: true });

    const result = await loadState(root);

    expect(result.kind).toBe('absent');

    // No archive file should appear under this absent path.
    expect(listArchives(root)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadState — happy path
// ---------------------------------------------------------------------------

describe('loadState — kind=ok', () => {
  it('T-047: returns kind=ok with deep-equal state for a valid schema-1 state.json', async () => {
    const root = makeTempProjectRoot();
    const fixture = readFixture('valid-cursor-p2.json');
    seedStateFile(root, fixture);
    const expected = JSON.parse(fixture);

    const result = await loadState(root);

    expect(result.kind).toBe('ok');
    expect((result as any).state).toEqual(expected);
    expect((result as any).state.cursor.phase_id).toBe('p2-retry');
    expect((result as any).state.cursor.spot_id).toBe('p2-spot-1');
    expect((result as any).state.ladder['p1-spot-1'].hint_used).toBe(true);
    expect((result as any).state.personalization).toEqual({
      poll_interval_ms: 3000,
      pool_subset: 'both',
    });
  });
});

// ---------------------------------------------------------------------------
// loadState — corruption
// ---------------------------------------------------------------------------

describe('loadState — corruption (kind=corrupt)', () => {
  it('T-048: archives original bytes byte-for-byte and returns kind=corrupt', async () => {
    const root = makeTempProjectRoot();
    const corruptBytes = readFixture('corrupt.json');
    seedStateFile(root, corruptBytes);

    const result = await loadState(root);

    expect(result.kind).toBe('corrupt');
    const archivedTo = (result as any).archivedTo;
    expect(typeof archivedTo).toBe('string');
    expect(path.isAbsolute(archivedTo)).toBe(true);
    expect(fs.existsSync(archivedTo)).toBe(true);

    // Byte-for-byte equality between archive and original.
    const archivedBytes = fs.readFileSync(archivedTo, 'utf8');
    expect(archivedBytes).toBe(corruptBytes);

    expect(typeof (result as any).message).toBe('string');
    expect((result as any).message.length).toBeGreaterThan(0);
  });

  it('T-049: leaves canonical state.json untouched after corruption archive', async () => {
    const root = makeTempProjectRoot();
    const corruptBytes = readFixture('corrupt.json');
    const stateFile = seedStateFile(root, corruptBytes);

    await loadState(root);

    expect(fs.existsSync(stateFile)).toBe(true);
    const after = fs.readFileSync(stateFile, 'utf8');
    expect(after).toBe(corruptBytes);
  });

  it('T-050: two DISTINCT-content corruptions in the same wall-clock second produce two distinct archive paths', async () => {
    // Cycle 6 H003 / AC-7.2: archive emission is now content-hash-deduped.
    // IDENTICAL bytes collapse to a single archive (asserted by T-310);
    // DISTINCT bytes still produce distinct archives (the original A18
    // intent, preserved here).
    const root = makeTempProjectRoot();
    const corruptBytes1 = '{ not-valid-json-corruption-A: 1';
    const corruptBytes2 = '} broken-different-corruption-B [';
    seedStateFile(root, corruptBytes1);

    const r1 = await loadState(root);
    seedStateFile(root, corruptBytes2);
    const r2 = await loadState(root);

    expect(r1.kind).toBe('corrupt');
    expect(r2.kind).toBe('corrupt');

    const a1 = (r1 as any).archivedTo;
    const a2 = (r2 as any).archivedTo;

    expect(typeof a1).toBe('string');
    expect(typeof a2).toBe('string');
    expect(a1).not.toBe(a2);

    expect(fs.existsSync(a1)).toBe(true);
    expect(fs.existsSync(a2)).toBe(true);

    // The directory must show at least two archive files now.
    const archives = listArchives(root);
    expect(archives.length).toBeGreaterThanOrEqual(2);
  });

  it('T-051: archive filename embeds the content-hash suffix (cycle 6 + Phase F round-2 simplification)', async () => {
    // Cycle 1 originally embedded an ISO-8601 timestamp suffix to disambiguate
    // same-millisecond archives. Cycle 6 H003 added content-hash dedup as a
    // separate concern. Phase F round-2 collapsed both: the filename now
    // embeds a 16-char SHA-256 prefix of the corrupt content, which acts as
    // BOTH the disambiguator (different content → different filename) AND
    // the dedup key (identical content → identical filename → wx-flag EEXIST).
    // This drops O(N) directory-scan + read+rehash to O(1) name-based dedup.
    const root = makeTempProjectRoot();
    seedStateFromFixture(root, 'corrupt.json');

    const result = await loadState(root);
    const archivedTo = (result as any).archivedTo as string;
    const basename = path.basename(archivedTo);

    // 16 hex chars = 64 bits of SHA-256 content fingerprint.
    expect(basename).toMatch(/^state\.corrupt-[0-9a-f]{16}\.json$/);
  });

  it('T-056: corruption message matches /corrupt|archived/i', async () => {
    const root = makeTempProjectRoot();
    seedStateFromFixture(root, 'corrupt.json');

    const result = await loadState(root);
    expect(result.kind).toBe('corrupt');

    const message = (result as any).message as string;
    expect(typeof message).toBe('string');
    expect(message).toMatch(/corrupt|archived/i);
  });
});

// ---------------------------------------------------------------------------
// loadState — schema mismatch
// ---------------------------------------------------------------------------

describe('loadState — schema mismatch (kind=schema-mismatch)', () => {
  it('T-052: returns kind=schema-mismatch with foundVersion=999 and no archivedTo', async () => {
    const root = makeTempProjectRoot();
    seedStateFromFixture(root, 'future-schema.json');

    const result = await loadState(root);

    expect(result.kind).toBe('schema-mismatch');
    expect((result as any).foundVersion).toBe(999);
    expect((result as any).archivedTo).toBeUndefined();
    expect(typeof (result as any).message).toBe('string');
    expect((result as any).message.length).toBeGreaterThan(0);
  });

  it('T-053: schema-mismatch writes no archive and leaves canonical state.json untouched', async () => {
    const root = makeTempProjectRoot();
    const futureBytes = readFixture('future-schema.json');
    const stateFile = seedStateFile(root, futureBytes);

    await loadState(root);

    expect(listArchives(root)).toEqual([]);
    expect(fs.existsSync(stateFile)).toBe(true);
    expect(fs.readFileSync(stateFile, 'utf8')).toBe(futureBytes);
  });

  it('T-054: corrupt vs schema-mismatch results are structurally distinct', async () => {
    const corruptRoot = makeTempProjectRoot();
    const schemaRoot = makeTempProjectRoot();
    seedStateFromFixture(corruptRoot, 'corrupt.json');
    seedStateFromFixture(schemaRoot, 'future-schema.json');

    const corrupt = await loadState(corruptRoot);
    const schema = await loadState(schemaRoot);

    expect(corrupt.kind).toBe('corrupt');
    expect(schema.kind).toBe('schema-mismatch');
    expect(corrupt.kind).not.toBe(schema.kind);

    expect((corrupt as any).archivedTo).toBeTruthy();
    expect((schema as any).archivedTo).toBeUndefined();

    expect((corrupt as any).foundVersion).toBeUndefined();
    expect((schema as any).foundVersion).toBe(999);
  });

  it('T-055: schema-mismatch message matches /incompatible|migration/i', async () => {
    const root = makeTempProjectRoot();
    seedStateFromFixture(root, 'future-schema.json');

    const result = await loadState(root);
    expect(result.kind).toBe('schema-mismatch');

    const message = (result as any).message as string;
    expect(typeof message).toBe('string');
    expect(message).toMatch(/incompatible|migration/i);
  });
});

// ---------------------------------------------------------------------------
// loadState — error classification
// ---------------------------------------------------------------------------

describe('loadState — error classification', () => {
  it('T-057: ENOENT on state.json maps to kind=absent (not corrupt)', async () => {
    const root = makeTempProjectRoot();
    fs.mkdirSync(path.join(root, '.sui-deepbook-course'), { recursive: true });

    // Force readFile (and its sync sibling) to raise ENOENT — simulates a
    // file-disappeared-mid-read condition. The directory is present but the
    // file is not.
    const enoent: NodeJS.ErrnoException = Object.assign(
      new Error('ENOENT: no such file or directory'),
      { code: 'ENOENT' },
    );
    vi.spyOn(fsPromises, 'readFile').mockRejectedValue(enoent);
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw enoent;
    });

    const result = await loadState(root);

    expect(result.kind).toBe('absent');
    expect(listArchives(root)).toEqual([]);
  });

  it('T-058: EACCES on present state.json maps to kind=corrupt with read-error message', async () => {
    const root = makeTempProjectRoot();
    seedStateFromFixture(root, 'valid-cursor-p2.json');

    const eacces: NodeJS.ErrnoException = Object.assign(
      new Error('EACCES: permission denied'),
      { code: 'EACCES' },
    );

    // Spy: any read of state.json (in particular) should throw EACCES.
    const stateFilePath = path.join(root, '.sui-deepbook-course', 'state.json');
    const realPromisesReadFile = fsPromises.readFile;
    const realReadFileSync = fs.readFileSync;

    vi.spyOn(fsPromises, 'readFile').mockImplementation(((file: any, opts?: any) => {
      const target = typeof file === 'string' ? file : (file && file.toString());
      if (typeof target === 'string' && target.endsWith('state.json')) {
        return Promise.reject(eacces);
      }
      return realPromisesReadFile(file, opts);
    }) as any);

    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, opts?: any) => {
      const target = typeof file === 'string' ? file : (file && file.toString());
      if (typeof target === 'string' && target.endsWith('state.json')) {
        throw eacces;
      }
      return realReadFileSync(file, opts);
    }) as any);

    const result = await loadState(root);

    expect(result.kind).toBe('corrupt');
    expect(result.kind).not.toBe('absent');
    const message = (result as any).message as string;
    expect(typeof message).toBe('string');
    expect(message).toMatch(/read|permission|access/i);

    // Sanity: the canonical state.json was not deleted by the implementation
    // even though we forced reads to fail. (Otherwise we lose recovery.)
    expect(fs.existsSync(stateFilePath)).toBe(true);
  });

  it('T-059: state.ts source contains no bare catch{} blocks', () => {
    const sourcePath = path.join(REPO_ROOT, 'mcp', 'server', 'src', 'state.ts');
    const content = fs.readFileSync(sourcePath, 'utf8');

    // A bare catch is `catch {` with no parens binding an error variable.
    // Ban both `catch{` and `catch {`.
    expect(/catch\s*\{/.test(content)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// saveState — atomicity
// ---------------------------------------------------------------------------

describe('saveState — atomic write semantics', () => {
  function makeValidState() {
    return {
      schema_version: STATE_SCHEMA_VERSION,
      selected_path: '01-orderbook-viewer',
      personalization: { poll_interval_ms: 3000, pool_subset: 'both' },
      cursor: { phase_id: 'p1-bootstrap', spot_id: 'p1-spot-1' },
      ladder: {
        // auto_write_attempted is the cycle-4 A15 append-only field; it
        // defaults to false on read, so round-trip helpers must include it
        // in the seeded state for deep-equal comparisons to hold.
        'p1-spot-1': { hint_used: false, reference_shown: false, auto_completed: false, auto_write_attempted: false },
      },
      history: [{ ts: '2026-04-28T12:00:00Z', event: 'start' }],
    };
  }

  it('T-060: writes go to a tmp path under .sui-deepbook-course/, not the canonical state.json; rename is the only mutator of the canonical path', async () => {
    const root = makeTempProjectRoot();
    const canonical = path.join(root, '.sui-deepbook-course', 'state.json');

    const writeFilePromisesSpy = vi.spyOn(fsPromises, 'writeFile');
    const writeFileSpy = vi.spyOn(fs, 'writeFile');
    const writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync');
    const renamePromisesSpy = vi.spyOn(fsPromises, 'rename');
    const renameSpy = vi.spyOn(fs, 'rename');
    const renameSyncSpy = vi.spyOn(fs, 'renameSync');

    await saveState(root, makeValidState());

    // Collect the path argument from every write-style call we observed.
    const allWritePaths: string[] = [];
    function collectPath(args: unknown[]): void {
      const p = args[0];
      if (typeof p === 'string') allWritePaths.push(p);
      else if (p && typeof p === 'object' && 'pathname' in (p as any)) {
        allWritePaths.push((p as any).pathname);
      }
      // FileHandle / numeric fd — implementation may write via fd. Skip.
    }
    writeFilePromisesSpy.mock.calls.forEach((call) => collectPath(call));
    writeFileSpy.mock.calls.forEach((call) => collectPath(call));
    writeFileSyncSpy.mock.calls.forEach((call) => collectPath(call));

    // No write API may have been called directly with the canonical path —
    // every write must go through a tmp file first.
    for (const wp of allWritePaths) {
      expect(path.resolve(wp)).not.toBe(path.resolve(canonical));
    }

    // The rename target must be the canonical state.json. Collect destination
    // arguments from each rename API.
    const renameDests: string[] = [];
    function collectDest(args: unknown[]): void {
      const dest = args[1];
      if (typeof dest === 'string') renameDests.push(dest);
      else if (dest && typeof dest === 'object' && 'pathname' in (dest as any)) {
        renameDests.push((dest as any).pathname);
      }
    }
    renamePromisesSpy.mock.calls.forEach((call) => collectDest(call));
    renameSpy.mock.calls.forEach((call) => collectDest(call));
    renameSyncSpy.mock.calls.forEach((call) => collectDest(call));

    expect(renameDests.length).toBeGreaterThan(0);
    const matched = renameDests.some(
      (d) => path.resolve(d) === path.resolve(canonical),
    );
    expect(matched).toBe(true);

    // Sanity: tmp path lives under .sui-deepbook-course/.
    const tmpWrites = allWritePaths.filter((p) =>
      path.resolve(p).startsWith(path.resolve(path.join(root, '.sui-deepbook-course'))),
    );
    expect(tmpWrites.length).toBeGreaterThan(0);
  });

  it('T-061: invokes writeFile before rename (cycle-4 A14: fsync moved to FileHandle.sync; T-266 enforces sync ordering)', async () => {
    const root = makeTempProjectRoot();

    // Cycle 4 carry-forward A14 dropped the redundant `fs.fsyncSync(handle.fd)`
    // workaround. Durability now flows through FileHandle.sync (covered by
    // T-266 in the cycle-4 block below). T-061 here is reduced to its
    // load-bearing claim: `writeFile` happens BEFORE `rename`, so a killed
    // process between the two leaves the canonical file untouched.
    const writeFilePromisesSpy = vi.spyOn(fsPromises, 'writeFile');
    const writeFileSpy = vi.spyOn(fs, 'writeFile');
    const writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync');
    const renamePromisesSpy = vi.spyOn(fsPromises, 'rename');
    const renameSpy = vi.spyOn(fs, 'rename');
    const renameSyncSpy = vi.spyOn(fs, 'renameSync');

    await saveState(root, makeValidState());

    const minOrder = (orders: number[]): number =>
      orders.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...orders);
    const writeOrders = [
      ...writeFilePromisesSpy.mock.invocationCallOrder,
      ...writeFileSpy.mock.invocationCallOrder,
      ...writeFileSyncSpy.mock.invocationCallOrder,
    ];
    const renameOrders = [
      ...renamePromisesSpy.mock.invocationCallOrder,
      ...renameSpy.mock.invocationCallOrder,
      ...renameSyncSpy.mock.invocationCallOrder,
    ];

    expect(writeOrders.length).toBeGreaterThan(0);
    expect(renameOrders.length).toBeGreaterThan(0);

    const minWrite = minOrder(writeOrders);
    const minRename = minOrder(renameOrders);

    expect(minWrite).toBeLessThan(minRename);
  });

  it('T-062: rename failure leaves canonical state.json with prior contents', async () => {
    const root = makeTempProjectRoot();
    // Seed prior good bytes via the public saveState — but mock rename FIRST
    // to confirm the simulation. To get a "prior" state we can't use saveState
    // (since rename will be mocked); instead, place the file directly.
    const stateDir = path.join(root, '.sui-deepbook-course');
    fs.mkdirSync(stateDir, { recursive: true });
    const canonical = path.join(stateDir, 'state.json');
    const priorBytes = JSON.stringify(
      { schema_version: STATE_SCHEMA_VERSION, marker: 'PRIOR', selected_path: '01-orderbook-viewer' },
      null,
      2,
    );
    fs.writeFileSync(canonical, priorBytes, 'utf8');

    // Mock both promise- and callback-style rename to simulate failure.
    const simulated = new Error('simulated-rename-failure');
    vi.spyOn(fsPromises, 'rename').mockRejectedValue(simulated);
    vi.spyOn(fs, 'rename').mockImplementation(((_src: any, _dst: any, cb: any) => {
      if (typeof cb === 'function') cb(simulated);
    }) as any);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw simulated;
    });

    let caught: unknown;
    try {
      await saveState(root, makeValidState());
    } catch (err) {
      caught = err;
    }

    // Either saveState rejects, or it surfaces the failure. Either way the
    // canonical bytes must be intact.
    expect(caught).toBeTruthy();

    expect(fs.existsSync(canonical)).toBe(true);
    expect(fs.readFileSync(canonical, 'utf8')).toBe(priorBytes);
  });

  it('T-063: rename failure on a fresh root leaves canonical state.json absent', async () => {
    const root = makeTempProjectRoot();
    const canonical = path.join(root, '.sui-deepbook-course', 'state.json');

    const simulated = new Error('simulated-rename-failure');
    vi.spyOn(fsPromises, 'rename').mockRejectedValue(simulated);
    vi.spyOn(fs, 'rename').mockImplementation(((_src: any, _dst: any, cb: any) => {
      if (typeof cb === 'function') cb(simulated);
    }) as any);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw simulated;
    });

    let caught: unknown;
    try {
      await saveState(root, makeValidState());
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeTruthy();
    expect(fs.existsSync(canonical)).toBe(false);
  });

  it('T-064: round-trip — saveState then loadState returns { kind: ok, state } deep-equal', async () => {
    const root = makeTempProjectRoot();
    const s = makeValidState();

    await saveState(root, s);
    const result = await loadState(root);

    expect(result.kind).toBe('ok');
    expect((result as any).state).toEqual(s);
  });

  it('T-065: saveState creates .sui-deepbook-course/ on first save', async () => {
    const root = makeTempProjectRoot();
    const stateDir = path.join(root, '.sui-deepbook-course');
    expect(fs.existsSync(stateDir)).toBe(false);

    await saveState(root, makeValidState());

    const stat = fs.statSync(stateDir);
    expect(stat.isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'state.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// STATE_SCHEMA_VERSION constant
// ---------------------------------------------------------------------------

describe('STATE_SCHEMA_VERSION constant', () => {
  it('T-066: equals 3 (PR 2 bumped to add prompt_cursor_per_spot for prompted-agentic style)', () => {
    expect(STATE_SCHEMA_VERSION).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// validateState — schema validator
// ---------------------------------------------------------------------------

describe('validateState — schema validator', () => {
  function wellFormedState() {
    return {
      schema_version: STATE_SCHEMA_VERSION,
      selected_path: '01-orderbook-viewer',
      personalization: { poll_interval_ms: 3000, pool_subset: 'both' },
      cursor: { phase_id: 'p1-bootstrap', spot_id: 'p1-spot-1' },
      ladder: {
        'p1-spot-1': { hint_used: false, reference_shown: false, auto_completed: false },
      },
      history: [{ ts: '2026-04-28T12:00:00Z', event: 'start' }],
    };
  }

  function errStr(err: unknown): string {
    return typeof err === 'string' ? err : JSON.stringify(err);
  }

  it('T-067: accepts a well-formed State', () => {
    const input = wellFormedState();
    const result = validateState(input);
    expect(result.ok).toBe(true);
    expect((result as any).value).toBeTruthy();
    expect((result as any).value.schema_version).toBe(STATE_SCHEMA_VERSION);
  });

  it('T-068: rejects state with non-numeric schema_version', () => {
    const input: any = { ...wellFormedState(), schema_version: '1' };
    const result = validateState(input);
    expect(result.ok).toBe(false);
    expect((result as any).error).toBeTruthy();
    expect(errStr((result as any).error)).toContain('schema_version');
  });

  it('T-069: rejects state missing selected_path', () => {
    const input: any = { ...wellFormedState() };
    delete input.selected_path;
    const result = validateState(input);
    expect(result.ok).toBe(false);
    expect(errStr((result as any).error)).toContain('selected_path');
  });

  it('T-070: rejects state with missing cursor.phase_id', () => {
    const input: any = { ...wellFormedState(), cursor: { spot_id: 'p1-spot-1' } };
    const result = validateState(input);
    expect(result.ok).toBe(false);
    const message = errStr((result as any).error);
    expect(/cursor|phase_id/.test(message)).toBe(true);
  });

  it('T-071: rejects state with missing cursor.spot_id', () => {
    const input: any = { ...wellFormedState(), cursor: { phase_id: 'p1-bootstrap' } };
    const result = validateState(input);
    expect(result.ok).toBe(false);
    const message = errStr((result as any).error);
    expect(/cursor|spot_id/.test(message)).toBe(true);
  });

  it('T-072: rejects state with non-object personalization', () => {
    const input: any = { ...wellFormedState(), personalization: 'not-an-object' };
    const result = validateState(input);
    expect(result.ok).toBe(false);
    expect(errStr((result as any).error)).toContain('personalization');
  });

  it('T-073: rejects state with non-array history', () => {
    const input: any = { ...wellFormedState(), history: 'not-array' };
    const result = validateState(input);
    expect(result.ok).toBe(false);
    expect(errStr((result as any).error)).toContain('history');
  });

  it('T-074: rejects state with non-object ladder (e.g. array)', () => {
    const input: any = { ...wellFormedState(), ladder: ['array', 'not-object'] };
    const result = validateState(input);
    expect(result.ok).toBe(false);
    expect(errStr((result as any).error)).toContain('ladder');
  });
});

// ---------------------------------------------------------------------------
// Source-level guards on state.ts
// ---------------------------------------------------------------------------

describe('state.ts source-level guards', () => {
  const stateSourcePath = path.join(REPO_ROOT, 'mcp', 'server', 'src', 'state.ts');

  it("T-092: state.ts contains no kind:'shell' literal (cycle 1's A14 preserved on the new surface)", () => {
    const content = fs.readFileSync(stateSourcePath, 'utf8');
    const single = /kind\s*:\s*'shell'/;
    const double = /kind\s*:\s*"shell"/;
    expect(single.test(content)).toBe(false);
    expect(double.test(content)).toBe(false);
  });

  it("T-093: state.ts contains no '01-orderbook-viewer' literal (state is path-slug-agnostic)", () => {
    const content = fs.readFileSync(stateSourcePath, 'utf8');
    expect(content.indexOf('01-orderbook-viewer')).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Round-trip with non-default personalization
// ---------------------------------------------------------------------------

describe('saveState round-trip — non-default personalization', () => {
  it('T-094: round-trips non-default personalization values without normalization', async () => {
    const root = makeTempProjectRoot();
    const s = {
      schema_version: STATE_SCHEMA_VERSION,
      selected_path: '01-orderbook-viewer',
      personalization: { poll_interval_ms: 5000, pool_subset: 'DEEP_SUI' },
      cursor: { phase_id: 'p3-poll', spot_id: 'p3-spot-1' },
      ladder: {
        'p1-spot-1': { hint_used: true, reference_shown: false, auto_completed: false, auto_write_attempted: false },
      },
      history: [
        { ts: '2026-04-28T12:00:00Z', event: 'start' },
        { ts: '2026-04-28T12:05:00Z', event: 'spot_complete:p1-spot-1' },
      ],
    };

    await saveState(root, s);
    const result = await loadState(root);

    expect(result.kind).toBe('ok');
    expect((result as any).state.personalization).toEqual({
      poll_interval_ms: 5000,
      pool_subset: 'DEEP_SUI',
    });
    expect((result as any).state).toEqual(s);
  });
});

describe('cycle 2 remediation — C001/C008a', () => {
  it('T-095: EACCES read-error returns kind=corrupt with archivedTo undefined (not empty string)', async () => {
    // Make the parent dir unreadable so opening state.json yields a non-ENOENT
    // error. We seed a regular state.json first, then strip permissions on the
    // dir so readFile fails with EACCES. On macOS/Linux running as a non-root
    // user this is reliable; root would bypass and the test skips itself.
    if (process.getuid && process.getuid() === 0) return; // skip under root

    const root = makeTempProjectRoot();
    const stateDir = path.join(root, '.sui-deepbook-course');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state.json'), '{}', 'utf8');
    fs.chmodSync(stateDir, 0o000);
    try {
      const result = await loadState(root);
      expect(result.kind).toBe('corrupt');
      // The fix: archivedTo MUST NOT be the empty string. Either undefined or
      // a real archive path is acceptable; '' is the bug being remediated.
      const archivedTo = (result as any).archivedTo;
      expect(archivedTo === undefined || (typeof archivedTo === 'string' && archivedTo.length > 0)).toBe(true);
      // We did not have permission to write an archive either, so undefined
      // is the expected outcome here.
      expect(archivedTo).toBeUndefined();
    } finally {
      fs.chmodSync(stateDir, 0o755);
    }
  });

  it('T-096: archive-write failure does not reject loadState — kind=corrupt still surfaces', async () => {
    const root = makeTempProjectRoot();
    const stateDir = path.join(root, '.sui-deepbook-course');
    fs.mkdirSync(stateDir, { recursive: true });
    // Seed state.json with bytes that fail JSON.parse — this routes loadState
    // into the archive-write branch.
    fs.writeFileSync(path.join(stateDir, 'state.json'), '{ not valid json', 'utf8');

    // Make the canonical writeFile fail by stubbing fs.promises.writeFile to
    // throw on the archive write. The implementation must catch and degrade
    // gracefully instead of rejecting the whole loadState.
    const realWriteFile = fsPromises.writeFile;
    const writeSpy = vi
      .spyOn(fsPromises, 'writeFile')
      .mockImplementation((async (target: any, data: any, opts?: any) => {
        // Allow non-archive writes through (none in this test, but be safe).
        if (typeof target === 'string' && target.includes('state.corrupt-')) {
          throw Object.assign(new Error('ENOSPC: simulated archive write failure'), { code: 'ENOSPC' });
        }
        return realWriteFile(target, data, opts);
      }) as any);

    try {
      const result = await loadState(root);
      expect(result.kind).toBe('corrupt');
      // Either undefined or includes a hint that archive failed — both are
      // acceptable degradations; the load-bearing assertion is non-rejection.
      const archivedTo = (result as any).archivedTo;
      expect(archivedTo === undefined || archivedTo === null || typeof archivedTo === 'string').toBe(true);
      expect((result as any).message).toEqual(expect.any(String));
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ===========================================================================
// CYCLE 3 — cycle-2-carry-forward (A18 fsync FileHandle, A19 wx flag)
// ===========================================================================

function makeValidStateForC3() {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    selected_path: '01-orderbook-viewer',
    personalization: { poll_interval_ms: 3000, pool_subset: 'both' },
    cursor: { phase_id: 'p1-bootstrap', spot_id: 'p1-spot-1' },
    ladder: {
      // Cycle-4 A15 append-only field; required for round-trip deep-equal
      // tests (T-169/T-267) since the loader normalizes absent values to false.
      'p1-spot-1': { hint_used: false, reference_shown: false, auto_completed: false, auto_write_attempted: false },
    },
    history: [{ ts: '2026-04-28T12:00:00Z', event: 'start' }],
  };
}

describe('cycle 3 — A18 saveState fsync FileHandle relationship', () => {
  it('T-164: fsync uses the FileHandle returned by fsPromises.open (identity assertion)', async () => {
    const root = makeTempProjectRoot();

    // Spy on fsPromises.open. Inside the spy, after the real handle resolves,
    // patch its .sync method to record the `this`-binding so we can compare
    // identity with the resolved handle.
    const realOpen = fsPromises.open;
    let openedHandle: any = null;
    let syncedHandle: any = null;
    let openOrder = -1;
    let syncOrder = -1;
    let renameOrder = -1;
    const orderCounter = { n: 0 };

    const openSpy = vi
      .spyOn(fsPromises, 'open')
      .mockImplementation(async (...args: any[]) => {
        openOrder = ++orderCounter.n;
        const handle = await (realOpen as any)(...args);
        openedHandle = handle;
        const realSync = handle.sync.bind(handle);
        handle.sync = async function patchedSync() {
          syncedHandle = this;
          syncOrder = ++orderCounter.n;
          return realSync();
        };
        return handle;
      });

    const renameSpy = vi
      .spyOn(fsPromises, 'rename')
      .mockImplementation(async (...args: any[]) => {
        renameOrder = ++orderCounter.n;
        return (fsPromises.rename as any).getMockImplementation
          ? (fsPromises.rename as any).getMockImplementation()(...args)
          : await (Object.getPrototypeOf(fsPromises) as any).rename?.(...args);
      });

    // The above mockImplementation for rename is ineffective for spy-mode
    // restoration. Drop it and use the original wrapper:
    renameSpy.mockRestore();
    const renameSpy2 = vi.spyOn(fsPromises, 'rename');

    await saveState(root, makeValidStateForC3());

    expect(openSpy).toHaveBeenCalled();
    expect(openedHandle).toBeTruthy();
    expect(syncedHandle).toBeTruthy();
    // Identity check: the fsynced handle is the same object open returned.
    expect(syncedHandle).toBe(openedHandle);
    // Open before sync; sync before rename (record orders).
    expect(openOrder).toBeLessThan(syncOrder);
    // Rename was invoked (we don't capture renameOrder via the second spy
    // strictly, but assert it was called at all).
    expect(renameSpy2).toHaveBeenCalled();
  });

  it("T-165: opens the tmp file with 'r+' (not 'r')", async () => {
    const root = makeTempProjectRoot();
    const openSpy = vi.spyOn(fsPromises, 'open');

    await saveState(root, makeValidStateForC3());

    const tmpCalls = openSpy.mock.calls.filter((c) => {
      const p = c[0];
      const s = typeof p === 'string' ? p : '';
      return s.includes('.sui-deepbook-course') && /\.tmp/.test(s);
    });
    expect(tmpCalls.length).toBeGreaterThan(0);
    for (const call of tmpCalls) {
      const flags = call[1];
      // Must be 'r+' (read-write) — not bare 'r'.
      if (typeof flags === 'string') {
        expect(flags).toBe('r+');
      } else if (typeof flags === 'number') {
        // O_RDWR === 2
        expect(flags & 0x3).toBe(2);
      } else {
        throw new Error(
          `Unexpected flags type for tmp open: ${typeof flags} (${String(flags)})`,
        );
      }
    }
  });

  it('T-166: closes the FileHandle after sync (close.invocationCallOrder > sync)', async () => {
    const root = makeTempProjectRoot();
    const realOpen = fsPromises.open;

    let syncOrder = -1;
    let closeOrder = -1;
    let openedHandle: any = null;

    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args: any[]) => {
      const handle = await (realOpen as any)(...args);
      openedHandle = handle;
      const realSync = handle.sync.bind(handle);
      const realClose = handle.close.bind(handle);
      handle.sync = async function patchedSync() {
        syncOrder = Date.now() * 1e6 + (Math.random() * 1e6 | 0);
        await new Promise((r) => setImmediate(r));
        return realSync();
      };
      handle.close = async function patchedClose() {
        closeOrder = Date.now() * 1e6 + (Math.random() * 1e6 | 0);
        await new Promise((r) => setImmediate(r));
        return realClose();
      };
      return handle;
    });

    await saveState(root, makeValidStateForC3());

    expect(openedHandle).toBeTruthy();
    expect(syncOrder).toBeGreaterThan(0);
    expect(closeOrder).toBeGreaterThan(0);
    expect(closeOrder).toBeGreaterThanOrEqual(syncOrder);
  });
});

describe("cycle 3 — A19 saveState writeFile { flag: 'wx', mode: 0o600 }", () => {
  it("T-167: tmp writeFile passes { flag: 'wx', mode: 0o600 }", async () => {
    const root = makeTempProjectRoot();
    const writeFileSpy = vi.spyOn(fsPromises, 'writeFile');

    await saveState(root, makeValidStateForC3());

    const tmpCalls = writeFileSpy.mock.calls.filter((c) => {
      const p = c[0];
      const s = typeof p === 'string' ? p : '';
      return s.includes('.sui-deepbook-course') && /\.tmp/.test(s);
    });
    expect(tmpCalls.length).toBeGreaterThan(0);
    for (const call of tmpCalls) {
      const opts = call[2];
      expect(typeof opts).toBe('object');
      expect((opts as any).flag).toBe('wx');
      expect((opts as any).mode).toBe(0o600);
    }
  });

  it("T-168: archiveCorruptFile writeFile passes { flag: 'wx', mode: 0o600 }", async () => {
    const root = makeTempProjectRoot();
    const stateDir = path.join(root, '.sui-deepbook-course');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state.json'), '{ not json', 'utf8');

    const writeFileSpy = vi.spyOn(fsPromises, 'writeFile');
    await loadState(root);

    const archiveCalls = writeFileSpy.mock.calls.filter((c) => {
      const p = c[0];
      const s = typeof p === 'string' ? p : '';
      return s.includes('state.corrupt-');
    });
    expect(archiveCalls.length).toBeGreaterThan(0);
    for (const call of archiveCalls) {
      const opts = call[2];
      expect(typeof opts).toBe('object');
      expect((opts as any).flag).toBe('wx');
      expect((opts as any).mode).toBe(0o600);
    }
  });

  it('T-169: round-trip still passes after the FileHandle rewrite (regression of T-064)', async () => {
    const root = makeTempProjectRoot();
    const s = makeValidStateForC3();

    await saveState(root, s);
    const result = await loadState(root);

    expect(result.kind).toBe('ok');
    expect((result as any).state).toEqual(s);
  });

  it("T-170: 'wx' flag refuses to overwrite — writeFile receives flag 'wx' on tmp write", async () => {
    // Behavioral assertion: every fsPromises.writeFile call targeting the tmp
    // path passes flag 'wx'. We don't simulate a stale tmp here (the tmp path
    // is randomized and not stub-friendly); instead we assert the load-bearing
    // invariant — wx is the flag — at the call site. This complements T-167
    // (which checks flag and mode together) by isolating the flag and failing
    // at red when the impl uses no flag at all.
    const root = makeTempProjectRoot();
    const writeFileSpy = vi.spyOn(fsPromises, 'writeFile');

    await saveState(root, makeValidStateForC3());

    const tmpCalls = writeFileSpy.mock.calls.filter((c) => {
      const p = c[0];
      const s = typeof p === 'string' ? p : '';
      return s.includes('.sui-deepbook-course') && /\.tmp/.test(s);
    });
    expect(tmpCalls.length).toBeGreaterThan(0);
    for (const call of tmpCalls) {
      const opts = call[2] as { flag?: string } | string | undefined;
      // The opts arg must be an object (not a bare string encoding) and must
      // pass flag 'wx'. Bare 'utf8' (the cycle-2 impl) fails this assertion.
      expect(typeof opts).toBe('object');
      expect((opts as { flag?: string }).flag).toBe('wx');
    }
  });
});

// ===========================================================================
// CYCLE 4 — A14 (drop redundant fsync), A15 (append-only schema additions)
// ===========================================================================

import { validateState as validateStateC4 } from '../mcp/server/src/schemas/state.js';

describe('cycle 4 — A14 state.ts drops node:fs and fsyncSync', () => {
  const stateSourcePath = path.join(REPO_ROOT, 'mcp', 'server', 'src', 'state.ts');

  it('T-264: state.ts no longer imports from node:fs (only node:fs/promises and node:path)', () => {
    const content = fs.readFileSync(stateSourcePath, 'utf8');
    // Bare 'node:fs' import must be gone. The promise variant remains.
    expect(/from\s+['"]node:fs['"]/.test(content)).toBe(false);
    expect(/from\s+['"]node:fs\/promises['"]/.test(content)).toBe(true);
    expect(/from\s+['"]node:path['"]/.test(content)).toBe(true);
  });

  it('T-265: state.ts contains zero fsyncSync references', () => {
    const content = fs.readFileSync(stateSourcePath, 'utf8');
    expect(content.indexOf('fsyncSync')).toBe(-1);
    // Belt-and-suspenders: also no `handle.fd` read (the cycle-3 redundant
    // fsync line had `fs.fsyncSync(handle.fd)`).
    expect(/fsyncSync\s*\(\s*handle\.fd/.test(content)).toBe(false);
  });

  it('T-266: saveState durability sequence: open(tmp,r+) → handle.sync() → handle.close() → rename (FileHandle.prototype.sync spy, no fs.fsync*)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sui-course-c4-'));
    tempRoots.push(root);

    const realOpen = fsPromises.open;
    let openedHandle: any = null;
    let syncedHandle: any = null;
    const counter = { n: 0 };
    let openOrder = -1;
    let syncOrder = -1;
    let closeOrder = -1;

    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args: any[]) => {
      openOrder = ++counter.n;
      const handle = await (realOpen as any)(...args);
      openedHandle = handle;
      const realSync = handle.sync.bind(handle);
      const realClose = handle.close.bind(handle);
      handle.sync = async function patchedSync() {
        syncedHandle = this;
        syncOrder = ++counter.n;
        return realSync();
      };
      handle.close = async function patchedClose() {
        closeOrder = ++counter.n;
        return realClose();
      };
      return handle;
    });

    let renameOrder = -1;
    const realRename = fsPromises.rename;
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (...args: any[]) => {
      renameOrder = ++counter.n;
      return (realRename as any)(...args);
    });

    const fsyncSpy = vi.spyOn(fs, 'fsync');
    const fsyncSyncSpy = vi.spyOn(fs, 'fsyncSync');
    const fdatasyncSpy = vi.spyOn(fs, 'fdatasync');

    await saveState(root, {
      schema_version: STATE_SCHEMA_VERSION,
      selected_path: '01-orderbook-viewer',
      personalization: { poll_interval_ms: 3000, pool_subset: 'both' },
      cursor: { phase_id: 'p1-bootstrap', spot_id: 'p1-spot-1' },
      ladder: {
        'p1-spot-1': { hint_used: false, reference_shown: false, auto_completed: false, auto_write_attempted: false },
      },
      history: [],
    });

    expect(openedHandle).toBeTruthy();
    expect(syncedHandle).toBeTruthy();
    // Identity check: the synced handle is the same object the open returned.
    expect(syncedHandle).toBe(openedHandle);
    expect(openOrder).toBeLessThan(syncOrder);
    expect(syncOrder).toBeLessThan(closeOrder);
    expect(closeOrder).toBeLessThanOrEqual(renameOrder);

    // No legacy fs.fsync* calls anymore.
    expect(fsyncSpy).not.toHaveBeenCalled();
    expect(fsyncSyncSpy).not.toHaveBeenCalled();
    expect(fdatasyncSpy).not.toHaveBeenCalled();
  });

  it('T-267: saveState round-trip still passes after the redundant fsync removal (regression)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sui-course-c4-'));
    tempRoots.push(root);
    const s = {
      schema_version: STATE_SCHEMA_VERSION,
      selected_path: '01-orderbook-viewer',
      personalization: { poll_interval_ms: 3000, pool_subset: 'both' },
      cursor: { phase_id: 'p1-bootstrap', spot_id: 'p1-spot-1' },
      ladder: {
        'p1-spot-1': { hint_used: false, reference_shown: false, auto_completed: false, auto_write_attempted: false },
      },
      history: [{ ts: '2026-04-28T12:00:00Z', event: 'start' }],
    };
    await saveState(root, s);
    const result = await loadState(root);
    expect(result.kind).toBe('ok');
    expect((result as any).state).toEqual(s);
  });
});

describe('cycle 4 — A15 LadderRung.auto_write_attempted (append-only)', () => {
  it('T-268: validateState accepts a State whose ladder rungs lack auto_write_attempted (back-compat)', () => {
    const result = validateStateC4({
      schema_version: STATE_SCHEMA_VERSION,
      selected_path: '01-orderbook-viewer',
      personalization: { poll_interval_ms: 3000, pool_subset: 'both' },
      cursor: { phase_id: 'p1-bootstrap', spot_id: 'p1-spot-1' },
      ladder: {
        'p1-spot-1': {
          hint_used: false,
          reference_shown: false,
          auto_completed: false,
        },
      },
      history: [],
    });
    expect(result.ok).toBe(true);
    const rung = ((result as any).value as any).ladder['p1-spot-1'];
    expect(rung.auto_write_attempted).toBe(false);
  });

  it('T-269: validateState accepts a ladder rung with auto_write_attempted: true', () => {
    const result = validateStateC4({
      schema_version: STATE_SCHEMA_VERSION,
      selected_path: '01-orderbook-viewer',
      personalization: { poll_interval_ms: 3000, pool_subset: 'both' },
      cursor: { phase_id: 'p1-bootstrap', spot_id: 'p1-spot-1' },
      ladder: {
        'p1-spot-1': {
          hint_used: false,
          reference_shown: false,
          auto_completed: false,
          auto_write_attempted: true,
        },
      },
      history: [],
    });
    expect(result.ok).toBe(true);
    const rung = ((result as any).value as any).ladder['p1-spot-1'];
    expect(rung.auto_write_attempted).toBe(true);
  });

  it('T-270: STATE_SCHEMA_VERSION reflects the schema bumps (cycle 4 = 1, F-005 = 2, PR 2 prompted-agentic = 3)', () => {
    expect(STATE_SCHEMA_VERSION).toBe(3);
  });

  it('T-271: saveState round-trip preserves auto_write_attempted (default false when not set)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sui-course-c4-'));
    tempRoots.push(root);
    const s: any = {
      schema_version: STATE_SCHEMA_VERSION,
      selected_path: '01-orderbook-viewer',
      personalization: { poll_interval_ms: 3000, pool_subset: 'both' },
      cursor: { phase_id: 'p1-bootstrap', spot_id: 'p1-spot-1' },
      ladder: {
        'p1-spot-1': { hint_used: true, reference_shown: false, auto_completed: false },
      },
      history: [],
    };
    await saveState(root, s);
    const result = await loadState(root);
    expect(result.kind).toBe('ok');
    const rung = ((result as any).state as any).ladder['p1-spot-1'];
    expect(rung.auto_write_attempted).toBe(false);
  });
});
