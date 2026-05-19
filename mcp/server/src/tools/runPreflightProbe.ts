import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { discoverCourses, type DiscoveredCourse } from '../pluginsRoot.js';
import { runDynamicProbe, type DynamicProbeOptions } from '../dynamicProbes.js';
import type { CourseProbeDecl } from '../schemas/courseProbes.js';
import type { ProbeResult, ShellAction } from '../preflight.js';
import { loadAccConfig, AccConfigError } from '../settings.js';
import {
  resolveCoursePaths,
  substitutePathRefs,
  envVarsFor,
  PathRefError,
} from '../pathResolver.js';

export interface RunPreflightProbeArgs {
  probeId: string;
  remediate?: boolean;
  /** Per-probe runtime options (test seam). */
  probeOpts?: Record<string, DynamicProbeOptions>;
  /** Override for ACC config + `${paths.<id>}` resolution. Tests redirect
   * this to a tmp home so they can inject a synthetic `~/.acc/config.json`. */
  homeDir?: string;
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
  owner: DiscoveredCourse;
  collidingCourses?: string[];
} | undefined {
  const { courses } = discoverCourses();
  const hits: Array<{ decl: CourseProbeDecl; owner: DiscoveredCourse }> = [];
  for (const c of courses) {
    const decl = c.probes.find((p) => p.id === probeId);
    if (decl) hits.push({ decl, owner: c });
  }
  if (hits.length === 0) return undefined;
  const winner = hits[0];
  if (hits.length === 1) return winner;
  return {
    decl: winner.decl,
    owner: winner.owner,
    collidingCourses: hits.slice(1).map((h) => h.owner.name),
  };
}

async function runRemediation(
  action: ShellAction,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; logs: string[] }> {
  return new Promise((resolve) => {
    const logs: string[] = [];
    const child = nodeSpawn('sh', ['-c', action.command], {
      cwd: action.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
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
 * Substitute `${paths.<id>}` tokens in the probe decl + remediation. Caller
 * passes an already-loaded `AccConfig` to keep this transformer pure.
 */
function substituteProbeWithConfig(
  decl: CourseProbeDecl,
  owner: DiscoveredCourse,
  config: Awaited<ReturnType<typeof loadAccConfig>>,
  homeDir?: string,
): { decl: CourseProbeDecl; pathEnv: Record<string, string> } {
  const resolved = resolveCoursePaths(owner.name, owner.paths, config, homeDir);
  const rewritten = substitutePathRefs(decl, resolved);
  return { decl: rewritten, pathEnv: envVarsFor(resolved) };
}

/**
 * Run a single declarative probe by id. Probe ids are resolved against the
 * union of every enabled course plugin's declared probes — ACC ships no
 * domain probes itself.
 *
 * Before the probe runs, any `${paths.<id>}` tokens in its params or
 * remediation are substituted with absolute paths resolved via the two-tier
 * settings model (`~/.acc/config.json` + `accContent.paths`). The remediation
 * child process inherits `ACC_PATHS_*` env vars so shell commands can also
 * reference the resolved path by name.
 *
 * When `remediate: true` and the probe fails with a `ShellAction`, execute
 * the action and re-run the probe. Returns the post-remediation result plus
 * the captured logs.
 */
export async function runPreflightProbe(
  args: RunPreflightProbeArgs,
): Promise<RunPreflightProbeResult> {
  const { probeId, remediate = false, probeOpts = {}, homeDir } = args;

  const hit = findProbe(probeId);
  if (!hit) {
    return {
      pass: false,
      message: `Unknown probe id: '${probeId}'. No enabled course plugin declares it under accContent.probes.`,
    };
  }

  // Load the user-level config + apply `${paths.<id>}` substitution. Empty
  // `paths` short-circuits both the config read and the substitution walk.
  let workingDecl: CourseProbeDecl = hit.decl;
  let pathEnv: Record<string, string> = {};
  if (hit.owner.paths.length > 0) {
    let config;
    try {
      config = await loadAccConfig(homeDir);
    } catch (err) {
      if (err instanceof AccConfigError) {
        return {
          pass: false,
          ownerCourse: hit.owner.name,
          message: `ACC config invalid (${err.kind}): ${err.message}`,
        };
      }
      throw err;
    }
    try {
      const subst = substituteProbeWithConfig(hit.decl, hit.owner, config, homeDir);
      workingDecl = subst.decl;
      pathEnv = subst.pathEnv;
    } catch (err) {
      if (err instanceof PathRefError) {
        return {
          pass: false,
          ownerCourse: hit.owner.name,
          message: `Probe '${probeId}' references an undeclared path: ${err.message}`,
        };
      }
      throw err;
    }
  }

  let probeResult: ProbeResult;
  try {
    probeResult = await runDynamicProbe(workingDecl, probeOpts[probeId] ?? {});
  } catch (err) {
    return {
      pass: false,
      ownerCourse: hit.owner.name,
      message: `Probe '${probeId}' threw an unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!remediate || probeResult.pass || !probeResult.action) {
    const out: RunPreflightProbeResult = {
      pass: probeResult.pass,
      message: probeResult.message,
      ownerCourse: hit.owner.name,
    };
    if (probeResult.action) out.action = probeResult.action;
    if (hit.collidingCourses) out.collidingCourses = hit.collidingCourses;
    return out;
  }

  // remediate=true and the probe failed with a shell action: run it.
  const timeoutMs = probeResult.action.timeoutMs ?? 60_000;
  const remediationEnv: NodeJS.ProcessEnv = { ...process.env, ...pathEnv };
  const { status, logs } = await runRemediation(probeResult.action, timeoutMs, remediationEnv);
  if (status !== 0) {
    return {
      pass: false,
      ownerCourse: hit.owner.name,
      message: `Remediation for '${probeId}' failed (exit ${status}). See logs.`,
      logs,
    };
  }

  // Re-run the probe after remediation.
  let after: ProbeResult;
  try {
    after = await runDynamicProbe(workingDecl, probeOpts[probeId] ?? {});
  } catch (err) {
    return {
      pass: false,
      ownerCourse: hit.owner.name,
      message: `Probe '${probeId}' threw on post-remediation re-run: ${err instanceof Error ? err.message : String(err)}`,
      logs,
    };
  }

  const out: RunPreflightProbeResult = {
    pass: after.pass,
    message: after.pass
      ? `${after.message} (after remediation)`
      : `Remediation ran but probe still fails: ${after.message}`,
    ownerCourse: hit.owner.name,
    logs,
  };
  if (hit.collidingCourses) out.collidingCourses = hit.collidingCourses;
  if (after.action) out.action = after.action;
  return out;
}
