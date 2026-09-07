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
//     untouched.
//   - `null` sentinels delete: `course_paths['x@1']: null` drops the whole
//     plugin block; `course_paths['x@1']: { sandbox: null }` drops just that id.

import {
  accConfigExists,
  loadAccConfig,
  saveAccConfig,
  mergeAccConfig,
  AccConfigError,
  type AccConfig,
  type AccConfigPatch,
} from '../settings.js';

export interface ConfigureWorkspaceArgs {
  workspace_root?: string;
  /** Per-course path overrides. A `null` leaf removes the id; a `null` value
   * for a whole plugin key removes its entire block. */
  course_paths?: Record<string, Record<string, string | null> | null>;
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

/**
 * Structural deep-equal for AccConfig instances. Avoids the JSON.stringify
 * trap where key-ordering changes (from a hand-edit that re-orders fields)
 * would spuriously trigger an idempotent re-write.
 */
function configsEqual(a: AccConfig, b: AccConfig): boolean {
  if (a.workspace_root !== b.workspace_root) return false;
  const aPlugins = Object.keys(a.course_paths).sort();
  const bPlugins = Object.keys(b.course_paths).sort();
  if (aPlugins.length !== bPlugins.length) return false;
  for (let i = 0; i < aPlugins.length; i++) {
    if (aPlugins[i] !== bPlugins[i]) return false;
    const aIds = a.course_paths[aPlugins[i]] ?? {};
    const bIds = b.course_paths[bPlugins[i]] ?? {};
    const aIdKeys = Object.keys(aIds).sort();
    const bIdKeys = Object.keys(bIds).sort();
    if (aIdKeys.length !== bIdKeys.length) return false;
    for (let j = 0; j < aIdKeys.length; j++) {
      if (aIdKeys[j] !== bIdKeys[j]) return false;
      if (aIds[aIdKeys[j]] !== bIds[bIdKeys[j]]) return false;
    }
  }
  return true;
}

export async function runConfigureWorkspace(
  args: ConfigureWorkspaceArgs = {},
): Promise<ConfigureWorkspaceResult> {
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

  const patch: AccConfigPatch = {};
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

  // Skip the write when nothing actually changed AND the file already exists
  // on disk. (Pre-first-run with a patch identical to defaults still persists
  // so the first-run nudge stops firing.)
  if (fromDisk && configsEqual(next, current)) {
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
