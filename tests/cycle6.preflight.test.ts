// Cycle 6 — runPreflightProbe threads probeOpts through runDeployRemediation (AC-2.4)
// T-312: when remediate=true and the manifest probe surfaces a deploy action,
// runPreflightProbe must accept a probeOpts map and forward each entry into
// runProbe(pid, probeOpts[pid] ?? {}) so harness withDockerStub flows through
// the precondition gate. With docker-running stubbed to exit 1 the gate must
// short-circuit with probeId:'docker-running' (NOT sui-cli-version) and NO
// pnpm deploy-all spawn must occur.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });
vi.mock('node:child_process', { spy: true });

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

import { runPreflightProbe } from '../mcp/server/src/tools/runPreflightProbe.js';
import type { SpawnFn } from '../mcp/server/src/preflight.js';

let originalHome: string | undefined;
let originalDeployStub: string | undefined;
let tempHome: string;
let tempRoots: string[] = [];

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sui-course-c6-pre-home-'));
  tempRoots.push(tempHome);
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;
  // T-312 must exercise the real-mode precondition gate, NOT the stub branch.
  originalDeployStub = process.env.E2E_DEPLOY_STUB;
  delete process.env.E2E_DEPLOY_STUB;
});

afterEach(() => {
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

describe('AC-2.4: runPreflightProbe threads probeOpts through runDeployRemediation (T-312)', () => {
  it('T-312: runPreflightProbe threads probeOpts through runDeployRemediation precondition gate', async () => {
    // Pre-seed a sandbox repo so probe #6 (sandbox-repo-present) does NOT fail
    // ahead of probe #1 (docker). We want the gate to stop on docker-running,
    // not on the sandbox checkout absence.
    fs.mkdirSync(
      path.join(tempHome, 'workspace', 'deepbook-sandbox', 'sandbox'),
      { recursive: true },
    );

    // Force fetch to keep returning unreachable so the manifest probe surfaces
    // the shell action rather than passing.
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchSpy);

    // Stub spawn for docker → exit 1 (Cannot connect to the Docker daemon).
    // Stub spawn for sui-cli → in-range so we can prove the gate stopped on
    // docker, not on sui-cli or any other probe.
    const dockerSpawnCalls: Array<{ cmd: string; args: string[] }> = [];
    const stubDockerSpawn: SpawnFn = (cmd, args) => {
      dockerSpawnCalls.push({ cmd, args });
      return {
        status: 1,
        stdout: '',
        stderr: 'Cannot connect to the Docker daemon',
      };
    };
    const stubSuiSpawn: SpawnFn = () => ({
      status: 0,
      stdout: 'sui 1.63.2-abc\n',
      stderr: '',
    });

    // Spy on the real child_process.spawn — assert it is NEVER called for
    // pnpm deploy-all on this path (the precondition gate must short-circuit
    // before runRealDeploy).
    const spawnSpy = vi.spyOn(childProcess, 'spawn');

    const result = await runPreflightProbe({
      probeId: 'sandbox-manifest-reachable',
      remediate: true,
      // Cycle 6 H004 contract: probeOpts threading.
      probeOpts: {
        'docker-running': { spawn: stubDockerSpawn },
        'sui-cli-version': { spawn: stubSuiSpawn },
      },
    } as unknown as Parameters<typeof runPreflightProbe>[0]);

    // Gate must short-circuit with the docker-running precondition.
    expect(result.pass).toBe(false);
    expect(result.warning).toBeDefined();
    expect(result.warning!.kind).toBe('preflight-deploy-precondition-failed');
    // The CRITICAL invariant: probeId is 'docker-running', NOT
    // 'sui-cli-version' or any other probe id. If the implementation forwards
    // an empty {} instead of probeOpts, runProbe('docker-running', {}) would
    // execute against the host's real `docker`, which on a CI-without-docker
    // box would still fail — but on a developer box with docker actually
    // running it would PASS, the gate would advance to sui-cli-version, and
    // sui-cli-version (against the host's real `sui`) is unstable. The probe
    // injection from probeOpts is what makes the test deterministic.
    expect((result.warning as { probeId?: string }).probeId).toBe(
      'docker-running',
    );

    // The stub spawn for docker-running was actually invoked (proves the
    // probeOpts threading reached runProbe).
    expect(dockerSpawnCalls.length).toBeGreaterThanOrEqual(1);

    // No real subprocess spawn for pnpm deploy-all.
    const deployCalls = spawnSpy.mock.calls.filter((call) => {
      const cmd = call[0];
      const args = call[1];
      return (
        typeof cmd === 'string' &&
        cmd === 'pnpm' &&
        Array.isArray(args) &&
        (args as string[]).includes('deploy-all')
      );
    });
    expect(deployCalls.length).toBe(0);
  });
});
