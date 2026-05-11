import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Spy-mode mocks for fs and child_process so vi.spyOn works on ESM namespaces.
vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });
vi.mock('node:child_process', { spy: true });

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

// Modules under test — none of these (in their cycle-3 shape) exist at red.
import { runPreflightProbe } from '../mcp/server/src/tools/runPreflightProbe.js';
import { registerTools } from '../mcp/server/src/index.js';
import * as preflight from '../mcp/server/src/preflight.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

let originalHome: string | undefined;
let originalDeployStub: string | undefined;
let originalEnvSnapshot: Record<string, string | undefined> = {};
let tempHome: string;
let tempRoots: string[] = [];

function makeTempRoot(prefix = 'sui-course-c3-rpp-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

/**
 * Build a fake child process emitting stdout/stderr lines and a close event
 * with the supplied exit code. If `neverClose` is true the close event is
 * never emitted (used by timeout test).
 */
function makeFakeChild(opts: {
  stdoutChunks?: string[];
  stderrChunks?: string[];
  exitCode?: number;
  neverClose?: boolean;
} = {}): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void; killed: boolean; pid: number } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
    killed: boolean;
    pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.pid = 12345;
  child.kill = () => {
    child.killed = true;
    // Emulate POSIX SIGTERM: emit close with non-zero code asynchronously.
    setImmediate(() => child.emit('close', null, 'SIGTERM'));
  };

  setImmediate(() => {
    for (const chunk of opts.stdoutChunks ?? []) {
      child.stdout.emit('data', Buffer.from(chunk));
    }
    for (const chunk of opts.stderrChunks ?? []) {
      child.stderr.emit('data', Buffer.from(chunk));
    }
    if (!opts.neverClose) {
      child.emit('close', opts.exitCode ?? 0);
    }
  });

  return child;
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sui-course-rpp-home-'));
  tempRoots.push(tempHome);
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;
  originalDeployStub = process.env.E2E_DEPLOY_STUB;
  delete process.env.E2E_DEPLOY_STUB;
  originalEnvSnapshot = {};
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalDeployStub === undefined) {
    delete process.env.E2E_DEPLOY_STUB;
  } else {
    process.env.E2E_DEPLOY_STUB = originalDeployStub;
  }
  // Restore any extra env vars cleared during a test.
  for (const [name, prior] of Object.entries(originalEnvSnapshot)) {
    if (prior === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = prior;
    }
  }
  originalEnvSnapshot = {};
  for (const dir of tempRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  }
  tempRoots = [];
});

function snapshotEnv(name: string): void {
  originalEnvSnapshot[name] = process.env[name];
}

// ---------------------------------------------------------------------------
// runPreflightProbe — handler + remediate gate
// ---------------------------------------------------------------------------

describe('runPreflightProbe — unknown probeId', () => {
  it('T-130: rejects unknown probeId without throwing uncaught', async () => {
    let threw = false;
    let result: unknown;
    try {
      result = await runPreflightProbe({ probeId: 'totally-fake' });
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(Error);
    }
    if (!threw) {
      const r = result as { pass?: boolean; message?: string };
      expect(r).toBeTruthy();
      expect(r.pass).toBe(false);
      expect(typeof r.message).toBe('string');
      expect(/unknown|invalid|not.*recognized/i.test(r.message ?? '')).toBe(true);
      expect(r.message).toContain('totally-fake');
    }
  });
});

describe('runPreflightProbe — return value plumbing', () => {
  it('T-131: returns underlying probe result for known probeId', async () => {
    vi.spyOn(preflight, 'runProbe').mockImplementation(async (id) => {
      if (id === 'docker-running') {
        return { pass: true, message: 'fixture' };
      }
      throw new Error(`unexpected probeId ${id}`);
    });

    const response = await runPreflightProbe({ probeId: 'docker-running' });
    expect(response.pass).toBe(true);
    expect(response.message).toBe('fixture');
    expect((response as { action?: unknown }).action).toBeUndefined();
  });

  it('T-132: remediate=true is a no-op when probe attaches no action', async () => {
    vi.spyOn(preflight, 'runProbe').mockImplementation(async () => ({
      pass: false,
      message: 'X',
    }));
    const spawnSpy = vi.spyOn(childProcess, 'spawn');

    const response = await runPreflightProbe({
      probeId: 'docker-running',
      remediate: true,
    });
    expect(response.pass).toBe(false);
    expect(response.message).toBe('X');
    expect((response as { action?: unknown }).action).toBeUndefined();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('T-133: remediate=false never invokes deploy executor even when action attached', async () => {
    vi.spyOn(preflight, 'runProbe').mockImplementation(async () => ({
      pass: false,
      message: 'manifest unreachable',
      action: {
        kind: 'shell',
        command: 'pnpm deploy-all --quick',
        cwd: '/x',
        timeoutMs: 420000,
      },
    }));
    const spawnSpy = vi.spyOn(childProcess, 'spawn');

    const response = await runPreflightProbe({
      probeId: 'sandbox-manifest-reachable',
      remediate: false,
    });
    expect(response.pass).toBe(false);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Precondition gates — A13
// ---------------------------------------------------------------------------

describe('runPreflightProbe — deploy precondition gating (A13)', () => {
  /**
   * Helper: stub runProbe so the manifest probe returns fail+action and each
   * named precondition probe returns the supplied {pass, message}.
   */
  function stubProbes(states: Partial<Record<string, { pass: boolean; message?: string }>>): void {
    vi.spyOn(preflight, 'runProbe').mockImplementation(async (probeId) => {
      if (probeId === 'sandbox-manifest-reachable') {
        return {
          pass: false,
          message: 'manifest unreachable',
          action: {
            kind: 'shell',
            command: 'pnpm deploy-all --quick',
            cwd: path.join(tempHome, 'workspace', 'deepbook-sandbox', 'sandbox'),
            timeoutMs: 420000,
          },
        };
      }
      const state = states[probeId];
      if (state) {
        return { pass: state.pass, message: state.message ?? '' };
      }
      // Default any unspecified probe to pass.
      return { pass: true, message: '' };
    });
  }

  it('T-134: gates real deploy on probe #1 docker-running passing', async () => {
    stubProbes({
      'docker-running': { pass: false, message: 'docker fail' },
      'sui-cli-version': { pass: true },
      'sandbox-repo-present': { pass: true },
    });
    const spawnSpy = vi.spyOn(childProcess, 'spawn');

    const response = await runPreflightProbe({
      probeId: 'sandbox-manifest-reachable',
      remediate: true,
    });
    expect(spawnSpy).not.toHaveBeenCalled();
    const warning = (response as { warning?: { kind?: string; probeId?: string; message?: string } }).warning;
    expect(warning).toBeTruthy();
    expect(warning!.kind).toBe('preflight-deploy-precondition-failed');
    const haystack = JSON.stringify(warning);
    expect(haystack).toContain('docker-running');
  });

  it('T-135: gates real deploy on probe #4 sui-cli-version passing', async () => {
    stubProbes({
      'docker-running': { pass: true },
      'sui-cli-version': { pass: false, message: '1.62.0 out of range' },
      'sandbox-repo-present': { pass: true },
    });
    const spawnSpy = vi.spyOn(childProcess, 'spawn');

    const response = await runPreflightProbe({
      probeId: 'sandbox-manifest-reachable',
      remediate: true,
    });
    expect(spawnSpy).not.toHaveBeenCalled();
    const warning = (response as { warning?: { kind?: string; probeId?: string } }).warning;
    expect(warning).toBeTruthy();
    expect(warning!.kind).toBe('preflight-deploy-precondition-failed');
    expect(JSON.stringify(warning)).toContain('sui-cli-version');
  });

  it('T-136: gates real deploy on probe #6 sandbox-repo-present passing', async () => {
    stubProbes({
      'docker-running': { pass: true },
      'sui-cli-version': { pass: true },
      'sandbox-repo-present': { pass: false, message: 'absent' },
    });
    const spawnSpy = vi.spyOn(childProcess, 'spawn');

    const response = await runPreflightProbe({
      probeId: 'sandbox-manifest-reachable',
      remediate: true,
    });
    expect(spawnSpy).not.toHaveBeenCalled();
    const warning = (response as { warning?: { kind?: string; probeId?: string } }).warning;
    expect(warning).toBeTruthy();
    expect(warning!.kind).toBe('preflight-deploy-precondition-failed');
    expect(JSON.stringify(warning)).toContain('sandbox-repo-present');
  });
});

// ---------------------------------------------------------------------------
// E2E_DEPLOY_STUB env-var routing — A14
// ---------------------------------------------------------------------------

describe("E2E_DEPLOY_STUB env-var routing (A14, A15)", () => {
  /**
   * Stub all probes so manifest fails with action and preconditions all pass.
   */
  function stubAllPass(): void {
    vi.spyOn(preflight, 'runProbe').mockImplementation(async (probeId) => {
      if (probeId === 'sandbox-manifest-reachable') {
        return {
          pass: false,
          message: 'manifest unreachable',
          action: {
            kind: 'shell',
            command: 'pnpm deploy-all --quick',
            cwd: path.join(tempHome, 'workspace', 'deepbook-sandbox', 'sandbox'),
            timeoutMs: 420000,
          },
        };
      }
      return { pass: true, message: '' };
    });
  }

  it('T-137: E2E_DEPLOY_STUB=1 routes to stub branch and never calls subprocess spawn', async () => {
    stubAllPass();
    process.env.E2E_DEPLOY_STUB = '1';

    const spawnSpy = vi.spyOn(childProcess, 'spawn');
    const spawnSyncSpy = vi.spyOn(childProcess, 'spawnSync');
    const execFileSpy = vi.spyOn(childProcess, 'execFile');

    await runPreflightProbe({
      probeId: 'sandbox-manifest-reachable',
      remediate: true,
    });

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(spawnSyncSpy).not.toHaveBeenCalled();
    expect(execFileSpy).not.toHaveBeenCalled();
  });

  it('T-138: E2E_DEPLOY_STUB=1 stub branch returns a deterministic well-formed result', async () => {
    stubAllPass();
    process.env.E2E_DEPLOY_STUB = '1';

    const response = await runPreflightProbe({
      probeId: 'sandbox-manifest-reachable',
      remediate: true,
    });
    expect(typeof response.pass).toBe('boolean');
    expect(typeof response.message).toBe('string');
    expect(response.message.length).toBeGreaterThan(0);
  });

  it('T-139: E2E_DEPLOY_STUB=\'true\' (any non-\'1\' value) takes the real branch', async () => {
    stubAllPass();
    process.env.E2E_DEPLOY_STUB = 'true';

    const fakeChild = makeFakeChild({ exitCode: 0 });
    const spawnSpy = vi
      .spyOn(childProcess, 'spawn')
      .mockImplementation(() => fakeChild as unknown as childProcess.ChildProcess);

    await runPreflightProbe({
      probeId: 'sandbox-manifest-reachable',
      remediate: true,
    });

    expect(spawnSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('T-140: similar env vars (E2E_DEPLOY=1, E2E_DEPLOY_STUB_=1, etc.) do NOT enter the stub branch', async () => {
    const candidates = ['E2E_DEPLOY', 'E2E_DEPLOY_STUB_', 'DEPLOY_STUB', 'E2E_STUB'];
    for (const name of candidates) {
      stubAllPass();
      snapshotEnv(name);
      process.env[name] = '1';

      const fakeChild = makeFakeChild({ exitCode: 0 });
      const spawnSpy = vi
        .spyOn(childProcess, 'spawn')
        .mockImplementation(() => fakeChild as unknown as childProcess.ChildProcess);

      await runPreflightProbe({
        probeId: 'sandbox-manifest-reachable',
        remediate: true,
      });

      expect(
        spawnSpy.mock.calls.length,
        `expected real spawn for env var ${name}=1, but got 0 calls`,
      ).toBeGreaterThanOrEqual(1);

      // Restore for next iteration
      delete process.env[name];
      vi.restoreAllMocks();
    }
  });
});

describe('E2E_DEPLOY_STUB source greps (A14)', () => {
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
        if (entry.name === 'node_modules') continue;
        walkTs(full, out);
      } else if (entry.isFile() && full.endsWith('.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it("T-141: only one env-var name 'E2E_DEPLOY_STUB' appears in mcp/server/src/", () => {
    const srcRoot = path.resolve(__dirname, '../mcp/server/src');
    const files = walkTs(srcRoot);
    const found = new Set<string>();
    for (const f of files) {
      const content = fs.readFileSync(f, 'utf8');
      const matches = content.match(/E2E_[A-Z_]+/g);
      if (matches) {
        for (const m of matches) found.add(m);
      }
    }
    expect([...found].sort()).toEqual(['E2E_DEPLOY_STUB']);
  });

  it("T-142: 'E2E_DEPLOY_STUB' literal appears in exactly one source file (manifest.ts)", () => {
    const srcRoot = path.resolve(__dirname, '../mcp/server/src');
    const files = walkTs(srcRoot);
    const offenders: string[] = [];
    for (const f of files) {
      const content = fs.readFileSync(f, 'utf8');
      if (content.includes('E2E_DEPLOY_STUB')) {
        offenders.push(f);
      }
    }
    expect(offenders.length).toBe(1);
    expect(path.basename(offenders[0])).toBe('manifest.ts');
    expect(offenders[0]).toContain(path.join('probes', 'manifest.ts'));
  });
});

// ---------------------------------------------------------------------------
// Real-branch deploy executor — A15, A16
// ---------------------------------------------------------------------------

describe('real-branch deploy executor (A15, A16)', () => {
  function stubAllPassWithCwd(cwd: string): void {
    vi.spyOn(preflight, 'runProbe').mockImplementation(async (probeId) => {
      if (probeId === 'sandbox-manifest-reachable') {
        return {
          pass: false,
          message: 'manifest unreachable',
          action: {
            kind: 'shell',
            command: 'pnpm deploy-all --quick',
            cwd,
            timeoutMs: 420000,
          },
        };
      }
      return { pass: true, message: '' };
    });
  }

  it('T-143: real branch (env unset) spawns pnpm deploy-all --quick with the resolved sandbox cwd and 7-minute timeout', async () => {
    delete process.env.E2E_DEPLOY_STUB;
    fs.mkdirSync(path.join(tempHome, 'workspace', 'deepbook-sandbox', 'sandbox'), {
      recursive: true,
    });
    const sandboxCwd = path.join(tempHome, 'workspace', 'deepbook-sandbox', 'sandbox');
    stubAllPassWithCwd(sandboxCwd);

    const fakeChild = makeFakeChild({ exitCode: 0 });
    const spawnSpy = vi
      .spyOn(childProcess, 'spawn')
      .mockImplementation(() => fakeChild as unknown as childProcess.ChildProcess);

    // Stub fetch so post-spawn manifest re-probe returns 200 quickly.
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '{}',
    }));
    vi.stubGlobal('fetch', fetchSpy);

    await runPreflightProbe({
      probeId: 'sandbox-manifest-reachable',
      remediate: true,
    });

    expect(spawnSpy).toHaveBeenCalled();
    const call = spawnSpy.mock.calls[0];
    expect(call[0]).toBe('pnpm');
    expect(Array.isArray(call[1])).toBe(true);
    expect(call[1]![0]).toBe('deploy-all');
    expect(call[1]![1]).toBe('--quick');

    const opts = call[2] as { cwd?: string; timeout?: number };
    expect(typeof opts).toBe('object');
    const cwd = opts.cwd ?? '';
    expect(
      cwd.endsWith(path.join('deepbook-sandbox', 'sandbox')) ||
        cwd.endsWith(path.join('deepbook-sandbox', 'sandbox') + path.sep),
    ).toBe(true);
  });

  it('T-144: real branch streams stdout/stderr lines back through the tool response', async () => {
    delete process.env.E2E_DEPLOY_STUB;
    const sandboxCwd = path.join(tempHome, 'workspace', 'deepbook-sandbox', 'sandbox');
    fs.mkdirSync(sandboxCwd, { recursive: true });
    stubAllPassWithCwd(sandboxCwd);

    const fakeChild = makeFakeChild({
      stdoutChunks: ['line-a\nline-b\n'],
      stderrChunks: ['err-c\n'],
      exitCode: 0,
    });
    vi.spyOn(childProcess, 'spawn').mockImplementation(
      () => fakeChild as unknown as childProcess.ChildProcess,
    );
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '{}',
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const response = await runPreflightProbe({
      probeId: 'sandbox-manifest-reachable',
      remediate: true,
    });

    const lines: string[] =
      (response as { logs?: string[]; lines?: string[] }).logs ??
      (response as { logs?: string[]; lines?: string[] }).lines ??
      [];
    const haystack = lines.join('\n');
    expect(haystack).toContain('line-a');
    expect(haystack).toContain('line-b');
    expect(haystack).toContain('err-c');

    // Order preservation: 'line-a' before 'line-b'
    const idxA = lines.findIndex((l) => l.includes('line-a'));
    const idxB = lines.findIndex((l) => l.includes('line-b'));
    expect(idxA).toBeLessThan(idxB);
  });

  it('T-145: real branch enforces 7-minute hard timeout and surfaces preflight-deploy-timeout warning', async () => {
    delete process.env.E2E_DEPLOY_STUB;
    const sandboxCwd = path.join(tempHome, 'workspace', 'deepbook-sandbox', 'sandbox');
    fs.mkdirSync(sandboxCwd, { recursive: true });
    stubAllPassWithCwd(sandboxCwd);

    vi.useFakeTimers();
    const fakeChild = makeFakeChild({
      stdoutChunks: ['starting deploy\n'],
      neverClose: true,
    });
    vi.spyOn(childProcess, 'spawn').mockImplementation(
      () => fakeChild as unknown as childProcess.ChildProcess,
    );
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const promise = runPreflightProbe({
      probeId: 'sandbox-manifest-reachable',
      remediate: true,
    });

    // Advance past the 7-minute timeout.
    await vi.advanceTimersByTimeAsync(420001);
    // Allow the kill->close handler chain to flush.
    await vi.runAllTimersAsync();

    const response = await promise;

    const warning =
      (response as { warning?: { kind?: string; message?: string } }).warning;
    expect(warning).toBeTruthy();
    expect(warning!.kind).toBe('preflight-deploy-timeout');
    const msg = warning!.message ?? '';
    expect(msg).toContain('pnpm down');
  });

  it('T-146: after spawn (success exit), manifest probe re-runs up to three times before classifying final stop', async () => {
    delete process.env.E2E_DEPLOY_STUB;
    const sandboxCwd = path.join(tempHome, 'workspace', 'deepbook-sandbox', 'sandbox');
    fs.mkdirSync(sandboxCwd, { recursive: true });
    stubAllPassWithCwd(sandboxCwd);

    const fakeChild = makeFakeChild({ exitCode: 0 });
    vi.spyOn(childProcess, 'spawn').mockImplementation(
      () => fakeChild as unknown as childProcess.ChildProcess,
    );

    let fetchCallCount = 0;
    const fetchSpy = vi.fn(async () => {
      fetchCallCount += 1;
      return {
        ok: false,
        status: 503,
        json: async () => ({}),
        text: async () => '',
      };
    });
    vi.stubGlobal('fetch', fetchSpy);

    const response = await runPreflightProbe({
      probeId: 'sandbox-manifest-reachable',
      remediate: true,
    });

    // Exactly 3 re-probes after spawn (the initial probe was the stubbed
    // runProbe call — fetch was not called for it). So fetch count === 3.
    expect(fetchCallCount).toBe(3);
    expect(response.pass).toBe(false);
    const haystack = JSON.stringify(response);
    expect(haystack).toContain('pnpm down');
  });

  it('T-147: after spawn, manifest re-probe stops on first 200 within the 3-attempt budget', async () => {
    delete process.env.E2E_DEPLOY_STUB;
    const sandboxCwd = path.join(tempHome, 'workspace', 'deepbook-sandbox', 'sandbox');
    fs.mkdirSync(sandboxCwd, { recursive: true });
    stubAllPassWithCwd(sandboxCwd);

    const fakeChild = makeFakeChild({ exitCode: 0 });
    vi.spyOn(childProcess, 'spawn').mockImplementation(
      () => fakeChild as unknown as childProcess.ChildProcess,
    );

    let fetchCallCount = 0;
    const fetchSpy = vi.fn(async () => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) {
        return {
          ok: false,
          status: 503,
          json: async () => ({}),
          text: async () => '',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '{}',
      };
    });
    vi.stubGlobal('fetch', fetchSpy);

    const response = await runPreflightProbe({
      probeId: 'sandbox-manifest-reachable',
      remediate: true,
    });

    expect(fetchCallCount).toBe(2);
    expect(response.pass).toBe(true);
  });

  it('T-179: real branch resolves with pass:false when child emits error event (does NOT hang)', async () => {
    // Cycle-3 review H001 regression: runRealDeploy registered only
    // child.on('close', ...). A spawn-time ENOENT (e.g. pnpm not on PATH)
    // fires 'error' instead of 'close', so the promise never resolves and
    // hangs the entire MCP request for the full 7-minute SIGTERM window.
    delete process.env.E2E_DEPLOY_STUB;
    const sandboxCwd = path.join(tempHome, 'workspace', 'deepbook-sandbox', 'sandbox');
    fs.mkdirSync(sandboxCwd, { recursive: true });
    stubAllPassWithCwd(sandboxCwd);

    // Build a fake child that fires 'error' (no 'close'). Without the fix,
    // this hangs.
    const errChild = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
      killed: boolean;
      pid: number;
    };
    errChild.stdout = new EventEmitter();
    errChild.stderr = new EventEmitter();
    errChild.killed = false;
    errChild.pid = 99999;
    errChild.kill = () => {
      errChild.killed = true;
    };
    setImmediate(() => {
      const err = Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' });
      errChild.emit('error', err);
    });

    vi.spyOn(childProcess, 'spawn').mockImplementation(
      () => errChild as unknown as childProcess.ChildProcess,
    );

    // Bound the assertion: the response must arrive within 5s, NOT 7 minutes.
    const timeoutGuard = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('runPreflightProbe hung — error handler missing')), 5000),
    );

    const response = (await Promise.race([
      runPreflightProbe({ probeId: 'sandbox-manifest-reachable', remediate: true }),
      timeoutGuard,
    ])) as { pass?: boolean; message?: string };

    expect(response.pass).toBe(false);
    expect(typeof response.message).toBe('string');
    // Message should mention the spawn failure or error in some form.
    expect(response.message!.toLowerCase()).toMatch(/error|fail|spawn|enoent/);
  }, 10000);
});

// ---------------------------------------------------------------------------
// Source-level invariants — A12, A17, A21
// ---------------------------------------------------------------------------

describe('shell-action surface guards (A12, A17)', () => {
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
        if (entry.name === 'node_modules') continue;
        walkTs(full, out);
      } else if (entry.isFile() && full.endsWith('.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it("T-148: runPreflightProbe is the only tool whose source contains kind:'shell' literal", () => {
    const toolsRoot = path.resolve(__dirname, '../mcp/server/src/tools');
    const files = walkTs(toolsRoot);
    const offenders: string[] = [];
    for (const f of files) {
      const content = fs.readFileSync(f, 'utf8');
      if (/kind\s*:\s*['"]shell['"]/.test(content)) {
        offenders.push(f);
      }
    }
    expect(offenders.length).toBe(1);
    expect(path.basename(offenders[0])).toBe('runPreflightProbe.ts');
  });

  it("T-149: start.ts source still contains zero kind:'shell' literals (cycle 1 A14/A16)", () => {
    const sourcePath = path.resolve(__dirname, '../mcp/server/src/tools/start.ts');
    const content = fs.readFileSync(sourcePath, 'utf8');
    expect(/kind\s*:\s*'shell'/.test(content)).toBe(false);
    expect(/kind\s*:\s*"shell"/.test(content)).toBe(false);
  });

  it('T-150: registerTools registers runPreflightProbe alongside start', () => {
    const registered: string[] = [];
    const stubServer = {
      tool: (name: string, ..._rest: unknown[]) => {
        registered.push(name);
      },
      registerTool: (name: string, ..._rest: unknown[]) => {
        registered.push(name);
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => registerTools(stubServer as any)).not.toThrow();
    expect(registered).toContain('start');
    expect(registered).toContain('runPreflightProbe');
  });

  it("T-151: engine source outside paths/ and tests/fixtures/ contains zero '01-orderbook-viewer' literals", () => {
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
          if (entry.name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name);
        if (!ALLOWED_EXTS.has(ext)) continue;
        const content = fs.readFileSync(full, 'utf8');
        if (content.indexOf(SLUG) !== -1) {
          offenders.push(full);
        }
      }
    }
    for (const root of SCAN_ROOTS) walk(root);
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cycle-5 carry-forward: R3-005 (checkManifest fetch has AbortSignal.timeout)
// ---------------------------------------------------------------------------

describe('checkManifest — fetch timeout (A15)', () => {
  it('T-082: fetch is called with an AbortSignal that aborts within ~5s on a never-resolving server', async () => {
    // Stub global fetch with a never-resolving promise that does respect the
    // abort signal (rejects with AbortError when signal aborts).
    let capturedSignal: AbortSignal | undefined;
    const fetchSpy = vi.fn(async (_url: any, init?: any) => {
      capturedSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        if (init?.signal) {
          (init.signal as AbortSignal).addEventListener('abort', () => {
            const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
            reject(err);
          });
        }
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const start = Date.now();
    const response = await runPreflightProbe({ probeId: 'sandbox-manifest-reachable' });
    const elapsed = Date.now() - start;

    expect(fetchSpy).toHaveBeenCalled();
    expect(capturedSignal).toBeTruthy();
    // The signal eventually aborts.
    expect(capturedSignal!.aborted).toBe(true);
    // Probe completes within 6s and surfaces { pass: false }.
    expect(elapsed).toBeLessThan(6500);
    expect(elapsed).toBeGreaterThanOrEqual(4000);
    expect((response as any).pass).toBe(false);
  }, 10000);

  it('T-083: a never-resolving fetch is bounded by the timeout — probe returns within 6s', async () => {
    const fetchSpy = vi.fn(async (_url: any, init?: any) => {
      return new Promise((_resolve, reject) => {
        if (init?.signal) {
          (init.signal as AbortSignal).addEventListener('abort', () => {
            const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
            reject(err);
          });
        }
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const timeoutGuard = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('checkManifest hung — no fetch timeout')), 7000),
    );
    const response = (await Promise.race([
      runPreflightProbe({ probeId: 'sandbox-manifest-reachable' }),
      timeoutGuard,
    ])) as { pass?: boolean };
    expect(response.pass).toBe(false);
  }, 10000);

  it('T-084: happy path is unaffected — fetch returning 200 quickly still yields pass:true', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '{}',
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const response = (await runPreflightProbe({ probeId: 'sandbox-manifest-reachable' })) as {
      pass?: boolean;
    };
    expect(response.pass).toBe(true);
  });
});
