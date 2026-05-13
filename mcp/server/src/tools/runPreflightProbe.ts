import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { discoverCourses } from '../pluginsRoot.js';
import { runDynamicProbe, type DynamicProbeOptions } from '../dynamicProbes.js';
import type { CourseProbeDecl } from '../schemas/courseProbes.js';
import type { ProbeResult, ShellAction } from '../preflight.js';

export interface RunPreflightProbeArgs {
  probeId: string;
  remediate?: boolean;
  /** Per-probe runtime options (test seam). */
  probeOpts?: Record<string, DynamicProbeOptions>;
}

export interface RunPreflightProbeResult {
  pass: boolean;
  message: string;
  action?: ShellAction;
  /** Output captured from a remediation invocation, when one ran. */
  logs?: string[];
  /** Plugin key of the course that owned the probe (when resolved). */
  ownerCourse?: string;
  /** Names of other course plugins that also declared this probe id, when
   * more than one was found. The first-discovered course wins; the others
   * are shadowed. This signal lets the conductor and tests catch silent
   * cross-course collisions. */
  collidingCourses?: string[];
}

function findProbe(probeId: string): {
  decl: CourseProbeDecl;
  owner: string;
  collidingCourses?: string[];
} | undefined {
  const { courses } = discoverCourses();
  const hits: Array<{ decl: CourseProbeDecl; owner: string }> = [];
  for (const c of courses) {
    const decl = c.probes.find((p) => p.id === probeId);
    if (decl) hits.push({ decl, owner: c.name });
  }
  if (hits.length === 0) return undefined;
  const winner = hits[0];
  if (hits.length === 1) return winner;
  return {
    decl: winner.decl,
    owner: winner.owner,
    collidingCourses: hits.slice(1).map((h) => h.owner),
  };
}

async function runRemediation(
  action: ShellAction,
  timeoutMs: number,
): Promise<{ status: number | null; logs: string[] }> {
  return new Promise((resolve) => {
    const logs: string[] = [];
    const child = nodeSpawn('sh', ['-c', action.command], {
      cwd: action.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    } satisfies SpawnOptions);

    const timer = setTimeout(() => {
      logs.push(`[timeout] remediation killed after ${timeoutMs}ms`);
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.length > 0) logs.push(line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.length > 0) logs.push(line);
      }
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, logs });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      logs.push(`[spawn-error] ${err.message}`);
      resolve({ status: 1, logs });
    });
  });
}

/**
 * Run a single declarative probe by id. Probe ids are resolved against the
 * union of every enabled course plugin's declared probes — ACC ships no
 * domain probes itself.
 *
 * When `remediate: true` and the probe fails with a `ShellAction`, execute
 * the action and re-run the probe. Returns the post-remediation result plus
 * the captured logs.
 */
export async function runPreflightProbe(
  args: RunPreflightProbeArgs,
): Promise<RunPreflightProbeResult> {
  const { probeId, remediate = false, probeOpts = {} } = args;

  const hit = findProbe(probeId);
  if (!hit) {
    return {
      pass: false,
      message: `Unknown probe id: '${probeId}'. No enabled course plugin declares it under accContent.probes.`,
    };
  }

  let probeResult: ProbeResult;
  try {
    probeResult = await runDynamicProbe(hit.decl, probeOpts[probeId] ?? {});
  } catch (err) {
    return {
      pass: false,
      ownerCourse: hit.owner,
      message: `Probe '${probeId}' threw an unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!remediate || probeResult.pass || !probeResult.action) {
    const out: RunPreflightProbeResult = {
      pass: probeResult.pass,
      message: probeResult.message,
      ownerCourse: hit.owner,
    };
    if (probeResult.action) out.action = probeResult.action;
    if (hit.collidingCourses) out.collidingCourses = hit.collidingCourses;
    return out;
  }

  // remediate=true and the probe failed with a shell action: run it.
  const timeoutMs = probeResult.action.timeoutMs ?? 60_000;
  const { status, logs } = await runRemediation(probeResult.action, timeoutMs);
  if (status !== 0) {
    return {
      pass: false,
      ownerCourse: hit.owner,
      message: `Remediation for '${probeId}' failed (exit ${status}). See logs.`,
      logs,
    };
  }

  // Re-run the probe after remediation.
  let after: ProbeResult;
  try {
    after = await runDynamicProbe(hit.decl, probeOpts[probeId] ?? {});
  } catch (err) {
    return {
      pass: false,
      ownerCourse: hit.owner,
      message: `Probe '${probeId}' threw on post-remediation re-run: ${err instanceof Error ? err.message : String(err)}`,
      logs,
    };
  }

  const out: RunPreflightProbeResult = {
    pass: after.pass,
    message: after.pass
      ? `${after.message} (after remediation)`
      : `Remediation ran but probe still fails: ${after.message}`,
    ownerCourse: hit.owner,
    logs,
  };
  if (hit.collidingCourses) out.collidingCourses = hit.collidingCourses;
  if (after.action) out.action = after.action;
  return out;
}
