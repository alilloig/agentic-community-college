import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  McpServer,
  Client,
  InMemoryTransport,
  registerTools,
} from '../../mcp/server/src/index.js';
import type { SpawnFn, ProbeId } from '../../mcp/server/src/preflight.js';
import { runProbe } from '../../mcp/server/src/preflight.js';
import { runVerifySpot } from '../../mcp/server/src/tools/verifySpot.js';
import { runRequestHint } from '../../mcp/server/src/tools/requestHint.js';
import { runSelectPath } from '../../mcp/server/src/tools/selectPath.js';
import type { VerifySpawnFn } from '../../mcp/server/src/verify.js';
import type { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

interface HarnessInstance {
  callTool(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  runPreflightProbe(probeId: string, opts?: Record<string, unknown>): Promise<unknown>;
  withDockerStub(opts: { exitCode: number }): Promise<void>;
  withSuiCliStub(opts: { version: string }): Promise<void>;
  withSandboxRepoAbsent(): Promise<void>;
  withDeployStub(opts: {
    exitCode: number;
    exposeManifest: boolean;
  }): Promise<{ cleanup: () => Promise<void> | void }>;
  withVerifyStub(opts: { pass: boolean; output?: string }): Promise<void>;
  withRungContentMissing(spotId: string): Promise<{ cleanup: () => Promise<void> | void }>;
  selectPath(args: Record<string, unknown>): Promise<unknown>;
  setPersonalization(args: Record<string, unknown>): Promise<unknown>;
  nextSpot(args: Record<string, unknown>): Promise<unknown>;
  verifySpot(args: Record<string, unknown>): Promise<unknown>;
  requestHint(args: Record<string, unknown>): Promise<unknown>;
  shutdown(): Promise<void>;
}

interface BootOptions {
  projectRoot: string;
}

export async function bootHarness(options: BootOptions): Promise<HarnessInstance> {
  const { projectRoot } = options;

  const server = new McpServer({
    name: 'sui-deepbook-course-test',
    version: '1.0.0',
  });

  registerTools(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: {} },
  );

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  // Track all cleanup functions for shutdown.
  const overrideCleanups: Array<() => void> = [];

  // Harness-internal map: probe id → SpawnFn stub.
  // withDockerStub / withSuiCliStub populate this. callTool intercepts
  // runPreflightProbe calls and routes through runProbe with the stub injected
  // via ProbeOptions.spawn — no module-level setSpawnOverride in preflight.ts
  // (M005 carry-forward).
  const probeSpawnStubs = new Map<string, SpawnFn>();

  // Harness-internal verify stub for verifySpot. callTool intercepts
  // verifySpot and requestHint calls when this is set and returns the stub
  // envelope without calling into production code. Cycle-4 H001 fix: replaces
  // the previous module-level `_verifyOverride` exported by verify.ts (which
  // violated the same A13 anti-pattern that retired setSpawnOverride).
  let verifyStub: { pass: boolean; output?: string } | null = null;

  // Build the harness object with methods that can be replaced by spies.
  // runPreflightProbe and tool wrappers reference `harness.callTool` so that
  // when vi.spyOn(harness, 'callTool') replaces the method, the spy fires.
  const harness: HarnessInstance = {
    async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
      // For runPreflightProbe calls: if there's a harness-side spawn stub for
      // the probe id, invoke runProbe directly with the stub so no global
      // state is mutated. This is the per-call ProbeOptions.spawn injection
      // pattern (A13).
      if (toolName === 'runPreflightProbe' && typeof args['probeId'] === 'string') {
        const probeId = args['probeId'] as ProbeId;
        const stubSpawn = probeSpawnStubs.get(probeId);
        if (stubSpawn !== undefined) {
          const remediate =
            typeof args['remediate'] === 'boolean' ? args['remediate'] : false;
          const probeResult = await runProbe(probeId, {
            spawn: stubSpawn,
            remediate,
          });
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(probeResult),
              },
            ],
          };
        }
        // Phase F round-2 H001 fix: when the outer probe is a deploy-remediation
        // trigger (e.g., 'sandbox-manifest-reachable') and stubs are registered
        // for its inner-precondition probes ('docker-running', 'sui-cli-version',
        // 'sandbox-repo-present'), bypass the MCP transport and call the
        // production runPreflightProbe directly with a probeOpts map carrying
        // the stub spawn functions. The MCP transport JSON-serializes args
        // and would strip the function refs, so we must invoke production code
        // in-process to preserve them. This makes harness tests robust without
        // relying on environment tricks (e.g. DOCKER_HOST=tcp://127.0.0.1:1).
        if (probeId === 'sandbox-manifest-reachable' && probeSpawnStubs.size > 0) {
          const { runPreflightProbe } = await import(
            '../../mcp/server/src/tools/runPreflightProbe.js'
          );
          const probeOpts: Record<string, { spawn: SpawnFn }> = {};
          for (const [pid, fn] of probeSpawnStubs) {
            probeOpts[pid] = { spawn: fn };
          }
          const remediate =
            typeof args['remediate'] === 'boolean' ? args['remediate'] : false;
          const result = await runPreflightProbe({
            probeId: probeId as string,
            remediate,
            probeOpts: probeOpts as Partial<Record<ProbeId, { spawn: SpawnFn }>>,
          });
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(result),
              },
            ],
          };
        }
      }
      // Cycle-4 H001 fix: harness-side verify stub via per-call spawn injection.
      // When withVerifyStub has installed a stub, build a synchronous spawn fn
      // that returns the stubbed exit code/output, call runVerifySpot directly
      // with it threaded through opts.spawn, and wrap the result in the MCP
      // envelope. Production code does the full state-load + cursor-advance
      // flow; verify.ts has NO module-level test seam.
      if (toolName === 'verifySpot' && verifyStub !== null) {
        const stub = verifyStub;
        const stubSpawn: VerifySpawnFn = () => ({
          status: stub.pass ? 0 : 1,
          stdout: stub.output ?? '',
          stderr: '',
        });
        const projectRootArg =
          typeof args['projectRoot'] === 'string' ? args['projectRoot'] : '';
        const result = await runVerifySpot({ projectRoot: projectRootArg }, { spawn: stubSpawn });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result),
            },
          ],
        };
      }
      // Cycle-5: harness-side requestHint stub via per-call spawn injection.
      // When withVerifyStub has installed a stub, intercept requestHint calls
      // and call runRequestHint directly with the stub spawn threaded through
      // opts.spawn, so rung-3's internal runVerifySpot dispatch uses the stub
      // without going through the MCP transport.
      if (toolName === 'requestHint' && verifyStub !== null) {
        const stub = verifyStub;
        const stubSpawn: VerifySpawnFn = () => ({
          status: stub.pass ? 0 : 1,
          stdout: stub.output ?? '',
          stderr: '',
        });
        const projectRootArg =
          typeof args['projectRoot'] === 'string' ? args['projectRoot'] : '';
        const rungArg = args['rung'] as 1 | 2 | 3;
        const result = await runRequestHint(
          { projectRoot: projectRootArg, rung: rungArg },
          { spawn: stubSpawn },
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result),
            },
          ],
        };
      }
      // F-005: harness-side selectPath interception. The path's workspace
      // block triggers prepareWorkspace, which by default calls
      // child_process.spawn('pnpm', ['install']) inside the workspace dir.
      // That blows up test runtime and pollutes ~/.sui-deepbook-course on
      // the host. Routing through runSelectPath in-process lets us thread
      // a stub spawn through workspace options. The MCP transport would
      // serialize the function ref away, so the in-process call is required.
      if (toolName === 'selectPath') {
        const projectRootArg =
          typeof args['projectRoot'] === 'string' ? args['projectRoot'] : '';
        const slugArg = args['slug'];
        const stubInstallSpawn = makeNoopSpawn();
        const result = await runSelectPath(
          { projectRoot: projectRootArg, slug: slugArg },
          { workspace: { spawn: stubInstallSpawn as unknown as typeof nodeSpawn } },
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result),
            },
          ],
        };
      }
      // Delegate all other calls to the MCP client.
      return client.callTool({ name: toolName, arguments: args });
    },

    /**
     * Convenience wrapper: runs the runPreflightProbe tool via callTool.
     * Delegates to harness.callTool so that test spies on callTool are observed.
     */
    async runPreflightProbe(
      probeId: string,
      opts?: Record<string, unknown>,
    ): Promise<unknown> {
      return harness.callTool('runPreflightProbe', { probeId, ...opts });
    },

    /**
     * Fixture: installs a stub spawn function for the docker probe.
     * Stub is stored in harness-internal map; passed via ProbeOptions.spawn.
     */
    async withDockerStub(opts: { exitCode: number }): Promise<void> {
      const stubSpawn: SpawnFn = () => ({
        status: opts.exitCode,
        stdout: '',
        stderr: opts.exitCode !== 0 ? 'Cannot connect to the Docker daemon' : '',
      });
      probeSpawnStubs.set('docker-running', stubSpawn);
    },

    /**
     * Fixture: installs a stub spawn function for the sui-cli probe.
     */
    async withSuiCliStub(opts: { version: string }): Promise<void> {
      const stubSpawn: SpawnFn = () => ({
        status: 0,
        stdout: `sui ${opts.version}\n`,
        stderr: '',
      });
      probeSpawnStubs.set('sui-cli-version', stubSpawn);
    },

    /**
     * Fixture: simulate sandbox repo being absent.
     * The probe reads process.env.HOME / os.homedir() directly; the test
     * already sets HOME = tempHome which has no sandbox checkout.
     */
    async withSandboxRepoAbsent(): Promise<void> {
      // No-op: the test controls HOME via beforeEach.
    },

    /**
     * Fixture: sets E2E_DEPLOY_STUB=1 for the deploy-stub scenario.
     * Returns a cleanup function that restores the prior env state.
     */
    async withDeployStub(_opts: {
      exitCode: number;
      exposeManifest: boolean;
    }): Promise<{ cleanup: () => Promise<void> | void }> {
      const prior = process.env.E2E_DEPLOY_STUB;
      process.env.E2E_DEPLOY_STUB = '1';

      return {
        cleanup: () => {
          if (prior === undefined) {
            delete process.env.E2E_DEPLOY_STUB;
          } else {
            process.env.E2E_DEPLOY_STUB = prior;
          }
        },
      };
    },

    /**
     * Fixture: stubs verifySpot (and rung-3 of requestHint) so it returns the
     * given result without spawning a subprocess. Used by E-001 / E-014 tests
     * (T-286) and cycle-5 E-004 tests (T-096/T-098).
     *
     * Cycle-4 H001 fix: state lives on the harness instance (closure-captured
     * `verifyStub` above). callTool intercepts `verifySpot` and `requestHint`
     * and returns the stub envelope before the request reaches the MCP client.
     * Production `verify.ts` exposes no module-level test seam — the stubbing
     * concern stays in the test infrastructure where it belongs.
     */
    async withVerifyStub(opts: { pass: boolean; output?: string }): Promise<void> {
      verifyStub = { pass: opts.pass, output: opts.output };
    },

    /**
     * Fixture: temporarily renames the auto.md file for the given spotId so
     * that rung-3 requestHint returns rung-content-missing. Returns a cleanup
     * function that renames the file back to its canonical path.
     *
     * The harness scans <projectRoot>/paths/ for any slug directory that
     * contains rungs/<spotId>/auto.md.
     */
    async withRungContentMissing(
      spotId: string,
    ): Promise<{ cleanup: () => Promise<void> | void }> {
      const pathsDir = path.join(projectRoot, 'paths');
      let autoMdPath: string | undefined;

      // Scan slug directories under paths/ for the rung file.
      try {
        const slugs = fs.readdirSync(pathsDir, { withFileTypes: true });
        for (const entry of slugs) {
          if (!entry.isDirectory()) continue;
          const candidate = path.join(pathsDir, entry.name, 'rungs', spotId, 'auto.md');
          if (fs.existsSync(candidate)) {
            autoMdPath = candidate;
            break;
          }
        }
      } catch {
        // paths/ doesn't exist — return no-op cleanup
        return { cleanup: () => {} };
      }

      if (!autoMdPath) {
        return { cleanup: () => {} };
      }

      const sidecar = autoMdPath + '.bak-fixture';
      fs.renameSync(autoMdPath, sidecar);

      return {
        cleanup: () => {
          if (fs.existsSync(sidecar)) {
            fs.renameSync(sidecar, autoMdPath as string);
          }
        },
      };
    },

    /**
     * Fixture wrapper: selectPath delegates to callTool.
     */
    async selectPath(args: Record<string, unknown>): Promise<unknown> {
      return harness.callTool('selectPath', args);
    },

    /**
     * Fixture wrapper: setPersonalization delegates to callTool.
     */
    async setPersonalization(args: Record<string, unknown>): Promise<unknown> {
      return harness.callTool('setPersonalization', args);
    },

    /**
     * Fixture wrapper: nextSpot delegates to callTool.
     */
    async nextSpot(args: Record<string, unknown>): Promise<unknown> {
      return harness.callTool('nextSpot', args);
    },

    /**
     * Fixture wrapper: verifySpot delegates to callTool.
     */
    async verifySpot(args: Record<string, unknown>): Promise<unknown> {
      return harness.callTool('verifySpot', args);
    },

    /**
     * Fixture wrapper: requestHint delegates to callTool.
     * Asserts the response carries no shell action (kind:'shell' absent).
     * Throws a descriptive error if a shell action appears in the response tree.
     */
    async requestHint(args: Record<string, unknown>): Promise<unknown> {
      const result = await harness.callTool('requestHint', args);
      // Validate no shell action in the response.
      const serialized = JSON.stringify(result);
      if (serialized.includes('"kind":"shell"') || serialized.includes("'kind':'shell'")) {
        throw new Error(
          `requestHint response contains a shell action (kind:"shell"): ${serialized}`,
        );
      }
      return result;
    },

    async shutdown(): Promise<void> {
      // Remove all installed overrides.
      for (const cleanup of overrideCleanups) {
        cleanup();
      }
      overrideCleanups.length = 0;
      probeSpawnStubs.clear();
      verifyStub = null;
      await client.close();
      await server.close();
    },
  };

  return harness;
}

export default bootHarness;

/**
 * Build a child_process.spawn stub that fakes a successful, instantly-exiting
 * subprocess. Used by the selectPath interception to swallow the workspace's
 * `pnpm install` without touching the network or polluting the host. The
 * returned object mimics the surface workspace.ts:runHostInstall actually
 * uses — stdout/stderr streams that emit no data and a 'close' event with
 * exit code 0.
 */
function makeNoopSpawn(): unknown {
  return ((_cmd: string, _args: string[]): unknown => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: (sig?: NodeJS.Signals) => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    // Defer the close event so the spawn caller has time to wire listeners.
    setImmediate(() => child.emit('close', 0));
    return child;
  });
}
