import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });
vi.mock('node:child_process', { spy: true });

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { bootHarness } from '../scripts/e2e/harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Docker-availability gate for T-157 (E-008).
// ---------------------------------------------------------------------------

const dockerAvailable: boolean = (() => {
  try {
    const result = spawnSync('docker', ['info'], {
      stdio: 'ignore',
      timeout: 5000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

let originalHome: string | undefined;
let originalDeployStub: string | undefined;
let tempHome: string;
let tempRoots: string[] = [];

function makeTempRoot(prefix = 'sui-course-c3-harness-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writeSettings(content: string): void {
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), content, 'utf8');
}

function parseTextResult(result: unknown): {
  pass?: boolean;
  message?: string;
  warning?: { kind?: string; probeId?: string; message?: string };
  action?: { kind?: string; command?: string; cwd?: string };
} {
  expect(result).toBeTruthy();
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  expect(Array.isArray(r.content)).toBe(true);
  expect(r.content!.length).toBeGreaterThan(0);
  expect(r.content![0].type).toBe('text');
  expect(typeof r.content![0].text).toBe('string');
  return JSON.parse(r.content![0].text!);
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sui-course-harness-home-'));
  tempRoots.push(tempHome);
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;
  originalDeployStub = process.env.E2E_DEPLOY_STUB;
  delete process.env.E2E_DEPLOY_STUB;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
// Probe-ordering tests via the harness — A11, A1
// ---------------------------------------------------------------------------

describe('harness preflight ordering', () => {
  it('T-152: early stop on probe #1 docker fail (subsequent probes not invoked)', async () => {
    const projectRoot = makeTempRoot();

    const harness = (await bootHarness({ projectRoot })) as {
      callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
      runPreflightProbe?: (probeId: string, opts?: Record<string, unknown>) => Promise<unknown>;
      withDockerStub?: (opts: { exitCode: number }) => Promise<void> | void;
      shutdown: () => Promise<void>;
    };
    try {
      // Apply docker-fail fixture if available; otherwise stub via probes.
      if (typeof harness.withDockerStub === 'function') {
        await harness.withDockerStub({ exitCode: 1 });
      }

      const invoked: string[] = [];
      const PROBE_ORDER = [
        'docker-running',
        'node-version',
        'pnpm-available',
        'sui-cli-version',
        'sui-pilot-enabled',
        'sandbox-repo-present',
        'sandbox-manifest-reachable',
        'learning-output-style-enabled',
      ];
      let stopped = false;
      for (const probeId of PROBE_ORDER) {
        if (stopped) break;
        const r = parseTextResult(
          await harness.callTool('runPreflightProbe', { probeId }),
        );
        invoked.push(probeId);
        if (probeId === 'docker-running' && r.pass === false) {
          stopped = true;
        }
      }
      expect(invoked).toEqual(['docker-running']);
    } finally {
      await harness.shutdown();
    }
  });

  it('T-153: all-pass scenario runs all 8 probes in spec order', async () => {
    const projectRoot = makeTempRoot();
    // Make all probes pass:
    fs.mkdirSync(path.join(tempHome, 'workspace', 'deepbook-sandbox'), {
      recursive: true,
    });
    writeSettings(
      JSON.stringify({
        enabledPlugins: {
          'sui-pilot@local': true,
          'learning-output-style@claude-plugins-official': true,
        },
      }),
    );

    const harness = (await bootHarness({ projectRoot })) as {
      callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
      shutdown: () => Promise<void>;
    };
    try {
      const PROBE_ORDER = [
        'docker-running',
        'node-version',
        'pnpm-available',
        'sui-cli-version',
        'sui-pilot-enabled',
        'sandbox-repo-present',
        'sandbox-manifest-reachable',
        'learning-output-style-enabled',
      ];
      const invoked: string[] = [];
      for (const probeId of PROBE_ORDER) {
        const r = parseTextResult(
          await harness.callTool('runPreflightProbe', { probeId }),
        );
        invoked.push(probeId);
        // Don't assert pass here — depends on the host environment; this test
        // asserts ORDER, not outcomes. (Order is the load-bearing invariant.)
        expect(typeof r.pass).toBe('boolean');
      }
      expect(invoked).toEqual(PROBE_ORDER);
    } finally {
      await harness.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// E2E scenarios — E-003, E-007, E-009, E-010, E-011
// ---------------------------------------------------------------------------

describe('E-003: sui-pilot disabled', () => {
  it('T-154: probe #5 fails with the activation hint', async () => {
    const projectRoot = makeTempRoot();
    writeSettings(
      JSON.stringify({
        enabledPlugins: {
          'sui-pilot@local': false,
          'learning-output-style@claude-plugins-official': true,
        },
      }),
    );

    const harness = (await bootHarness({ projectRoot })) as {
      callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
      shutdown: () => Promise<void>;
    };
    try {
      const r = parseTextResult(
        await harness.callTool('runPreflightProbe', { probeId: 'sui-pilot-enabled' }),
      );
      expect(r.pass).toBe(false);
      expect(r.message).toContain('claude plugins enable sui-pilot');
    } finally {
      await harness.shutdown();
    }
  });
});

describe('E-007: manifest unreachable + deploy stub', () => {
  it('T-155: deploy stub exits 0 but no manifest comes up → 3 re-probes fail → stop with logs and pnpm down', async () => {
    const projectRoot = makeTempRoot();
    fs.mkdirSync(path.join(tempHome, 'workspace', 'deepbook-sandbox', 'sandbox'), {
      recursive: true,
    });
    writeSettings(
      JSON.stringify({
        enabledPlugins: {
          'sui-pilot@local': true,
          'learning-output-style@claude-plugins-official': true,
        },
      }),
    );
    process.env.E2E_DEPLOY_STUB = '1';

    // Force fetch to keep returning 503.
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const harness = (await bootHarness({ projectRoot })) as {
      callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
      withDeployStub?: (opts: { exitCode: number; exposeManifest: boolean }) => Promise<void> | void;
      shutdown: () => Promise<void>;
    };
    try {
      if (typeof harness.withDeployStub === 'function') {
        await harness.withDeployStub({ exitCode: 0, exposeManifest: false });
      }
      const r = parseTextResult(
        await harness.callTool('runPreflightProbe', {
          probeId: 'sandbox-manifest-reachable',
          remediate: true,
        }),
      );
      expect(r.pass).toBe(false);
      const haystack = JSON.stringify(r);
      expect(haystack).toContain('pnpm down');
    } finally {
      await harness.shutdown();
    }
  });

  it('T-156: deploy-stub branch never spawns a real subprocess', async () => {
    const projectRoot = makeTempRoot();
    fs.mkdirSync(path.join(tempHome, 'workspace', 'deepbook-sandbox', 'sandbox'), {
      recursive: true,
    });
    writeSettings(
      JSON.stringify({
        enabledPlugins: {
          'sui-pilot@local': true,
          'learning-output-style@claude-plugins-official': true,
        },
      }),
    );
    process.env.E2E_DEPLOY_STUB = '1';

    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const spawnSpy = vi.spyOn(childProcess, 'spawn');

    const harness = (await bootHarness({ projectRoot })) as {
      callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
      withDeployStub?: (opts: { exitCode: number; exposeManifest: boolean }) => Promise<void> | void;
      shutdown: () => Promise<void>;
    };
    try {
      // The deploy-stub fixture must exist for this scenario to be meaningful.
      // Without it, the spawn-not-called assertion would pass vacuously (the
      // tool simply isn't wired). Tighten the test by requiring the fixture.
      expect(typeof harness.withDeployStub).toBe('function');
      await harness.withDeployStub!({ exitCode: 0, exposeManifest: false });

      const r = parseTextResult(
        await harness.callTool('runPreflightProbe', {
          probeId: 'sandbox-manifest-reachable',
          remediate: true,
        }),
      );
      // The stub must have fired and produced a structured response (well-formed
      // pass/message); the deploy executor branched into the stub instead of
      // spawning a real subprocess.
      expect(typeof r.pass).toBe('boolean');
      expect(typeof r.message).toBe('string');
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      await harness.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// T-157: E-008 real Docker deploy — gated
// ---------------------------------------------------------------------------

describe.skipIf(!dockerAvailable)('E-008: real deploy-all --quick (Docker-gated)', () => {
  it('T-157: real deploy brings up manifest; teardown runs pnpm down', async () => {
    // Real-environment integration. This block is skipped when Docker is not
    // available locally. The orchestrator's red gate does not require Docker.
    const projectRoot = makeTempRoot();
    delete process.env.E2E_DEPLOY_STUB;
    // Use the real ~/workspace/deepbook-sandbox checkout (not tempHome).
    if (originalHome) {
      process.env.HOME = originalHome;
    }
    writeSettings(
      JSON.stringify({
        enabledPlugins: {
          'sui-pilot@local': true,
          'learning-output-style@claude-plugins-official': true,
        },
      }),
    );

    const harness = (await bootHarness({ projectRoot })) as {
      callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
      shutdown: () => Promise<void>;
    };
    try {
      const r = parseTextResult(
        await harness.callTool('runPreflightProbe', {
          probeId: 'sandbox-manifest-reachable',
          remediate: true,
        }),
      );
      expect(r.pass).toBe(true);
    } finally {
      // Teardown — best-effort `pnpm down`.
      try {
        const sandbox = path.join(
          originalHome ?? process.env.HOME ?? '',
          'workspace/deepbook-sandbox/sandbox',
        );
        spawnSync('pnpm', ['down'], { cwd: sandbox, stdio: 'ignore', timeout: 60000 });
      } catch {
        /* swallow */
      }
      await harness.shutdown();
    }
  }, 8 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// E-009: sandbox repo absent
// ---------------------------------------------------------------------------

describe('E-009: sandbox repo absent', () => {
  it('T-158: probe #6 fails with clone command; no deploy attempted', async () => {
    const projectRoot = makeTempRoot();
    // tempHome has no workspace dir (probe #6 fails ENOENT).
    writeSettings(
      JSON.stringify({
        enabledPlugins: {
          'sui-pilot@local': true,
          'learning-output-style@claude-plugins-official': true,
        },
      }),
    );

    const harness = (await bootHarness({ projectRoot })) as {
      callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
      shutdown: () => Promise<void>;
    };
    try {
      const r6 = parseTextResult(
        await harness.callTool('runPreflightProbe', { probeId: 'sandbox-repo-present' }),
      );
      expect(r6.pass).toBe(false);
      expect(r6.message).toContain(
        'git clone --recurse-submodules https://github.com/MystenLabs/deepbook-sandbox.git',
      );

      const spawnSpy = vi.spyOn(childProcess, 'spawn');
      const r7 = parseTextResult(
        await harness.callTool('runPreflightProbe', {
          probeId: 'sandbox-manifest-reachable',
          remediate: true,
        }),
      );
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(r7.warning).toBeTruthy();
      expect(r7.warning!.kind).toBe('preflight-deploy-precondition-failed');
    } finally {
      await harness.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// E-010: Docker not running
// ---------------------------------------------------------------------------

describe('E-010: Docker not running', () => {
  it('T-159: probe #1 fails as stop, no deploy attempted', async () => {
    const projectRoot = makeTempRoot();
    fs.mkdirSync(path.join(tempHome, 'workspace', 'deepbook-sandbox', 'sandbox'), {
      recursive: true,
    });
    writeSettings(
      JSON.stringify({
        enabledPlugins: {
          'sui-pilot@local': true,
          'learning-output-style@claude-plugins-official': true,
        },
      }),
    );

    const harness = (await bootHarness({ projectRoot })) as {
      callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
      withDockerStub?: (opts: { exitCode: number }) => Promise<void> | void;
      shutdown: () => Promise<void>;
    };
    try {
      if (typeof harness.withDockerStub === 'function') {
        await harness.withDockerStub({ exitCode: 1 });
      }
      const r1 = parseTextResult(
        await harness.callTool('runPreflightProbe', { probeId: 'docker-running' }),
      );
      expect(r1.pass).toBe(false);
      expect(r1.message).toContain('Docker Desktop is not running');

      const spawnSpy = vi.spyOn(childProcess, 'spawn');
      const r7 = parseTextResult(
        await harness.callTool('runPreflightProbe', {
          probeId: 'sandbox-manifest-reachable',
          remediate: true,
        }),
      );
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(r7.warning).toBeTruthy();
      expect(r7.warning!.kind).toBe('preflight-deploy-precondition-failed');
      expect(JSON.stringify(r7.warning)).toContain('docker-running');
    } finally {
      await harness.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// E-011: Sui CLI 1.62.0
// ---------------------------------------------------------------------------

describe('E-011: unsupported Sui CLI version', () => {
  it('T-160: probe #4 fails as guided stop with brew install hint', async () => {
    const projectRoot = makeTempRoot();
    writeSettings(
      JSON.stringify({
        enabledPlugins: {
          'sui-pilot@local': true,
          'learning-output-style@claude-plugins-official': true,
        },
      }),
    );

    const harness = (await bootHarness({ projectRoot })) as {
      callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
      withSuiCliStub?: (opts: { version: string }) => Promise<void> | void;
      shutdown: () => Promise<void>;
    };
    try {
      if (typeof harness.withSuiCliStub === 'function') {
        await harness.withSuiCliStub({ version: '1.62.0' });
      }
      let threw = false;
      let r: ReturnType<typeof parseTextResult> | undefined;
      try {
        r = parseTextResult(
          await harness.callTool('runPreflightProbe', { probeId: 'sui-cli-version' }),
        );
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(r).toBeTruthy();
      expect(r!.pass).toBe(false);
      // Phase F round-2 M001: scenario E-011 mandates exact phrasing
      // "Sui CLI <version> is outside the supported range" (no "version" word
      // between "Sui CLI" and the literal). suiCli.ts:48 was rephrased to
      // match; this assertion is now strict to lock in the spec wording.
      expect(r!.message).toContain('Sui CLI 1.62.0 is outside the supported range');
      expect(r!.message).toContain('brew install sui');
    } finally {
      await harness.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// Harness API surface — A21
// ---------------------------------------------------------------------------

describe('harness API surface', () => {
  it('T-161: exposes runPreflightProbe convenience wrapper that delegates to callTool', async () => {
    const projectRoot = makeTempRoot();
    const harness = (await bootHarness({ projectRoot })) as {
      callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
      runPreflightProbe?: (probeId: string, opts?: Record<string, unknown>) => Promise<unknown>;
      shutdown: () => Promise<void>;
    };
    try {
      expect(typeof harness.runPreflightProbe).toBe('function');

      // Spy on the harness's callTool to confirm the wrapper delegates.
      const callToolSpy = vi.spyOn(harness, 'callTool');
      await harness.runPreflightProbe!('node-version');
      expect(callToolSpy).toHaveBeenCalled();
      const firstCall = callToolSpy.mock.calls[0];
      expect(firstCall[0]).toBe('runPreflightProbe');
      expect((firstCall[1] as { probeId?: string }).probeId).toBe('node-version');
    } finally {
      await harness.shutdown();
    }
  });

  it('T-162: withDeployStub sets and unsets E2E_DEPLOY_STUB within its lifecycle', async () => {
    const projectRoot = makeTempRoot();
    expect(process.env.E2E_DEPLOY_STUB).toBeUndefined();

    const harness = (await bootHarness({ projectRoot })) as {
      withDeployStub?: (opts: { exitCode: number; exposeManifest: boolean }) => Promise<{
        cleanup: () => Promise<void> | void;
      }>;
      shutdown: () => Promise<void>;
    };
    try {
      expect(typeof harness.withDeployStub).toBe('function');

      const fixture = await harness.withDeployStub!({ exitCode: 0, exposeManifest: false });
      expect(process.env.E2E_DEPLOY_STUB).toBe('1');

      await fixture.cleanup();
      expect(process.env.E2E_DEPLOY_STUB).toBeUndefined();
    } finally {
      await harness.shutdown();
    }
  });

  it('T-163: real-deploy fixtures (withDockerStub, withSuiCliStub, withSandboxRepoAbsent) do NOT set E2E_DEPLOY_STUB', async () => {
    const projectRoot = makeTempRoot();
    delete process.env.E2E_DEPLOY_STUB;

    const harness = (await bootHarness({ projectRoot })) as {
      withDockerStub?: (opts: { exitCode: number }) => Promise<unknown>;
      withSuiCliStub?: (opts: { version: string }) => Promise<unknown>;
      withSandboxRepoAbsent?: () => Promise<unknown>;
      shutdown: () => Promise<void>;
    };
    try {
      if (typeof harness.withDockerStub === 'function') {
        await harness.withDockerStub({ exitCode: 1 });
        expect(process.env.E2E_DEPLOY_STUB).toBeUndefined();
      }
      if (typeof harness.withSuiCliStub === 'function') {
        await harness.withSuiCliStub({ version: '1.62.0' });
        expect(process.env.E2E_DEPLOY_STUB).toBeUndefined();
      }
      if (typeof harness.withSandboxRepoAbsent === 'function') {
        await harness.withSandboxRepoAbsent();
        expect(process.env.E2E_DEPLOY_STUB).toBeUndefined();
      }
      // At least one of the three fixtures must exist; otherwise the test is
      // vacuously passing — assert presence.
      expect(
        typeof harness.withDockerStub === 'function' ||
          typeof harness.withSuiCliStub === 'function' ||
          typeof harness.withSandboxRepoAbsent === 'function',
      ).toBe(true);
    } finally {
      await harness.shutdown();
    }
  });
});

// ===========================================================================
// CYCLE 4 — A13 harness rewire (no setSpawnOverride; per-call ProbeOptions.spawn)
// ===========================================================================

describe('cycle 4 — A13 harness installs stubs without exporting setSpawnOverride', () => {
  it('T-262: withDockerStub installs the stub and routes through ProbeOptions.spawn (no global mutation)', async () => {
    const projectRoot = makeTempRoot();

    // Confirm setSpawnOverride is not exported from preflight.
    const preflightMod = await import('../mcp/server/src/preflight.js');
    expect('setSpawnOverride' in preflightMod).toBe(false);

    const harness = (await bootHarness({ projectRoot })) as {
      callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
      withDockerStub: (opts: { exitCode: number }) => Promise<unknown>;
      runPreflightProbe: (probeId: string, opts?: Record<string, unknown>) => Promise<unknown>;
      shutdown: () => Promise<void>;
    };
    try {
      await harness.withDockerStub({ exitCode: 1 });
      const r = parseTextResult(
        await harness.runPreflightProbe('docker-running'),
      );
      expect(r.pass).toBe(false);
    } finally {
      await harness.shutdown();
    }
  });

  it('T-263: withSuiCliStub continues to drive E-011 scenario after spawn-injection rewire', async () => {
    const projectRoot = makeTempRoot();
    const harness = (await bootHarness({ projectRoot })) as {
      callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
      withSuiCliStub: (opts: { version: string }) => Promise<unknown>;
      runPreflightProbe: (probeId: string, opts?: Record<string, unknown>) => Promise<unknown>;
      shutdown: () => Promise<void>;
    };
    try {
      await harness.withSuiCliStub({ version: '1.62.0' });
      const r = parseTextResult(
        await harness.runPreflightProbe('sui-cli-version'),
      );
      expect(r.pass).toBe(false);
      expect(r.message).toContain('1.62.0');
      expect(r.message).toContain('brew install sui');
    } finally {
      await harness.shutdown();
    }
  });
});
