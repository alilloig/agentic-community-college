import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type { State } from './schemas/state.js';
import type { SpotData } from './schemas/phases.js';
import { containedPath, PathTraversalError } from './pathSafety.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutoWriteErrorKind =
  | 'target-file-missing'
  | 'target-range-invalid'
  | 'snapshot-write-failed'
  | 'overwrite-failed'
  | 'path-traversal';

export class AutoWriteError extends Error {
  public readonly kind: AutoWriteErrorKind;
  constructor(kind: AutoWriteErrorKind, message: string) {
    super(message);
    this.name = 'AutoWriteError';
    this.kind = kind;
  }
}

export interface AutoWriteResult {
  backupPath: string;
  bytesWritten: number;
}

// ---------------------------------------------------------------------------
// recordRungUse — append-only ladder mutations (AC-5.2)
// ---------------------------------------------------------------------------

/**
 * Returns a new State whose ladder[spotId] has the rung's flag set to true.
 * Rung 1 → hint_used
 * Rung 2 → reference_shown
 * Rung 3 → auto_completed + auto_write_attempted
 * Never sets a flag from true to false.
 */
export function recordRungUse(state: State, spotId: string, rung: 1 | 2 | 3): State {
  const existing = state.ladder[spotId] ?? {
    hint_used: false,
    reference_shown: false,
    auto_completed: false,
    auto_write_attempted: false,
  };

  const updated = { ...existing };

  if (rung === 1) {
    updated.hint_used = true;
  } else if (rung === 2) {
    updated.reference_shown = true;
  } else {
    // rung === 3
    updated.auto_completed = true;
    updated.auto_write_attempted = true;
  }

  return {
    ...state,
    ladder: {
      ...state.ladder,
      [spotId]: updated,
    },
  };
}

// ---------------------------------------------------------------------------
// canAdvanceRung — rung gating (AC-5.1)
// ---------------------------------------------------------------------------

export type CanAdvanceRungResult =
  | { ok: true }
  | { ok: false; missingFlag: 'hint_used' | 'reference_shown'; requiredPriorRung: 1 | 2 };

/**
 * Check whether the given rung can be requested.
 * Rung 1: always ok.
 * Rung 2: requires hint_used === true.
 * Rung 3: requires reference_shown === true.
 */
export function canAdvanceRung(
  state: State,
  spotId: string,
  rung: 1 | 2 | 3,
): CanAdvanceRungResult {
  if (rung === 1) {
    return { ok: true };
  }

  const entry = state.ladder[spotId];

  if (rung === 2) {
    if (entry?.hint_used === true) {
      return { ok: true };
    }
    return { ok: false, missingFlag: 'hint_used', requiredPriorRung: 1 };
  }

  // rung === 3
  if (entry?.reference_shown === true) {
    return { ok: true };
  }
  return { ok: false, missingFlag: 'reference_shown', requiredPriorRung: 2 };
}

// ---------------------------------------------------------------------------
// runAutoWrite — snapshot-then-overwrite (A7)
// ---------------------------------------------------------------------------

const LEGACY_STATE_DIR = '.sui-deepbook-course';
const LEGACY_SNAPSHOTS_DIR = 'snapshots';
const WORKSPACE_SNAPSHOTS_DIR = '.course-snapshots';

export interface RunAutoWriteOptions {
  /** Workspace root for the active path. When set, target_file resolves
   * against it and snapshots land under <workspace>/.course-snapshots/.
   * When undefined (legacy path), target_file resolves against projectRoot
   * and snapshots land under <projectRoot>/.sui-deepbook-course/snapshots/. */
  workspaceRoot?: string;
}

/**
 * Snapshot the existing target_range bytes to a .bak file, then overwrite
 * that range with the substituted payload.
 *
 * Step ordering:
 *  (a) Read target_file (reject on ENOENT)
 *  (b) Parse + validate target_range
 *  (c) Write snapshot .bak (wx + 0o600), rotate any existing .bak first
 *  (d) Overwrite target_file with the spliced payload
 *
 * Returns { backupPath, bytesWritten }.
 */
export async function runAutoWrite(
  projectRoot: string,
  spot: Pick<SpotData, 'id' | 'target_file' | 'target_range'>,
  payload: string,
  opts: RunAutoWriteOptions = {},
): Promise<AutoWriteResult> {
  // (a) Resolve and contain target_file path (C021 fix). When the path
  // declares a workspace, files are anchored there; otherwise legacy mode
  // anchors at projectRoot.
  const editableRoot = opts.workspaceRoot ?? projectRoot;
  let targetFilePath: string;
  try {
    targetFilePath = containedPath(editableRoot, spot.target_file!);
  } catch (err) {
    if (err instanceof PathTraversalError) {
      throw new AutoWriteError(
        'path-traversal',
        `target_file path traversal blocked: ${err.message}`,
      );
    }
    throw err;
  }

  // Read existing target file
  let existingContent: string;
  try {
    existingContent = await fsPromises.readFile(targetFilePath, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new AutoWriteError('target-file-missing', `Target file not found: ${targetFilePath}`);
    }
    throw new AutoWriteError('target-file-missing', `Failed to read target file: ${e.message}`);
  }

  // (b) Parse and validate target_range (1-indexed inclusive)
  const rangeStr = spot.target_range ?? '';
  const rangeMatch = rangeStr.match(/^(\d+)-(\d+)$/);
  let startLine: number;
  let endLine: number;

  if (!rangeMatch) {
    throw new AutoWriteError(
      'target-range-invalid',
      `Cannot parse target_range: '${rangeStr}' — expected format like '39-58'`,
    );
  }

  startLine = parseInt(rangeMatch[1], 10);
  endLine = parseInt(rangeMatch[2], 10);
  const lines = existingContent.split('\n');
  const totalLines = lines.length;

  if (
    startLine < 1 ||
    endLine < startLine ||
    startLine > totalLines ||
    endLine > totalLines
  ) {
    throw new AutoWriteError(
      'target-range-invalid',
      `target_range '${rangeStr}' is out of bounds (file has ${totalLines} lines, 1-indexed)`,
    );
  }

  // Extract the slice (1-indexed inclusive → 0-indexed)
  const sliceStart = startLine - 1;
  const sliceEnd = endLine; // exclusive for JS slice
  const originalSlice = lines.slice(sliceStart, sliceEnd);
  const snapshotContent = originalSlice.join('\n');

  // (c) Write snapshot to .bak. Workspace-aware paths keep snapshots beside
  // the editable files; legacy paths preserve the historical location under
  // projectRoot/.sui-deepbook-course/snapshots/.
  const snapshotsDir = opts.workspaceRoot
    ? path.join(opts.workspaceRoot, WORKSPACE_SNAPSHOTS_DIR)
    : path.join(projectRoot, LEGACY_STATE_DIR, LEGACY_SNAPSHOTS_DIR);
  await fsPromises.mkdir(snapshotsDir, { recursive: true });

  // Resolve and contain the bak path (C022 fix) — spot.id flows into filename
  let bakPath: string;
  try {
    bakPath = containedPath(snapshotsDir, `${spot.id}.bak`);
  } catch (err) {
    if (err instanceof PathTraversalError) {
      throw new AutoWriteError(
        'path-traversal',
        `spot.id path traversal blocked: ${err.message}`,
      );
    }
    throw err;
  }

  // Rotate existing .bak if present
  try {
    await fsPromises.access(bakPath);
    // File exists — rotate it
    const ts = new Date().toISOString().replace(/:/g, '');
    const rotatedPath = `${bakPath}.${ts}`;
    await fsPromises.rename(bakPath, rotatedPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // ENOENT means it doesn't exist — that's fine
    if (e.code !== 'ENOENT') {
      throw new AutoWriteError(
        'snapshot-write-failed',
        `Failed to rotate existing snapshot: ${e.message}`,
      );
    }
  }

  // Write the snapshot with wx flag and mode 0o600
  try {
    await fsPromises.writeFile(bakPath, snapshotContent, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new AutoWriteError(
      'snapshot-write-failed',
      `Failed to write snapshot file: ${e.message}`,
    );
  }

  // (d) Splice payload into lines and overwrite target_file
  const payloadLines = payload.split('\n');
  const newLines = [
    ...lines.slice(0, sliceStart),
    ...payloadLines,
    ...lines.slice(sliceEnd),
  ];
  const newContent = newLines.join('\n');

  try {
    await fsPromises.writeFile(targetFilePath, newContent, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new AutoWriteError(
      'overwrite-failed',
      `Failed to overwrite target file: ${e.message}`,
    );
  }

  const bytesWritten = Buffer.byteLength(snapshotContent, 'utf8');

  return {
    backupPath: bakPath,
    bytesWritten,
  };
}
