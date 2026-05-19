// preflight.ts — shared types for probe execution.
//
// ACC ships zero domain probes. Every prerequisite check is declared by the
// active course plugin under `accContent.probes` in its `plugin.json`. The
// declarative interpreter lives in `dynamicProbes.ts`; this file only owns
// the shared types those declarations and their runtime callers exchange.

export interface ShellAction {
  kind: 'shell';
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ProbeResult {
  pass: boolean;
  message: string;
  action?: ShellAction;
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number; env?: NodeJS.ProcessEnv },
) => { status: number | null; stdout: string; stderr: string };

export interface ProbeOptions {
  spawn?: SpawnFn;
  /** Env-var bag to inject into spawned probe commands (e.g. `ACC_PATHS_*`).
   * Threaded through by `runPreflightProbe` so a `shell-exit-zero` probe can
   * read the same env vars the remediation child gets, removing the
   * documented asymmetry between probe + remediation execution. */
  env?: NodeJS.ProcessEnv;
  /** Some callers route a remediation flag through. The declarative runner
   * itself never executes remediations — that's `runPreflightProbe`'s job —
   * but the field stays on the shared type so test stubs can be wired
   * uniformly. */
  remediate?: boolean;
}
