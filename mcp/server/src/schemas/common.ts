// Shared pieces of the manifest validators.

import { isSafeRelPath } from '../pathSafety.js';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validate an array of non-empty, safe relative paths. Absent (`undefined`) counts as empty. */
export function validateRelPathList(raw: unknown, where: string): ValidationResult<string[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: `${where} must be an array` };
  }
  const out: string[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'string' || entry.length === 0) {
      return { ok: false, error: `${where} entries must be non-empty strings` };
    }
    if (!isSafeRelPath(entry)) {
      return {
        ok: false,
        error: `${where} entry '${entry}' must be a relative path with no '..' segments and no leading '/'`,
      };
    }
    out.push(entry);
  }
  return { ok: true, value: out };
}
