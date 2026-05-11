// Schema for the per-workspace metadata file (.course-state.json) written
// inside each path's lesson workspace under
// ~/.sui-deepbook-course/workspaces/<slug>/.course-state.json.
//
// This file lets prepareWorkspace decide whether an existing workspace can be
// reused as-is (host_signature matches the path's current host tarball) or
// whether it must be archived and recreated. Kept separate from the main
// learner state.json — workspace metadata answers "is this workspace fresh?"
// while state.json answers "where is the learner in the lesson?".

export const WORKSPACE_META_SCHEMA_VERSION = 1;

export interface WorkspaceMeta {
  schema_version: number;
  path_slug: string;
  /** ISO-8601 timestamp at create time. */
  created_at: string;
  /** Workspace-relative paths of starter files copied in on creation. */
  starter_files: string[];
  /** sha256 (hex) of the host tarball that seeded the workspace. Mismatch
   * with the current path's host triggers archive + recreate on the next
   * prepareWorkspace call. */
  host_signature: string;
}

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function validateWorkspaceMeta(v: unknown): ValidationResult<WorkspaceMeta> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { ok: false, error: 'workspace meta must be a non-null object' };
  }
  const obj = v as Record<string, unknown>;

  if (typeof obj['schema_version'] !== 'number') {
    return { ok: false, error: 'schema_version must be a number' };
  }
  if (typeof obj['path_slug'] !== 'string' || obj['path_slug'].length === 0) {
    return { ok: false, error: 'path_slug must be a non-empty string' };
  }
  if (typeof obj['created_at'] !== 'string') {
    return { ok: false, error: 'created_at must be a string' };
  }
  if (typeof obj['host_signature'] !== 'string' || obj['host_signature'].length === 0) {
    return { ok: false, error: 'host_signature must be a non-empty string' };
  }
  if (!Array.isArray(obj['starter_files'])) {
    return { ok: false, error: 'starter_files must be an array' };
  }
  for (const f of obj['starter_files'] as unknown[]) {
    if (typeof f !== 'string') {
      return { ok: false, error: 'starter_files entries must be strings' };
    }
  }

  return {
    ok: true,
    value: {
      schema_version: obj['schema_version'] as number,
      path_slug: obj['path_slug'] as string,
      created_at: obj['created_at'] as string,
      starter_files: [...(obj['starter_files'] as string[])],
      host_signature: obj['host_signature'] as string,
    },
  };
}
