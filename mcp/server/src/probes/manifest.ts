import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProbeResult, ShellAction, ProbeOptions } from '../preflight.js';
import type { PreflightDeployPreconditionFailedWarning, PreflightDeployTimeoutWarning } from '../warnings.js';

const MANIFEST_URL = 'http://localhost:9009/manifest';
const DEPLOY_TIMEOUT_MS = 420000; // 7 minutes
const MAX_RECHECK_ATTEMPTS = 3;

function getSandboxCwd(): string {
  return path.join(os.homedir(), 'workspace', 'deepbook-sandbox', 'sandbox');
}

async function checkManifest(): Promise<boolean> {
  try {
    // R3-005 carry-forward: add AbortSignal.timeout(5000) so a hung server
    // cannot stall the probe indefinitely.
    const response = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(5000) });
    return response.ok && response.status === 200;
  } catch (_err) {
    return false;
  }
}

export async function probeSandboxManifestReachable(
  _opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const ok = await checkManifest();
  if (ok) {
    return { pass: true, message: 'Sandbox manifest is reachable at http://localhost:9009/manifest.' };
  }

  const action: ShellAction = {
    kind: 'shell',
    command: 'pnpm deploy-all --quick',
    cwd: getSandboxCwd(),
    timeoutMs: DEPLOY_TIMEOUT_MS,
  };

  return {
    pass: false,
    message: 'Sandbox manifest is not reachable at http://localhost:9009/manifest.',
    action,
  };
}

export interface DeployRemediationResult {
  pass: boolean;
  message: string;
  logs?: string[];
  warning?: PreflightDeployPreconditionFailedWarning | PreflightDeployTimeoutWarning;
}

type PreconditionChecker = (probeId: string) => Promise<ProbeResult>;

/**
 * The deploy remediation executor. Called by runPreflightProbe when
 * remediate=true and the manifest probe has returned a shell action.
 *
 * IMPORTANT: Uses process.env.E2E_DEPLOY_STUB === '1' as the SOLE entry
 * to the stub branch. No other env var triggers the stub.
 *
 * Precondition gating (probes #1, #4, #6) only applies to the real-mode
 * spawn path. The stub branch bypasses preconditions since it never spawns.
 *
 * @param action - The shell action from the manifest probe failure
 * @param checkPrecondition - Callback to check precondition probes (#1, #4, #6)
 * @param opts - Optional spawn function injection for testing
 */
export async function runDeployRemediation(
  action: ShellAction,
  checkPrecondition: PreconditionChecker,
  opts: { spawn?: typeof spawn } = {},
): Promise<DeployRemediationResult> {
  // Stub branch: E2E_DEPLOY_STUB === '1' is the SOLE entry point.
  // Stub bypasses preconditions (no real subprocess; precondition gate is
  // specifically to protect the real spawn path).
  if (process.env.E2E_DEPLOY_STUB === '1') {
    return runStubDeploy();
  }

  // Real-mode branch: check preconditions #1 (docker-running), #4 (sui-cli-version), #6 (sandbox-repo-present)
  const preconditions = ['docker-running', 'sui-cli-version', 'sandbox-repo-present'];

  for (const probeId of preconditions) {
    // eslint-disable-next-line no-await-in-loop
    const result = await checkPrecondition(probeId);
    if (!result.pass) {
      const warning: PreflightDeployPreconditionFailedWarning = {
        kind: 'preflight-deploy-precondition-failed',
        message: `Precondition probe '${probeId}' failed: ${result.message}`,
        probeId,
      };
      return {
        pass: false,
        message: warning.message,
        warning,
      };
    }
  }

  // All preconditions passed — run the real deploy.
  return runRealDeploy(action, opts.spawn ?? spawn);
}

function runStubDeploy(): DeployRemediationResult {
  // Deterministic in-process stub — never spawns a real subprocess
  return {
    pass: false,
    message: '[stub] deploy-all ran but manifest is not up. Run: pnpm down to clean up.',
    logs: ['[stub] pnpm deploy-all --quick started', '[stub] deploy-all exited 0'],
  };
}

async function runRealDeploy(
  action: ShellAction,
  spawnFn: typeof spawn,
): Promise<DeployRemediationResult> {
  const cwd = action.cwd ?? getSandboxCwd();
  const logs: string[] = [];

  return new Promise<DeployRemediationResult>((resolve) => {
    const child = spawnFn('pnpm', ['deploy-all', '--quick'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let timedOut = false;
    let resolved = false;
    const finish = (result: DeployRemediationResult): void => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    // SIGKILL fallback after SIGTERM (cycle-3 review R3-010 / R6-003).
    let killHardTimer: NodeJS.Timeout | undefined;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill();
      killHardTimer = setTimeout(() => {
        try {
          // Force-kill if SIGTERM was ignored.
          (child as unknown as { kill: (sig: NodeJS.Signals) => void }).kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 5000);
    }, DEPLOY_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter((l) => l.length > 0);
      logs.push(...lines);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter((l) => l.length > 0);
      logs.push(...lines);
    });

    // Cycle-3 review H001 fix: spawn-time errors (ENOENT, EACCES) fire
    // 'error' instead of 'close'. Without this handler the promise hangs
    // for the full DEPLOY_TIMEOUT_MS budget.
    child.on('error', (err: Error & { code?: string }) => {
      clearTimeout(timeoutHandle);
      if (killHardTimer) clearTimeout(killHardTimer);
      const code = err.code ?? 'unknown';
      finish({
        pass: false,
        message: `Deploy spawn failed (${code}): ${err.message}. Run: pnpm down to clean up.`,
        logs,
      });
    });

    child.on('close', async (_code: number | null) => {
      clearTimeout(timeoutHandle);

      if (timedOut) {
        const warning: PreflightDeployTimeoutWarning = {
          kind: 'preflight-deploy-timeout',
          message: `Deploy timed out after ${DEPLOY_TIMEOUT_MS}ms. Run: pnpm down to clean up.`,
          logs,
        };
        resolve({
          pass: false,
          message: warning.message,
          logs,
          warning,
        });
        return;
      }

      // Re-check manifest up to 3 times
      let lastOk = false;
      for (let i = 0; i < MAX_RECHECK_ATTEMPTS; i++) {
        // eslint-disable-next-line no-await-in-loop
        lastOk = await checkManifest();
        if (lastOk) break;
      }

      if (lastOk) {
        resolve({
          pass: true,
          message: 'Sandbox manifest is now reachable.',
          logs,
        });
      } else {
        resolve({
          pass: false,
          message: `Deploy completed but manifest is still unreachable after ${MAX_RECHECK_ATTEMPTS} attempts. Run: pnpm down to clean up.`,
          logs,
        });
      }
    });
  });
}
