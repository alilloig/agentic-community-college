export type PersonalizationOption = 'poll_interval_ms' | 'pool_subset';

const VALID_PERSONALIZATION_OPTIONS: ReadonlySet<string> = new Set([
  'poll_interval_ms',
  'pool_subset',
]);

export interface PersonalizationRangeInteger {
  min: number;
  max: number;
  default: number;
}

export interface PersonalizationRangeEnum {
  values: string[];
  default: string;
}

export interface PersonalizationRanges {
  poll_interval_ms?: PersonalizationRangeInteger;
  pool_subset?: PersonalizationRangeEnum;
}

export interface WorkspaceFileSpec {
  /** Workspace-relative path where the editable file lives. */
  path: string;
  /** Path-relative location of the starter content copied into the workspace
   * on first prepareWorkspace. */
  starter: string;
}

export interface WorkspaceConfig {
  files: WorkspaceFileSpec[];
  /** Path-relative directory whose contents seed the workspace alongside the
   * starter files (package.json, vite.config.ts, tsconfig*, index.html, etc.). */
  host: string;
  /** Command run inside the workspace after seeding. Empty/undefined skips it. */
  host_install_command?: string;
  /** Workspace-relative directory where verifications run. Defaults to "." */
  verification_cwd?: string;
}

export interface PathData {
  slug: string;
  title: string;
  summary: string;
  personalization_options: PersonalizationOption[];
  build_command: string;
  personalization_ranges?: PersonalizationRanges;
  /** Optional workspace config. Paths without it use legacy projectRoot
   * verification (kept for backward compat with existing fixtures/tests). */
  workspace?: WorkspaceConfig;
}

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function validatePath(v: unknown): ValidationResult<PathData> {
  if (typeof v !== 'object' || v === null) {
    return { ok: false, error: 'path.json must be an object' };
  }
  const obj = v as Record<string, unknown>;

  if (typeof obj['slug'] !== 'string' || obj['slug'].length === 0) {
    return { ok: false, error: 'Missing required field: slug' };
  }
  if (typeof obj['title'] !== 'string') {
    return { ok: false, error: 'Missing required field: title' };
  }
  if (typeof obj['summary'] !== 'string') {
    return { ok: false, error: 'Missing required field: summary' };
  }
  if (typeof obj['build_command'] !== 'string') {
    return { ok: false, error: 'Missing required field: build_command' };
  }
  if (!Array.isArray(obj['personalization_options'])) {
    return { ok: false, error: 'personalization_options must be an array' };
  }
  for (const opt of obj['personalization_options'] as unknown[]) {
    if (typeof opt !== 'string' || !VALID_PERSONALIZATION_OPTIONS.has(opt)) {
      return {
        ok: false,
        error: `Invalid personalization_options value: ${String(opt)}. Allowed: ${[...VALID_PERSONALIZATION_OPTIONS].join(', ')}`,
      };
    }
  }

  // Validate optional personalization_ranges if present
  let personalization_ranges: PersonalizationRanges | undefined;
  if (obj['personalization_ranges'] !== undefined) {
    if (typeof obj['personalization_ranges'] !== 'object' || obj['personalization_ranges'] === null) {
      return { ok: false, error: 'personalization_ranges must be an object' };
    }
    const pr = obj['personalization_ranges'] as Record<string, unknown>;
    personalization_ranges = {};

    if (pr['poll_interval_ms'] !== undefined) {
      if (typeof pr['poll_interval_ms'] !== 'object' || pr['poll_interval_ms'] === null) {
        return { ok: false, error: 'personalization_ranges.poll_interval_ms must be an object' };
      }
      const pim = pr['poll_interval_ms'] as Record<string, unknown>;
      if (typeof pim['min'] !== 'number' || typeof pim['max'] !== 'number' || typeof pim['default'] !== 'number') {
        return { ok: false, error: 'personalization_ranges.poll_interval_ms requires min, max, default as numbers' };
      }
      if (pim['min'] > pim['max']) {
        return { ok: false, error: 'personalization_ranges.poll_interval_ms: min must not exceed max' };
      }
      personalization_ranges.poll_interval_ms = {
        min: pim['min'] as number,
        max: pim['max'] as number,
        default: pim['default'] as number,
      };
    }

    if (pr['pool_subset'] !== undefined) {
      if (typeof pr['pool_subset'] !== 'object' || pr['pool_subset'] === null) {
        return { ok: false, error: 'personalization_ranges.pool_subset must be an object' };
      }
      const ps = pr['pool_subset'] as Record<string, unknown>;
      if (!Array.isArray(ps['values'])) {
        return { ok: false, error: 'personalization_ranges.pool_subset.values must be an array' };
      }
      if (typeof ps['default'] !== 'string') {
        return { ok: false, error: 'personalization_ranges.pool_subset.default must be a string' };
      }
      personalization_ranges.pool_subset = {
        values: ps['values'] as string[],
        default: ps['default'] as string,
      };
    }
  }

  // Validate optional workspace block
  let workspace: WorkspaceConfig | undefined;
  if (obj['workspace'] !== undefined) {
    if (typeof obj['workspace'] !== 'object' || obj['workspace'] === null) {
      return { ok: false, error: 'workspace must be an object' };
    }
    const w = obj['workspace'] as Record<string, unknown>;
    if (typeof w['host'] !== 'string' || w['host'].length === 0) {
      return { ok: false, error: 'workspace.host must be a non-empty string' };
    }
    if (!isWorkspaceRelPath(w['host'] as string)) {
      return {
        ok: false,
        error: `workspace.host '${w['host']}' must be a relative path with no '..' segments and no leading '/'`,
      };
    }
    if (!Array.isArray(w['files']) || w['files'].length === 0) {
      return { ok: false, error: 'workspace.files must be a non-empty array' };
    }
    const files: WorkspaceFileSpec[] = [];
    for (const f of w['files'] as unknown[]) {
      if (typeof f !== 'object' || f === null) {
        return { ok: false, error: 'workspace.files[] entries must be objects' };
      }
      const fo = f as Record<string, unknown>;
      if (typeof fo['path'] !== 'string' || typeof fo['starter'] !== 'string') {
        return { ok: false, error: 'workspace.files[].path and .starter must be strings' };
      }
      if (!isWorkspaceRelPath(fo['path'] as string)) {
        return {
          ok: false,
          error: `workspace.files[].path '${fo['path']}' must be a relative path with no '..' segments and no leading '/'`,
        };
      }
      if (!isWorkspaceRelPath(fo['starter'] as string)) {
        return {
          ok: false,
          error: `workspace.files[].starter '${fo['starter']}' must be a relative path with no '..' segments and no leading '/'`,
        };
      }
      files.push({ path: fo['path'] as string, starter: fo['starter'] as string });
    }
    workspace = { files, host: w['host'] as string };
    if (w['host_install_command'] !== undefined) {
      if (typeof w['host_install_command'] !== 'string') {
        return { ok: false, error: 'workspace.host_install_command must be a string' };
      }
      workspace.host_install_command = w['host_install_command'] as string;
    }
    if (w['verification_cwd'] !== undefined) {
      if (typeof w['verification_cwd'] !== 'string') {
        return { ok: false, error: 'workspace.verification_cwd must be a string' };
      }
      if (!isWorkspaceRelPath(w['verification_cwd'] as string)) {
        return {
          ok: false,
          error: `workspace.verification_cwd '${w['verification_cwd']}' must be a relative path with no '..' segments and no leading '/'`,
        };
      }
      workspace.verification_cwd = w['verification_cwd'] as string;
    }
  }

  const result: PathData = {
    slug: obj['slug'] as string,
    title: obj['title'] as string,
    summary: obj['summary'] as string,
    personalization_options: obj['personalization_options'] as PersonalizationOption[],
    build_command: obj['build_command'] as string,
  };
  if (personalization_ranges !== undefined) {
    result.personalization_ranges = personalization_ranges;
  }
  if (workspace !== undefined) {
    result.workspace = workspace;
  }
  return { ok: true, value: result };
}

// Mirrors phases.ts:isValidRelPath. Kept private here to avoid cross-schema
// imports; the rule is the same: no leading slash and no '..' segment.
function isWorkspaceRelPath(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  const segments = p.replace(/\\/g, '/').split('/');
  return !segments.includes('..');
}
