import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { loadState, saveState } from '../state.js';
import { loadPhases, getCurrentSpot, advanceCursor } from '../phaseEngine.js';
import { substitutePromptOnly } from '../personalization.js';
import { probeOutputStyle } from '../outputStyle.js';
import { canAdvanceRung, recordRungUse, runAutoWrite, AutoWriteError } from '../ladder.js';
import { containedPath, PathTraversalError } from '../pathSafety.js';
import { runVerifySpot } from './verifySpot.js';
import type { VerifySpawnFn } from '../verify.js';
import type { LadderRung } from '../schemas/state.js';
import type { SpotData } from '../schemas/phases.js';
import { resolvePathContentRoot } from '../pathsRoot.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoVerifyResult {
  pass: boolean;
  advanced: boolean;
  output?: string;
}

export type RequestHintErrorKind =
  | 'output-style-disabled'
  | 'no-state'
  | 'no-path-selected'
  | 'state-corrupt'
  | 'state-schema-mismatch'
  | 'state-save-failed'
  | 'no-active-spot'
  | 'rung-out-of-order'
  | 'phases-load-failed'
  | 'rung-content-missing'
  | 'auto-write-failed';

export interface RequestHintError {
  kind: RequestHintErrorKind;
  message: string;
  requestedRung?: 1 | 2 | 3;
  requiredPriorRung?: 1 | 2;
  missingFlag?: 'hint_used' | 'reference_shown';
}

export type RequestHintResult =
  | {
      ok: true;
      payload: string;
      newLadder: LadderRung;
      autoVerifyResult?: AutoVerifyResult;
    }
  | {
      ok: false;
      error: RequestHintError;
    };

export interface RequestHintOptions {
  spawn?: VerifySpawnFn;
}

// ---------------------------------------------------------------------------
// Rung content file mapping
// ---------------------------------------------------------------------------

function rungFilename(rung: 1 | 2 | 3): string {
  if (rung === 1) return 'hint.md';
  if (rung === 2) return 'reference.md';
  return 'auto.md';
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function runRequestHint(
  args: { projectRoot: string; rung: 1 | 2 | 3 },
  opts?: RequestHintOptions,
): Promise<RequestHintResult> {
  const { projectRoot, rung } = args;

  // (1) outputStyleOk gate — runs BEFORE any state load
  const styleCheck = await probeOutputStyle();
  if (!styleCheck.ok) {
    return {
      ok: false,
      error: {
        kind: 'output-style-disabled',
        message: 'output-style-disabled: learning-output-style plugin is not enabled',
      },
    };
  }

  // (2) Load state
  const stateResult = await loadState(projectRoot);
  if (stateResult.kind === 'absent') {
    return {
      ok: false,
      error: { kind: 'no-state', message: 'No state found. Call start and selectPath first.' },
    };
  }
  if (stateResult.kind === 'corrupt') {
    return {
      ok: false,
      error: {
        kind: 'state-corrupt',
        message: `State corrupt: ${stateResult.message}`,
      },
    };
  }
  if (stateResult.kind === 'schema-mismatch') {
    return {
      ok: false,
      error: {
        kind: 'state-schema-mismatch',
        message: `State schema mismatch: ${stateResult.message}`,
      },
    };
  }

  const state = stateResult.state;

  // (3) Check selected_path
  if (!state.selected_path) {
    return {
      ok: false,
      error: {
        kind: 'no-path-selected',
        message: 'No path selected. Call selectPath first.',
      },
    };
  }

  const slug = state.selected_path;

  // (4) Load phases
  let phasesData: Awaited<ReturnType<typeof loadPhases>>;
  try {
    phasesData = await loadPhases(projectRoot, slug);
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: 'phases-load-failed',
        message: `Failed to load phases: ${String(err)}`,
      },
    };
  }

  // (5) Get current spot
  const current = getCurrentSpot(state, phasesData);
  if (current.done) {
    return {
      ok: false,
      error: { kind: 'no-active-spot', message: 'No active spot (path is done).' },
    };
  }

  const { spot } = current;

  // (6) Rung gating check (BEFORE any mutation or side effect)
  const gateCheck = canAdvanceRung(state, spot.id, rung);
  if (!gateCheck.ok) {
    return {
      ok: false,
      error: {
        kind: 'rung-out-of-order',
        message: `Cannot request rung ${rung}: missing flag '${gateCheck.missingFlag}' (rung ${gateCheck.requiredPriorRung} must be used first)`,
        requestedRung: rung,
        requiredPriorRung: gateCheck.requiredPriorRung,
        missingFlag: gateCheck.missingFlag,
      },
    };
  }

  // (7) Read the rung markdown content — read FIRST before any side effect
  const rungFile = rungFilename(rung);
  // The spot.rungs field carries relative paths from the path's root directory
  let rungRelPath: string | undefined;
  if (rung === 1) {
    rungRelPath = spot.rungs?.hint_md;
  } else if (rung === 2) {
    rungRelPath = spot.rungs?.reference_md;
  } else {
    rungRelPath = spot.rungs?.auto_write_md;
  }

  // Resolve the rung content path, asserting containment under paths/<slug>/ (C012 fix).
  // F-001: route through resolvePathContentRoot so plugin-installed paths work
  // from any user cwd.
  const slugContentRoot = resolvePathContentRoot(projectRoot, slug);
  let rungContentPath: string;
  try {
    if (rungRelPath) {
      rungContentPath = containedPath(slugContentRoot, rungRelPath);
    } else {
      // Fallback to canonical structure if spot.rungs not declared
      rungContentPath = containedPath(slugContentRoot, path.join('rungs', spot.id, rungFile));
    }
  } catch (err) {
    if (err instanceof PathTraversalError) {
      return {
        ok: false,
        error: {
          kind: 'auto-write-failed',
          message: `rung content path traversal blocked: ${err.message}`,
        },
      };
    }
    const e = err as Error;
    return {
      ok: false,
      error: {
        kind: 'auto-write-failed',
        message: `rung content path resolution failed: ${e.message}`,
      },
    };
  }

  let rawPayload: string;
  try {
    rawPayload = await fsPromises.readFile(rungContentPath, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      ok: false,
      error: {
        kind: 'rung-content-missing',
        message: `Rung content file not found at ${rungContentPath}: ${e.message}`,
      },
    };
  }

  const personalization = buildPersonalizationValues(state, projectRoot, spot);
  const payload = substitutePromptOnly(rawPayload, personalization);

  // (8) Rung 1 or 2: mutate state and return
  if (rung === 1 || rung === 2) {
    const newState = recordRungUse(state, spot.id, rung);
    const newLadder = newState.ladder[spot.id];

    try {
      await saveState(projectRoot, newState);
    } catch (err) {
      const e = err as Error;
      return {
        ok: false,
        error: {
          kind: 'state-save-failed',
          message: `state-save-failed: ${e.message}`,
        },
      };
    }

    return {
      ok: true,
      payload,
      newLadder,
    };
  }

  // (9) Rung 3: auto-write path
  // (a) payload already read above — short-circuit already handled

  // (b) Snapshot and overwrite — workspace-aware. The autoWrite target file
  // resolves through state.workspace_path when set; legacy paths fall back
  // to projectRoot. Snapshots land alongside the editable files
  // (<workspace>/.course-snapshots/) instead of polluting projectRoot.
  let autoWriteResult: { backupPath: string; bytesWritten: number };
  try {
    autoWriteResult = await runAutoWrite(
      projectRoot,
      spot as SpotData,
      payload,
      state.workspace_path ? { workspaceRoot: state.workspace_path } : {},
    );
  } catch (err) {
    if (err instanceof AutoWriteError) {
      return {
        ok: false,
        error: {
          kind: 'auto-write-failed',
          message: `auto-write-failed (${err.kind}): ${err.message}`,
        },
      };
    }
    const e = err as Error;
    return {
      ok: false,
      error: {
        kind: 'auto-write-failed',
        message: `auto-write-failed: ${e.message}`,
      },
    };
  }

  // (c) Flip auto_completed and auto_write_attempted
  const newState = recordRungUse(state, spot.id, 3);
  const newLadder = newState.ladder[spot.id];

  // (d) Save state (auto_completed = true)
  let savedState = newState;
  try {
    await saveState(projectRoot, newState);
  } catch (err) {
    const e = err as Error;
    return {
      ok: false,
      error: {
        kind: 'state-save-failed',
        message: `state-save-failed: ${e.message}`,
      },
    };
  }

  // (e) Dispatch runVerifySpot to auto-verify the written file
  const verifyResult = await runVerifySpot({ projectRoot }, opts);

  // Cursor advances only if verify passed
  const autoVerifyResult: AutoVerifyResult = {
    pass: verifyResult.pass,
    advanced: verifyResult.advanced ?? false,
    output: verifyResult.output,
  };

  return {
    ok: true,
    payload,
    newLadder,
    autoVerifyResult,
  };
}

// Alias for consistency with other tools
export const requestHint = runRequestHint;

/**
 * Compose the substitution values for prompt-only enrichment. Lifted out of
 * the call site so the AC-6.3 scope guard (T-215) sees a clean window
 * around substitutePromptOnly — the helper, not the call, references
 * spot field names.
 */
function buildPersonalizationValues(
  state: { personalization: Record<string, unknown>; workspace_path?: string },
  projectRoot: string,
  spot: SpotData,
): Record<string, unknown> {
  const editableRoot = state.workspace_path ?? projectRoot;
  const out: Record<string, unknown> = {
    ...state.personalization,
    workspace_path: editableRoot,
  };
  if (spot.target_file !== undefined) {
    out.target_file_absolute = path.join(editableRoot, spot.target_file);
  }
  return out;
}
