import * as path from 'node:path';
import * as fsPromises from 'node:fs/promises';
import { loadState, saveState } from '../state.js';
import { loadPhases, getCurrentSpot, advanceCursor } from '../phaseEngine.js';
import { runVerification, VerificationModeUnsupportedError } from '../verify.js';
import { probeOutputStyle } from '../outputStyle.js';
import { validatePath } from '../schemas/path.js';
import type { VerifySpawnFn } from '../verify.js';
import type { VerificationSpec } from '../schemas/phases.js';
import { resolvePathContentRoot } from '../pathsRoot.js';

export interface VerifySpotResult {
  pass: boolean;
  output?: string;
  advanced?: boolean;
  error?: string;
}

export interface VerifySpotOptions {
  // Per-call spawn injection. The harness threads a stub through this for
  // tests; production callers leave it undefined and runVerification falls
  // back to node:child_process. Cycle-4 H001 fix: replaces the prior
  // module-level test override seam (cycle-4 H001 fix).
  spawn?: VerifySpawnFn;
}

export async function runVerifySpot(
  args: { projectRoot: string },
  opts?: VerifySpotOptions,
): Promise<VerifySpotResult> {
  const { projectRoot } = args;

  // L002 carry-forward: outputStyleOk gate runs BEFORE any state load
  const styleCheck = await probeOutputStyle();
  if (!styleCheck.ok) {
    return { pass: false, error: 'output-style-disabled', advanced: false };
  }

  // Load state
  const stateResult = await loadState(projectRoot);
  if (stateResult.kind === 'corrupt') {
    return { pass: false, error: `State corrupt: ${stateResult.message}` };
  }
  if (stateResult.kind === 'schema-mismatch') {
    return { pass: false, error: `State schema mismatch: ${stateResult.message}` };
  }
  if (stateResult.kind === 'absent' || !stateResult.state.selected_path) {
    return { pass: false, error: 'No path selected. Call selectPath first.' };
  }

  const state = stateResult.state;
  const slug = state.selected_path;

  // Load phases
  let phasesData: Awaited<ReturnType<typeof loadPhases>>;
  try {
    phasesData = await loadPhases(projectRoot, slug);
  } catch (err) {
    return { pass: false, error: `Failed to load phases: ${String(err)}` };
  }

  // Get current spot
  const current = getCurrentSpot(state, phasesData);
  if (current.done) {
    return { pass: false, error: 'No active spot (path is done)' };
  }

  const { spot } = current;

  // Ensure the spot has a verification block (full spot, not a stub)
  if (spot.verification === undefined) {
    return { pass: false, error: `Spot ${spot.id} has no verification block; cannot verify` };
  }

  // Cast through unknown to satisfy TS strict — spot.verification is a VerificationSpec
  // as validated by the schema (validatePhases runtime check above)
  const verSpec = (spot.verification as unknown) as VerificationSpec;

  // Resolve verification cwd. Workspace-aware paths run verification under the
  // workspace (optionally under a subdir declared in path.json
  // workspace.verification_cwd). Legacy paths stay anchored at projectRoot so
  // existing fixtures and tests don't move under us.
  const verificationCwd = await resolveVerificationCwd(projectRoot, slug, state.workspace_path);

  // M001 carry-forward: wrap runVerification call to catch VerificationModeUnsupportedError
  let verResult: { pass: boolean; output?: string };
  try {
    verResult = await runVerification(verSpec, verificationCwd, { spawn: opts?.spawn });
  } catch (err) {
    if (err instanceof VerificationModeUnsupportedError) {
      return {
        pass: false,
        error: `verification mode '${err.mode}' not yet supported`,
        advanced: false,
      };
    }
    throw err;
  }

  if (verResult.pass) {
    // Advance cursor
    const advancedState = advanceCursor(state, phasesData);
    // M002 carry-forward: wrap saveState in try/catch
    try {
      await saveState(projectRoot, advancedState);
    } catch (err) {
      const e = err as Error;
      return {
        pass: true,
        output: verResult.output,
        advanced: false,
        error: `verification passed but state persist failed: ${e.message}`,
      };
    }
    return { pass: true, output: verResult.output, advanced: true };
  } else {
    // Leave cursor untouched
    return { pass: false, output: verResult.output, advanced: false };
  }
}

/**
 * Resolve where to spawn the verification command. Path-declared
 * `workspace.verification_cwd` is honored as a workspace-relative subdir;
 * if path.json can't be loaded, fall back to the workspace root or the
 * legacy projectRoot.
 */
async function resolveVerificationCwd(
  projectRoot: string,
  slug: string,
  workspacePath: string | undefined,
): Promise<string> {
  if (!workspacePath) return projectRoot;

  let pathRel = '.';
  try {
    const raw = await fsPromises.readFile(
      path.join(resolvePathContentRoot(projectRoot, slug), 'path.json'),
      'utf8',
    );
    const validation = validatePath(JSON.parse(raw));
    if (validation.ok && validation.value.workspace?.verification_cwd) {
      pathRel = validation.value.workspace.verification_cwd;
    }
  } catch {
    // Best-effort: bad path.json shouldn't block verification — workspace
    // root is the documented default anyway.
  }
  return path.join(workspacePath, pathRel);
}

// Alias export expected by tests
export const verifySpot = runVerifySpot;
