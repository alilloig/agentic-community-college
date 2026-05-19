// configureWorkspace — read/write the user-level ACC settings at
// `~/.acc/config.json`. Called by the conductor when a learner first runs
// `selectLesson` without an existing config, and on demand for hand-edits
// the user wants to drive through the tool surface.
//
// Semantics:
//   - No args / empty patch → returns the current effective config (defaults
//     when no file exists, plus a `fromDisk` flag so the conductor knows
//     whether a save is still pending).
//   - `workspace_root` overwrites the existing root.
//   - `course_paths` is DEEP-MERGED into the existing block: a partial patch
//     touching one plugin's `sandbox` id leaves every other plugin / id
//     untouched. To DELETE an id, hand-edit the file.

import { probeOutputStyle } from '../outputStyle.js';
import {
  accConfigExists,
  loadAccConfig,
  saveAccConfig,
  mergeAccConfig,
  AccConfigError,
  type AccConfig,
} from '../settings.js';

export interface ConfigureWorkspaceArgs {
  workspace_root?: string;
  course_paths?: Record<string, Record<string, string>>;
  /** Test seam. Defaults to `os.homedir()`. */
  homeDir?: string;
}

export interface ConfigureWorkspaceResult {
  ok: boolean;
  /** Effective config after the call (always present on `ok: true`). */
  config?: AccConfig;
  /** True if `~/.acc/config.json` existed at call time. Conductors use this
   * to decide whether to render the first-run prompt. */
  fromDisk?: boolean;
  /** True iff this call mutated state (workspace_root or course_paths changed). */
  saved?: boolean;
  errors?: string[];
}

export async function runConfigureWorkspace(
  args: ConfigureWorkspaceArgs = {},
): Promise<ConfigureWorkspaceResult> {
  const styleCheck = await probeOutputStyle();
  if (!styleCheck.ok) {
    return { ok: false, errors: ['output-style-disabled'] };
  }

  const { workspace_root, course_paths, homeDir } = args;
  let current: AccConfig;
  let fromDisk: boolean;
  try {
    fromDisk = await accConfigExists(homeDir);
    current = await loadAccConfig(homeDir);
  } catch (err) {
    if (err instanceof AccConfigError) {
      return { ok: false, errors: [`acc-config-${err.kind}: ${err.message}`] };
    }
    return { ok: false, errors: [`acc-config-read-failed: ${(err as Error).message}`] };
  }

  const noPatch = workspace_root === undefined && course_paths === undefined;
  if (noPatch) {
    return { ok: true, config: current, fromDisk, saved: false };
  }

  const patch: { workspace_root?: string; course_paths?: Record<string, Record<string, string>> } = {};
  if (workspace_root !== undefined) patch.workspace_root = workspace_root;
  if (course_paths !== undefined) patch.course_paths = course_paths;

  let next: AccConfig;
  try {
    next = mergeAccConfig(current, patch);
  } catch (err) {
    if (err instanceof AccConfigError) {
      return { ok: false, errors: [`acc-config-${err.kind}: ${err.message}`] };
    }
    return { ok: false, errors: [`acc-config-merge-failed: ${(err as Error).message}`] };
  }

  // Skip the write when nothing actually changed (idempotent re-runs from
  // the conductor when the user re-confirmed the same defaults).
  if (JSON.stringify(next) === JSON.stringify(current) && fromDisk) {
    return { ok: true, config: next, fromDisk, saved: false };
  }

  try {
    await saveAccConfig(next, homeDir);
  } catch (err) {
    if (err instanceof AccConfigError) {
      return { ok: false, errors: [`acc-config-save-${err.kind}: ${err.message}`] };
    }
    return { ok: false, errors: [`acc-config-save-failed: ${(err as Error).message}`] };
  }

  return { ok: true, config: next, fromDisk: true, saved: true };
}
