// settings.ts — user-level ACC configuration at `~/.acc/config.json`.
//
// Two-tier path resolution starts here. This module owns the on-disk shape:
//   {
//     "workspace_root": "~/workspace",
//     "course_paths": {
//       "<plugin-key>": { "<path-id>": "<override-path>" }
//     }
//   }
//
// Reads tolerate a missing file (returns defaults without writing) so the
// first-run UX is "no config until something writes one." Reads refuse to
// silently overwrite a malformed file — the user can hand-edit, and corrupt
// JSON is more likely a half-applied edit than something we should clobber.
// Writes use atomicWriteFile so a partial save can't corrupt student state.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWriteFile } from './atomicWrite.js';

export interface AccConfig {
  /** Workspace-root the user picked. Stored with leading `~/` preserved so
   * the JSON stays portable across machines; `pathResolver` expands it on read. */
  workspace_root: string;
  /** Per-course path overrides: plugin key → path id → override value.
   * Values may be absolute or `~/`-prefixed; the resolver expands at read time. */
  course_paths: Record<string, Record<string, string>>;
}

export class AccConfigError extends Error {
  constructor(
    public readonly kind: 'parse-failed' | 'invalid-shape' | 'read-failed',
    message: string,
  ) {
    super(message);
    this.name = 'AccConfigError';
  }
}

/** Hard-coded default. Mirrors the user's request in the plan: first-run UX
 * proposes `~/workspace` but doesn't commit anything until the user picks. */
const DEFAULT_WORKSPACE_ROOT = '~/workspace';

export function defaultAccConfig(): AccConfig {
  return { workspace_root: DEFAULT_WORKSPACE_ROOT, course_paths: {} };
}

export function configFilePath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.acc', 'config.json');
}

/**
 * True when `~/.acc/config.json` exists. Used by `selectLesson` to gate the
 * first-run nudge — calling `loadAccConfig` would swallow ENOENT into a
 * defaults envelope and we wouldn't be able to tell.
 */
export async function accConfigExists(homeDir: string = os.homedir()): Promise<boolean> {
  try {
    await fs.access(configFilePath(homeDir));
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the on-disk config or return defaults on ENOENT. Never writes from
 * inside the loader. Throws `AccConfigError` on malformed JSON or invalid
 * shape — the loader will not auto-rewrite a broken file because the student
 * may have a half-applied edit they want to recover.
 */
export async function loadAccConfig(homeDir: string = os.homedir()): Promise<AccConfig> {
  const p = configFilePath(homeDir);
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return defaultAccConfig();
    throw new AccConfigError(
      'read-failed',
      `Could not read ${p}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AccConfigError(
      'parse-failed',
      `${p} is not valid JSON: ${(err as Error).message}. Refusing to overwrite; fix or remove the file.`,
    );
  }
  return validateAccConfigShape(parsed, p);
}

/**
 * Persist a config atomically. Re-validates the shape before writing so the
 * caller can't accidentally serialize a corrupt object. Creates `~/.acc/`
 * if missing.
 */
export async function saveAccConfig(
  cfg: AccConfig,
  homeDir: string = os.homedir(),
): Promise<void> {
  validateAccConfigShape(cfg, '<save>');
  const p = configFilePath(homeDir);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await atomicWriteFile(p, JSON.stringify(cfg, null, 2) + '\n', {
    mode: 0o600,
    tmpPrefix: '.config.tmp',
  });
}

/**
 * Deep-merge update. Used by `configureWorkspace` so a partial update doesn't
 * blow away unrelated per-course overrides. `course_paths` is merged at two
 * levels: plugin key, then path id.
 */
export function mergeAccConfig(
  current: AccConfig,
  patch: { workspace_root?: string; course_paths?: Record<string, Record<string, string>> },
): AccConfig {
  const next: AccConfig = {
    workspace_root: current.workspace_root,
    course_paths: {},
  };
  if (patch.workspace_root !== undefined) {
    if (typeof patch.workspace_root !== 'string' || patch.workspace_root.length === 0) {
      throw new AccConfigError(
        'invalid-shape',
        `workspace_root must be a non-empty string`,
      );
    }
    next.workspace_root = patch.workspace_root;
  }
  for (const [plugin, ids] of Object.entries(current.course_paths)) {
    next.course_paths[plugin] = { ...ids };
  }
  if (patch.course_paths !== undefined) {
    if (
      typeof patch.course_paths !== 'object' ||
      patch.course_paths === null ||
      Array.isArray(patch.course_paths)
    ) {
      throw new AccConfigError(
        'invalid-shape',
        `course_paths must be an object`,
      );
    }
    for (const [plugin, ids] of Object.entries(patch.course_paths)) {
      if (typeof ids !== 'object' || ids === null || Array.isArray(ids)) {
        throw new AccConfigError(
          'invalid-shape',
          `course_paths['${plugin}'] must be an object`,
        );
      }
      const merged: Record<string, string> = { ...(next.course_paths[plugin] ?? {}) };
      for (const [id, val] of Object.entries(ids)) {
        if (typeof val !== 'string' || val.length === 0) {
          throw new AccConfigError(
            'invalid-shape',
            `course_paths['${plugin}']['${id}'] must be a non-empty string`,
          );
        }
        merged[id] = val;
      }
      next.course_paths[plugin] = merged;
    }
  }
  return next;
}

function validateAccConfigShape(parsed: unknown, where: string): AccConfig {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AccConfigError('invalid-shape', `${where}: config root must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj['workspace_root'] !== 'string' || (obj['workspace_root'] as string).length === 0) {
    throw new AccConfigError(
      'invalid-shape',
      `${where}: workspace_root must be a non-empty string`,
    );
  }

  const coursePaths: Record<string, Record<string, string>> = {};
  if (obj['course_paths'] !== undefined) {
    if (
      typeof obj['course_paths'] !== 'object' ||
      obj['course_paths'] === null ||
      Array.isArray(obj['course_paths'])
    ) {
      throw new AccConfigError(
        'invalid-shape',
        `${where}: course_paths must be an object`,
      );
    }
    for (const [pluginKey, inner] of Object.entries(
      obj['course_paths'] as Record<string, unknown>,
    )) {
      if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) {
        throw new AccConfigError(
          'invalid-shape',
          `${where}: course_paths['${pluginKey}'] must be an object`,
        );
      }
      const innerMap: Record<string, string> = {};
      for (const [id, val] of Object.entries(inner as Record<string, unknown>)) {
        if (typeof val !== 'string' || val.length === 0) {
          throw new AccConfigError(
            'invalid-shape',
            `${where}: course_paths['${pluginKey}']['${id}'] must be a non-empty string`,
          );
        }
        innerMap[id] = val;
      }
      coursePaths[pluginKey] = innerMap;
    }
  }

  return { workspace_root: obj['workspace_root'] as string, course_paths: coursePaths };
}
