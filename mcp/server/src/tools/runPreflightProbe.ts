import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import {
  discoverCourses,
  type DiscoveredCourse,
  type CourseDiscoveryWarning,
} from '../pluginsRoot.js';
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
  /** Discovery warnings relevant to this probe lookup — populated when the
   * probe id is unknown and a course's probes were defensively dropped
   * (e.g. a `${paths.<id>}` cross-reference failed). Lets the conductor
   * surface the root cause instead of just "Unknown probe id". */
  discoveryWarnings?: Array<{ kind: string; message: string; pluginKey?: string }>;
}

function findProbe(probeId: string): {
  decl: CourseProbeDecl;
  owner: DiscoveredCourse;
  collidingCourses?: string[];
  warnings: CourseDiscoveryWarning[];
} | undefined {
  const { courses, warnings } = discoverCourses();
  const hits: Array<{ decl: CourseProbeDecl; owner: DiscoveredCourse }> = [];
  for (const c of courses) {
    const decl = c.probes.find((p) => p.id === probeId);
    if (decl) hits.push({ decl, owner: c });
  }
  if (hits.length === 0) return undefined;
  const winner = hits[0];
  if (hits.length === 1) return { ...winner, warnings };
  return {
    decl: winner.decl,
    owner: winner.owner,
    collidingCourses: hits.slice(1).map((h) => h.owner.name),
    warnings,
  };
}

/** Pull out the warnings that explain why a probe with the given id might
 * be missing — chiefly `course-plugin-paths-invalid` (which defensively drops
 * a whole course's probes when a `${paths.<id>}` reference is unresolved) and
 * `course-plugin-probes-invalid`. Used to enrich the "Unknown probe id"
 * diagnostic with the root cause instead of the symptom. */
function relevantWarningsForUnknownProbe(): CourseDiscoveryWarning[] {
  const { warnings } = discoverCourses();
  return warnings.filter(
    (w) =>
      w.kind === 'course-plugin-paths-invalid' ||
      w.kind === 'course-plugin-probes-invalid',
  );
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
    // Enrich the "unknown probe" error with discovery warnings — typically a
    // `course-plugin-paths-invalid` that explains why the probe got dropped.
    const relevant = relevantWarningsForUnknownProbe();
    const tail = relevant.length > 0
      ? ` Note: course-plugin discovery surfaced ${relevant.length} warning(s) that may explain why — ${relevant.map((w) => `[${w.pluginKey ?? '?'}] ${w.message}`).join('; ')}`
      : '';
    const out: RunPreflightProbeResult = {
      pass: false,
      message: `Unknown probe id: '${probeId}'. No enabled course plugin declares it under accContent.probes.${tail}`,
    };
    if (relevant.length > 0) {
      out.discoveryWarnings = relevant.map((w) => {
        const entry: { kind: string; message: string; pluginKey?: string } = {
          kind: w.kind,
          message: w.message,
        };
        if (w.pluginKey !== undefined) entry.pluginKey = w.pluginKey;
        return entry;
      });
    }
    return out;
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

  // Merge pathEnv into the probe's spawn env — symmetry with remediation, so
  // a `shell-exit-zero` probe reading `$ACC_PATHS_SANDBOX` sees the same
  // value the matching remediation does.
  const baseProbeOpts = probeOpts[probeId] ?? {};
  const mergedProbeOpts: DynamicProbeOptions = {
    ...baseProbeOpts,
    env: { ...(baseProbeOpts.env ?? {}), ...pathEnv },
  };

  let probeResult: ProbeResult;
  try {
    probeResult = await runDynamicProbe(workingDecl, mergedProbeOpts);
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

  // Re-run the probe after remediation. Re-use the merged env so the
  // post-remediation probe sees the same ACC_PATHS_* values.
  let after: ProbeResult;
  try {
    after = await runDynamicProbe(workingDecl, mergedProbeOpts);
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
