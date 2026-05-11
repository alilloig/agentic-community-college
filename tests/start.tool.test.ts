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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Mock the outputStyle module BEFORE importing the start tool, so the start
// implementation pulls our stub during these tests. vi.hoisted() so the mock
// is registered before the import below.
// ---------------------------------------------------------------------------

const outputStyleMock = vi.hoisted(() => {
  return {
    probeOutputStyle: vi.fn<() => Promise<{ ok: boolean; warning?: { kind: string; message: string } }>>(
      async () => ({ ok: true }),
    ),
  };
});

vi.mock('../mcp/server/src/outputStyle.js', () => ({
  probeOutputStyle: outputStyleMock.probeOutputStyle,
}));

// Cycle 2: mock the state module so the start tool's new state-loading code
// path is observable from the test layer. The default impl resolves to
// { kind: 'absent' } — equivalent to the cycle-1 zero-state-file world. Each
// cycle-2 test below overrides per-call as needed.
const stateMock = vi.hoisted(() => {
  return {
    loadState: vi.fn<(root: string) => Promise<unknown>>(async () => ({
      kind: 'absent',
    })),
    saveState: vi.fn<(root: string, state: unknown) => Promise<void>>(async () => {}),
    STATE_SCHEMA_VERSION: 1 as const,
  };
});

vi.mock('../mcp/server/src/state.js', () => ({
  loadState: stateMock.loadState,
  saveState: stateMock.saveState,
  STATE_SCHEMA_VERSION: stateMock.STATE_SCHEMA_VERSION,
}));

// Modules under test — none exist yet at red phase. The import failures are
// the meaningful red signal; assertion bodies below describe the green
// behavior the implementer must produce.
import { runStart } from '../mcp/server/src/tools/start.js';
import { scanRegistry } from '../mcp/server/src/registry.js';

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

const EXPECTED_TOP_LEVEL_KEYS = [
  'outputStyleOk',
  'preflight',
  'paths',
  'state',
  'warnings',
] as const;

function deepFindShellKind(node: unknown): boolean {
  if (node === null || node === undefined) return false;
  if (typeof node !== 'object') return false;
  if (Array.isArray(node)) {
    return node.some((item) => deepFindShellKind(item));
  }
  const obj = node as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, 'kind') && obj.kind === 'shell') {
    return true;
  }
  for (const value of Object.values(obj)) {
    if (deepFindShellKind(value)) return true;
  }
  return false;
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

beforeEach(() => {
  outputStyleMock.probeOutputStyle.mockReset();
  outputStyleMock.probeOutputStyle.mockImplementation(async () => ({ ok: true }));
  stateMock.loadState.mockReset();
  stateMock.loadState.mockImplementation(async () => ({ kind: 'absent' }));
  stateMock.saveState.mockReset();
  stateMock.saveState.mockImplementation(async () => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('start tool — shape contract', () => {
  it('T-004: response has exactly the documented top-level keys', async () => {
    const response = await runStart({ projectRoot: REPO_ROOT });
    const keys = Object.keys(response).sort();
    const expected = [...EXPECTED_TOP_LEVEL_KEYS].sort();
    expect(keys).toEqual(expected);
  });

  it('T-005: outputStyleOk is a boolean', async () => {
    const response = await runStart({ projectRoot: REPO_ROOT });
    expect(typeof response.outputStyleOk).toBe('boolean');
  });

  it("T-006: preflight is exactly { skipped: true, reason: 'cycle-1' }", async () => {
    const response = await runStart({ projectRoot: REPO_ROOT });
    expect(response.preflight).toEqual({ skipped: true, reason: 'cycle-1' });
  });

  it('T-007: state field is null', async () => {
    const response = await runStart({ projectRoot: REPO_ROOT });
    expect(response.state).toBeNull();
  });

  it('T-008: paths is an array of PathInfo (string slug + title minimum)', async () => {
    const response = await runStart({ projectRoot: REPO_ROOT });
    expect(Array.isArray(response.paths)).toBe(true);
    for (const entry of response.paths) {
      expect(typeof entry.slug).toBe('string');
      expect(entry.slug.length).toBeGreaterThan(0);
      expect(typeof entry.title).toBe('string');
      expect(entry.title.length).toBeGreaterThan(0);
    }
  });

  it('T-009: warnings is an array of RegistryWarning (string kind + message minimum)', async () => {
    const response = await runStart({ projectRoot: REPO_ROOT });
    expect(Array.isArray(response.warnings)).toBe(true);
    for (const w of response.warnings) {
      expect(typeof w.kind).toBe('string');
      expect(w.kind.length).toBeGreaterThan(0);
      expect(typeof w.message).toBe('string');
      expect(w.message.length).toBeGreaterThan(0);
    }
  });
});

describe('start tool — registry delegation', () => {
  it("T-010: paths is exactly the registry's paths output for the same root", async () => {
    const fixtureProjectRoot = path.resolve(__dirname, 'fixtures');
    // The start tool is documented to scan `<projectRoot>/paths/`. Our fixture
    // tree has tests/fixtures/paths/ as its `paths/` subdir.
    const response = await runStart({ projectRoot: fixtureProjectRoot });
    const direct = await scanRegistry(path.join(fixtureProjectRoot, 'paths'));
    expect(response.paths).toEqual(direct.paths);
  });

  it("T-011: warnings is exactly the registry's warnings output for the same root", async () => {
    const fixtureProjectRoot = path.resolve(__dirname, 'fixtures');
    const response = await runStart({ projectRoot: fixtureProjectRoot });
    const direct = await scanRegistry(path.join(fixtureProjectRoot, 'paths'));
    expect(response.warnings).toEqual(direct.warnings);
  });
});

describe('start tool — outputStyle delegation', () => {
  it('T-012: outputStyleOk reflects the probe result (true)', async () => {
    outputStyleMock.probeOutputStyle.mockResolvedValueOnce({ ok: true });
    const response = await runStart({ projectRoot: REPO_ROOT });
    expect(response.outputStyleOk).toBe(true);
  });

  it('T-012: outputStyleOk reflects the probe result (false)', async () => {
    outputStyleMock.probeOutputStyle.mockResolvedValueOnce({
      ok: false,
      warning: { kind: 'settings-file-missing', message: 'no settings' },
    });
    const response = await runStart({ projectRoot: REPO_ROOT });
    expect(response.outputStyleOk).toBe(false);
  });
});

describe('start tool — AC-1.3 zero-write invariant (T-018)', () => {
  let tempProjectRoot: string;

  beforeEach(() => {
    tempProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sui-course-zero-write-'));
    // Seed it with a paths/ directory that holds the fake fixture, so the
    // registry has something real to scan.
    const pathsDir = path.join(tempProjectRoot, 'paths');
    fs.mkdirSync(pathsDir, { recursive: true });
    const slugDir = path.join(pathsDir, '04-fake-path');
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(
      path.join(slugDir, 'path.json'),
      JSON.stringify(
        {
          slug: '04-fake-path',
          title: 'Fake Fourth Path',
          summary: 'snapshot fixture',
          personalization_options: ['poll_interval_ms', 'pool_subset'],
          build_command: 'pnpm build',
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
            { id: 'p1', spots: [{ id: 's1', title: 'stub' }] },
            { id: 'p2', spots: [{ id: 's2', title: 'stub' }] },
            { id: 'p3', spots: [{ id: 's3', title: 'stub' }] },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(tempProjectRoot, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  });

  it('writes nothing when outputStyleOk === false', async () => {
    // Force the probe to report disabled.
    outputStyleMock.probeOutputStyle.mockResolvedValueOnce({
      ok: false,
      warning: { kind: 'settings-file-missing', message: 'absent' },
    });

    // Spy on every write surface — sync, callback, and promise-based. If the
    // implementer slips a debug write under any of these, the test fails.
    const writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync');
    const writeFileSpy = vi.spyOn(fs, 'writeFile');
    const appendFileSyncSpy = vi.spyOn(fs, 'appendFileSync');
    const appendFileSpy = vi.spyOn(fs, 'appendFile');
    const mkdirSpy = vi.spyOn(fs, 'mkdir');
    const mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync');
    const renameSpy = vi.spyOn(fs, 'rename');
    const renameSyncSpy = vi.spyOn(fs, 'renameSync');
    const truncateSpy = vi.spyOn(fs, 'truncate');
    const truncateSyncSpy = vi.spyOn(fs, 'truncateSync');
    const unlinkSpy = vi.spyOn(fs, 'unlink');
    const unlinkSyncSpy = vi.spyOn(fs, 'unlinkSync');

    const promisesWriteFileSpy = vi.spyOn(fsPromises, 'writeFile');
    const promisesAppendFileSpy = vi.spyOn(fsPromises, 'appendFile');
    const promisesMkdirSpy = vi.spyOn(fsPromises, 'mkdir');
    const promisesRenameSpy = vi.spyOn(fsPromises, 'rename');
    const promisesTruncateSpy = vi.spyOn(fsPromises, 'truncate');
    const promisesUnlinkSpy = vi.spyOn(fsPromises, 'unlink');

    const beforeSnap = snapshot(tempProjectRoot);

    const response = await runStart({ projectRoot: tempProjectRoot });

    const afterSnap = snapshot(tempProjectRoot);

    // The probe reported false, so this should be the case.
    expect(response.outputStyleOk).toBe(false);

    // Recursive snapshot byte-and-mtime equality.
    expect(afterSnap.length).toBe(beforeSnap.length);
    for (let i = 0; i < beforeSnap.length; i++) {
      expect(afterSnap[i].relPath).toBe(beforeSnap[i].relPath);
      expect(afterSnap[i].size).toBe(beforeSnap[i].size);
      expect(afterSnap[i].content).toBe(beforeSnap[i].content);
      expect(afterSnap[i].mtimeMs).toBe(beforeSnap[i].mtimeMs);
    }

    // Spy assertions — every write surface must be untouched.
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(appendFileSyncSpy).not.toHaveBeenCalled();
    expect(appendFileSpy).not.toHaveBeenCalled();
    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(mkdirSyncSpy).not.toHaveBeenCalled();
    expect(renameSpy).not.toHaveBeenCalled();
    expect(renameSyncSpy).not.toHaveBeenCalled();
    expect(truncateSpy).not.toHaveBeenCalled();
    expect(truncateSyncSpy).not.toHaveBeenCalled();
    expect(unlinkSpy).not.toHaveBeenCalled();
    expect(unlinkSyncSpy).not.toHaveBeenCalled();
    expect(promisesWriteFileSpy).not.toHaveBeenCalled();
    expect(promisesAppendFileSpy).not.toHaveBeenCalled();
    expect(promisesMkdirSpy).not.toHaveBeenCalled();
    expect(promisesRenameSpy).not.toHaveBeenCalled();
    expect(promisesTruncateSpy).not.toHaveBeenCalled();
    expect(promisesUnlinkSpy).not.toHaveBeenCalled();
  });
});

describe('start tool — shell action surface guard', () => {
  it('T-032: response object contains no field with kind === "shell"', async () => {
    const response = await runStart({ projectRoot: REPO_ROOT });
    expect(deepFindShellKind(response)).toBe(false);
  });

  it("T-033: start.ts source contains no kind:'shell' action literal", () => {
    const sourcePath = path.join(REPO_ROOT, 'mcp', 'server', 'src', 'tools', 'start.ts');
    const content = fs.readFileSync(sourcePath, 'utf8');

    // Match kind: 'shell' or kind:"shell" with optional whitespace.
    const singleQuoted = /kind\s*:\s*'shell'/;
    const doubleQuoted = /kind\s*:\s*"shell"/;

    expect(singleQuoted.test(content)).toBe(false);
    expect(doubleQuoted.test(content)).toBe(false);
  });
});

describe('TypeScript strict surface compiles', () => {
  it('T-003: tsc --noEmit on mcp/server/ exits zero', () => {
    const result = spawnSync(
      'pnpm',
      ['--filter', './mcp/server', 'exec', 'tsc', '--noEmit'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      },
    );
    // If pnpm or the workspace doesn't exist yet, status will be non-zero —
    // that's the meaningful red signal until cycle-2-implementer creates the
    // workspace. Once it exists, this asserts strict compile.
    expect(result.status).toBe(0);
  });
});

describe('e2e harness', () => {
  it('T-028: harness boots MCP server in-process and start tool returns documented shape', async () => {
    // Dynamic import so a missing harness file fails this test specifically
    // rather than tearing down the whole suite at module load.
    const harnessMod: any = await import('../scripts/e2e/harness.js');

    // Harness API: bootHarness({ projectRoot }) returns { callTool, shutdown }.
    // Implementer is free to name these as long as the surface is reachable
    // from this test. Tests document the expected method names below.
    const boot = harnessMod.bootHarness ?? harnessMod.boot ?? harnessMod.default;
    expect(typeof boot).toBe('function');

    const harness = await boot({ projectRoot: path.resolve(__dirname, 'fixtures') });
    try {
      const callTool = harness.callTool ?? harness.invokeTool ?? harness.call;
      expect(typeof callTool).toBe('function');

      const response = await callTool('start', { projectRoot: path.resolve(__dirname, 'fixtures') });

      // Some MCP harnesses return { content: [{ type: 'text', text: JSON }] };
      // tolerate that wrapping by extracting the embedded JSON object if
      // present, else treating the response itself as the documented shape.
      const payload = (() => {
        if (
          response &&
          typeof response === 'object' &&
          Array.isArray((response as any).content) &&
          (response as any).content[0]?.type === 'text' &&
          typeof (response as any).content[0]?.text === 'string'
        ) {
          try {
            return JSON.parse((response as any).content[0].text);
          } catch {
            return response;
          }
        }
        return response;
      })();

      expect(typeof payload).toBe('object');
      expect(payload).not.toBeNull();
      const keys = Object.keys(payload).sort();
      const expected = [...EXPECTED_TOP_LEVEL_KEYS].sort();
      expect(keys).toEqual(expected);
      expect(typeof payload.outputStyleOk).toBe('boolean');
      expect(payload.preflight).toEqual({ skipped: true, reason: 'cycle-1' });
      expect(payload.state).toBeNull();
      expect(Array.isArray(payload.paths)).toBe(true);
      expect(Array.isArray(payload.warnings)).toBe(true);
    } finally {
      const shutdown = harness.shutdown ?? harness.close ?? harness.stop;
      if (typeof shutdown === 'function') {
        await shutdown();
      }
    }
  });
});

// ===========================================================================
// CYCLE 2 — state-persistence-and-recovery (T-075 through T-084)
// ===========================================================================

/**
 * Helper: extract the surfaced state warning from a runStart response. The
 * contract leaves the implementer free to put state warnings in
 * `response.warnings` (kind matched against /^state-/) or in a top-level
 * `response.stateWarning` slot (singular). We tolerate both shapes here so
 * the tests are not over-specified.
 */
function extractStateWarning(response: any): any | undefined {
  if (response && typeof response === 'object' && (response as any).stateWarning) {
    return (response as any).stateWarning;
  }
  if (response && Array.isArray((response as any).warnings)) {
    return (response as any).warnings.find(
      (w: any) =>
        w && typeof w.kind === 'string' && /^state-/.test(w.kind),
    );
  }
  return undefined;
}

function countStateWarnings(response: any): number {
  let count = 0;
  if (response && typeof response === 'object' && (response as any).stateWarning) count += 1;
  if (response && Array.isArray((response as any).warnings)) {
    for (const w of (response as any).warnings) {
      if (w && typeof w.kind === 'string' && /^state-/.test(w.kind)) count += 1;
    }
  }
  return count;
}

describe('start tool — cycle 2 state classifications', () => {
  // The fixture project root has no .sui-deepbook-course/ — we drive the
  // four classifications via the loadState mock instead of relying on disk
  // state. (Disk-based variants are exercised in tests/state.test.ts and
  // tests/harness.mcp.test.ts.)

  it('T-075: absent state → response.state === null with no state warning', async () => {
    stateMock.loadState.mockResolvedValueOnce({ kind: 'absent' });

    const response = await runStart({ projectRoot: REPO_ROOT });

    expect(response.state).toBeNull();
    expect(countStateWarnings(response)).toBe(0);
  });

  it('T-076: ok state → response.state surfaces the loaded State and no state warning', async () => {
    const loaded = {
      schema_version: 1,
      selected_path: '01-orderbook-viewer',
      personalization: { poll_interval_ms: 3000, pool_subset: 'both' },
      cursor: { phase_id: 'p2-retry', spot_id: 'p2-spot-1' },
      ladder: {
        'p1-spot-1': { hint_used: true, reference_shown: false, auto_completed: false },
      },
      history: [{ ts: '2026-04-28T12:00:00Z', event: 'start' }],
    };
    stateMock.loadState.mockResolvedValueOnce({ kind: 'ok', state: loaded });

    const response = await runStart({ projectRoot: REPO_ROOT });

    expect(response.state).toEqual(loaded);
    expect(countStateWarnings(response)).toBe(0);
  });

  it('T-077: corrupt state → response.state === null and a state-corrupt warning naming the archive', async () => {
    const archivedTo = '/tmp/fake-project/.sui-deepbook-course/state.corrupt-2026-04-28T12-00-00.123Z.json';
    stateMock.loadState.mockResolvedValueOnce({
      kind: 'corrupt',
      archivedTo,
      message: `State file was corrupt; archived original to ${archivedTo}.`,
    });

    const response = await runStart({ projectRoot: REPO_ROOT });

    expect(response.state).toBeNull();

    const warning = extractStateWarning(response);
    expect(warning).toBeTruthy();
    expect(warning.kind).toBe('state-corrupt');

    // The archive path must be reachable from the warning — either as a
    // first-class field or via the message body.
    const haystack = JSON.stringify(warning);
    expect(haystack).toContain(archivedTo);
  });

  it('T-078: schema-mismatch → response.state === null and a state-schema-mismatch warning that does NOT name an archive', async () => {
    stateMock.loadState.mockResolvedValueOnce({
      kind: 'schema-mismatch',
      foundVersion: 999,
      message:
        'State file has incompatible schema_version 999. Manual migration required.',
    });

    const response = await runStart({ projectRoot: REPO_ROOT });

    expect(response.state).toBeNull();

    const warning = extractStateWarning(response);
    expect(warning).toBeTruthy();
    expect(warning.kind).toBe('state-schema-mismatch');

    const haystack = JSON.stringify(warning);
    expect(haystack).toContain('999');
    // Must NOT name an archive path or carry an archivedTo field.
    expect(haystack).not.toMatch(/state\.corrupt-/);
    expect(warning.archivedTo).toBeUndefined();
  });

  it('T-079: outputStyleOk=false → loadState is NOT invoked', async () => {
    outputStyleMock.probeOutputStyle.mockResolvedValueOnce({
      ok: false,
      warning: { kind: 'settings-file-missing', message: 'absent' },
    });

    await runStart({ projectRoot: REPO_ROOT });

    expect(stateMock.loadState).not.toHaveBeenCalled();
  });

  it('T-080: outputStyleOk=false → no .sui-deepbook-course/ entries are created and no state archive is written (AC-1.3 preserved on the new surface)', async () => {
    // Use a temp project root with non-JSON state.json bytes seeded — the
    // implementer's start tool must NOT touch this directory at all when
    // outputStyleOk is false.
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sui-course-c2-zero-'));
    try {
      const stateDir = path.join(tempRoot, '.sui-deepbook-course');
      fs.mkdirSync(stateDir, { recursive: true });
      const stateFile = path.join(stateDir, 'state.json');
      const corruptBytes = '{ not json';
      fs.writeFileSync(stateFile, corruptBytes, 'utf8');

      // Force probe false.
      outputStyleMock.probeOutputStyle.mockResolvedValueOnce({
        ok: false,
        warning: { kind: 'settings-file-missing', message: 'absent' },
      });

      // Snapshot before.
      const before = (() => {
        const out: Array<{ rel: string; bytes: string }> = [];
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
                rel: path.relative(tempRoot, full),
                bytes: fs.readFileSync(full, 'utf8'),
              });
            }
          }
        }
        walk(tempRoot);
        out.sort((a, b) => a.rel.localeCompare(b.rel));
        return out;
      })();

      // Spy on every fs write surface that could touch .sui-deepbook-course/.
      const mkdirSpy = vi.spyOn(fs, 'mkdir');
      const mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync');
      const writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync');
      const writeFileSpy = vi.spyOn(fs, 'writeFile');
      const renameSpy = vi.spyOn(fs, 'rename');
      const renameSyncSpy = vi.spyOn(fs, 'renameSync');

      const promisesMkdirSpy = vi.spyOn(fsPromises, 'mkdir');
      const promisesWriteFileSpy = vi.spyOn(fsPromises, 'writeFile');
      const promisesRenameSpy = vi.spyOn(fsPromises, 'rename');

      const response = await runStart({ projectRoot: tempRoot });

      expect(response.outputStyleOk).toBe(false);
      expect(response.state).toBeNull();

      // Snapshot after — equality required.
      const after = (() => {
        const out: Array<{ rel: string; bytes: string }> = [];
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
                rel: path.relative(tempRoot, full),
                bytes: fs.readFileSync(full, 'utf8'),
              });
            }
          }
        }
        walk(tempRoot);
        out.sort((a, b) => a.rel.localeCompare(b.rel));
        return out;
      })();
      expect(after).toEqual(before);

      // No state.corrupt-* file was created.
      const archives = fs
        .readdirSync(stateDir, { withFileTypes: true })
        .filter((e) => e.isFile() && /^state\.corrupt-/.test(e.name));
      expect(archives).toEqual([]);

      // Spy assertions — every write surface must be untouched.
      expect(mkdirSpy).not.toHaveBeenCalled();
      expect(mkdirSyncSpy).not.toHaveBeenCalled();
      expect(writeFileSyncSpy).not.toHaveBeenCalled();
      expect(writeFileSpy).not.toHaveBeenCalled();
      expect(renameSpy).not.toHaveBeenCalled();
      expect(renameSyncSpy).not.toHaveBeenCalled();
      expect(promisesMkdirSpy).not.toHaveBeenCalled();
      expect(promisesWriteFileSpy).not.toHaveBeenCalled();
      expect(promisesRenameSpy).not.toHaveBeenCalled();
    } finally {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        /* swallow */
      }
    }
  });

  it('T-081: outputStyleOk=false → response.outputStyleOk=false and response.state=null', async () => {
    outputStyleMock.probeOutputStyle.mockResolvedValueOnce({
      ok: false,
      warning: { kind: 'settings-file-missing', message: 'absent' },
    });

    const response = await runStart({ projectRoot: REPO_ROOT });

    expect(response.outputStyleOk).toBe(false);
    expect(response.state).toBeNull();
    expect(stateMock.loadState).not.toHaveBeenCalled();
  });

  it("T-082: response top-level keys equal exactly cycle 1's set; state widens but no new top-level keys", async () => {
    stateMock.loadState.mockResolvedValueOnce({ kind: 'absent' });
    const absent = await runStart({ projectRoot: REPO_ROOT });
    expect(Object.keys(absent).sort()).toEqual([...EXPECTED_TOP_LEVEL_KEYS].sort());

    stateMock.loadState.mockResolvedValueOnce({
      kind: 'ok',
      state: {
        schema_version: 1,
        selected_path: '01-orderbook-viewer',
        personalization: { poll_interval_ms: 3000, pool_subset: 'both' },
        cursor: { phase_id: 'p1-bootstrap', spot_id: 'p1-spot-1' },
        ladder: {},
        history: [],
      },
    });
    const ok = await runStart({ projectRoot: REPO_ROOT });
    expect(Object.keys(ok).sort()).toEqual([...EXPECTED_TOP_LEVEL_KEYS].sort());
    expect(typeof ok.state).toBe('object');
    expect(ok.state).not.toBeNull();
  });

  it('T-083: corrupt vs schema-mismatch warning kinds are structurally distinct', async () => {
    const archivedTo = '/tmp/fake-archive-state.corrupt-2026-04-28T12-00-00.000Z.json';
    stateMock.loadState.mockResolvedValueOnce({
      kind: 'corrupt',
      archivedTo,
      message: `Corrupt; archived to ${archivedTo}.`,
    });
    const corruptResp = await runStart({ projectRoot: REPO_ROOT });

    stateMock.loadState.mockResolvedValueOnce({
      kind: 'schema-mismatch',
      foundVersion: 999,
      message: 'incompatible schema_version 999; manual migration required',
    });
    const schemaResp = await runStart({ projectRoot: REPO_ROOT });

    const cw = extractStateWarning(corruptResp);
    const sw = extractStateWarning(schemaResp);

    expect(cw).toBeTruthy();
    expect(sw).toBeTruthy();
    expect(cw.kind).toBe('state-corrupt');
    expect(sw.kind).toBe('state-schema-mismatch');
    expect(cw.kind).not.toBe(sw.kind);

    // Corrupt warning carries an archive reference.
    const cwHay = JSON.stringify(cw);
    expect(cwHay).toContain(archivedTo);

    // Schema-mismatch warning does NOT carry an archive reference.
    const swHay = JSON.stringify(sw);
    expect(swHay).not.toMatch(/state\.corrupt-/);

    // Schema-mismatch warning carries the offending version (999).
    expect(swHay).toContain('999');
  });

  it('T-084: corrupt response message matches /corrupt|archived/i; schema-mismatch matches /incompatible|migration/i; the two strings differ', async () => {
    const archivedTo = '/tmp/archive.json';
    const corruptMsg = `State file was corrupt; archived to ${archivedTo}.`;
    const schemaMsg = 'State file has incompatible schema_version 999. Manual migration required.';

    stateMock.loadState.mockResolvedValueOnce({
      kind: 'corrupt',
      archivedTo,
      message: corruptMsg,
    });
    const corruptResp = await runStart({ projectRoot: REPO_ROOT });

    stateMock.loadState.mockResolvedValueOnce({
      kind: 'schema-mismatch',
      foundVersion: 999,
      message: schemaMsg,
    });
    const schemaResp = await runStart({ projectRoot: REPO_ROOT });

    const cw = extractStateWarning(corruptResp);
    const sw = extractStateWarning(schemaResp);

    expect(cw).toBeTruthy();
    expect(sw).toBeTruthy();

    // Both surface the message string (somewhere in the warning's payload).
    const cwMessage = String(cw.message ?? JSON.stringify(cw));
    const swMessage = String(sw.message ?? JSON.stringify(sw));

    expect(cwMessage).toMatch(/corrupt|archived/i);
    expect(swMessage).toMatch(/incompatible|migration/i);
    expect(cwMessage).not.toBe(swMessage);
  });
});
