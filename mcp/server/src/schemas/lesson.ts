// lesson.ts — validator for the lesson manifest (`<lesson>/lesson.json`).
//
// Successor to path.ts. Differences from path.ts:
//   1. Personalization keys are course-defined free-form strings (no hardcoded
//      'poll_interval_ms' | 'pool_subset' allowlist); ranges follow the same
//      schema but key-by-key by name.
//   2. New `artifact` block names the HTML template + state filename the
//      runtime should manage for the evolving visual artifact.
//   3. New optional `test_command` field. If absent, `build_command` is used
//      by the final verification gate.
//
// Path safety: every relative-path field is enforced via `isLessonRelPath`,
// which rejects leading slashes and any `..` segment. Mirrors path.ts's
// guard.

export interface PersonalizationRangeInteger {
  min: number;
  max: number;
  default: number;
}

export interface PersonalizationRangeEnum {
  values: string[];
  default: string;
}

export type PersonalizationRange = PersonalizationRangeInteger | PersonalizationRangeEnum;

/** Free-form: key is the personalization option name (course-defined). */
export type PersonalizationRanges = Record<string, PersonalizationRange>;

export interface WorkspaceFileSpec {
  path: string;
  starter: string;
}

export interface WorkspaceConfig {
  files: WorkspaceFileSpec[];
  host: string;
  host_install_command?: string;
  verification_cwd?: string;
}

export interface ArtifactConfig {
  /** Lesson-relative path to the HTML template. */
  template: string;
  /** Filename written into the workspace (sibling to artifact.html). Default: "artifact-state.json". */
  state_filename?: string;
}

export interface LessonData {
  slug: string;
  title: string;
  summary: string;
  /** Course-defined personalization option names. May be empty. */
  personalization_options: string[];
  /** Default build/verify command for the workspace. */
  build_command: string;
  /** Optional test-suite command for the final equivalence gate. */
  test_command?: string;
  personalization_ranges?: PersonalizationRanges;
  workspace?: WorkspaceConfig;
  artifact?: ArtifactConfig;
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isLessonRelPath(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  const segments = p.replace(/\\/g, '/').split('/');
  return !segments.includes('..');
}

function isInteger(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n);
}

export function validateLesson(v: unknown): ValidationResult<LessonData> {
  if (typeof v !== 'object' || v === null) {
    return { ok: false, error: 'lesson.json must be an object' };
  }
  const obj = v as Record<string, unknown>;

  if (typeof obj['slug'] !== 'string' || obj['slug'].length === 0) {
    return { ok: false, error: 'Missing required field: slug' };
  }
  if (typeof obj['title'] !== 'string' || obj['title'].length === 0) {
    return { ok: false, error: 'Missing required field: title' };
  }
  if (typeof obj['summary'] !== 'string') {
    return { ok: false, error: 'Missing required field: summary' };
  }
  if (typeof obj['build_command'] !== 'string' || obj['build_command'].length === 0) {
    return { ok: false, error: 'Missing required field: build_command' };
  }
  if (!Array.isArray(obj['personalization_options'])) {
    return { ok: false, error: 'personalization_options must be an array' };
  }
  for (const opt of obj['personalization_options'] as unknown[]) {
    if (typeof opt !== 'string' || opt.length === 0) {
      return {
        ok: false,
        error: `personalization_options entries must be non-empty strings, got ${JSON.stringify(opt)}`,
      };
    }
  }
  const declaredKeys = new Set(obj['personalization_options'] as string[]);

  let test_command: string | undefined;
  if (obj['test_command'] !== undefined) {
    if (typeof obj['test_command'] !== 'string' || (obj['test_command'] as string).length === 0) {
      return { ok: false, error: 'test_command must be a non-empty string if present' };
    }
    test_command = obj['test_command'] as string;
  }

  let personalization_ranges: PersonalizationRanges | undefined;
  if (obj['personalization_ranges'] !== undefined) {
    if (
      typeof obj['personalization_ranges'] !== 'object' ||
      obj['personalization_ranges'] === null ||
      Array.isArray(obj['personalization_ranges'])
    ) {
      return { ok: false, error: 'personalization_ranges must be an object' };
    }
    personalization_ranges = {};
    for (const [key, rawRange] of Object.entries(
      obj['personalization_ranges'] as Record<string, unknown>,
    )) {
      if (!declaredKeys.has(key)) {
        return {
          ok: false,
          error: `personalization_ranges.${key} is not listed in personalization_options`,
        };
      }
      if (typeof rawRange !== 'object' || rawRange === null) {
        return { ok: false, error: `personalization_ranges.${key} must be an object` };
      }
      const r = rawRange as Record<string, unknown>;
      // Two shapes: integer-range or enum.
      if (Array.isArray(r['values'])) {
        // enum shape
        for (const val of r['values']) {
          if (typeof val !== 'string') {
            return {
              ok: false,
              error: `personalization_ranges.${key}.values must contain only strings`,
            };
          }
        }
        if (typeof r['default'] !== 'string') {
          return {
            ok: false,
            error: `personalization_ranges.${key}.default must be a string`,
          };
        }
        if (!(r['values'] as string[]).includes(r['default'] as string)) {
          return {
            ok: false,
            error: `personalization_ranges.${key}.default '${r['default']}' is not in values`,
          };
        }
        personalization_ranges[key] = {
          values: r['values'] as string[],
          default: r['default'] as string,
        };
      } else {
        // integer-range shape
        if (!isInteger(r['min']) || !isInteger(r['max']) || !isInteger(r['default'])) {
          return {
            ok: false,
            error: `personalization_ranges.${key} requires integer min, max, default`,
          };
        }
        if ((r['min'] as number) > (r['max'] as number)) {
          return {
            ok: false,
            error: `personalization_ranges.${key}: min must not exceed max`,
          };
        }
        if (
          (r['default'] as number) < (r['min'] as number) ||
          (r['default'] as number) > (r['max'] as number)
        ) {
          return {
            ok: false,
            error: `personalization_ranges.${key}: default ${r['default']} out of [${r['min']}, ${r['max']}]`,
          };
        }
        personalization_ranges[key] = {
          min: r['min'] as number,
          max: r['max'] as number,
          default: r['default'] as number,
        };
      }
    }
  }

  let workspace: WorkspaceConfig | undefined;
  if (obj['workspace'] !== undefined) {
    if (typeof obj['workspace'] !== 'object' || obj['workspace'] === null) {
      return { ok: false, error: 'workspace must be an object' };
    }
    const w = obj['workspace'] as Record<string, unknown>;
    if (typeof w['host'] !== 'string' || w['host'].length === 0) {
      return { ok: false, error: 'workspace.host must be a non-empty string' };
    }
    if (!isLessonRelPath(w['host'] as string)) {
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
      if (!isLessonRelPath(fo['path'] as string) || !isLessonRelPath(fo['starter'] as string)) {
        return {
          ok: false,
          error: `workspace.files[] paths must be relative with no '..' segments and no leading '/'`,
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
      if (!isLessonRelPath(w['verification_cwd'] as string)) {
        return {
          ok: false,
          error: `workspace.verification_cwd '${w['verification_cwd']}' must be a relative path with no '..' segments and no leading '/'`,
        };
      }
      workspace.verification_cwd = w['verification_cwd'] as string;
    }
  }

  let artifact: ArtifactConfig | undefined;
  if (obj['artifact'] !== undefined) {
    if (typeof obj['artifact'] !== 'object' || obj['artifact'] === null) {
      return { ok: false, error: 'artifact must be an object' };
    }
    const a = obj['artifact'] as Record<string, unknown>;
    if (typeof a['template'] !== 'string' || a['template'].length === 0) {
      return { ok: false, error: 'artifact.template must be a non-empty string' };
    }
    if (!isLessonRelPath(a['template'] as string)) {
      return {
        ok: false,
        error: `artifact.template '${a['template']}' must be a lesson-relative path`,
      };
    }
    artifact = { template: a['template'] as string };
    if (a['state_filename'] !== undefined) {
      if (typeof a['state_filename'] !== 'string' || (a['state_filename'] as string).length === 0) {
        return { ok: false, error: 'artifact.state_filename must be a non-empty string' };
      }
      // Plain filename only — no slashes — to avoid escaping the workspace.
      if (/[\\/]/.test(a['state_filename'] as string)) {
        return { ok: false, error: 'artifact.state_filename must be a plain filename without slashes' };
      }
      artifact.state_filename = a['state_filename'] as string;
    }
  }

  const result: LessonData = {
    slug: obj['slug'] as string,
    title: obj['title'] as string,
    summary: obj['summary'] as string,
    personalization_options: obj['personalization_options'] as string[],
    build_command: obj['build_command'] as string,
  };
  if (test_command !== undefined) result.test_command = test_command;
  if (personalization_ranges !== undefined) result.personalization_ranges = personalization_ranges;
  if (workspace !== undefined) result.workspace = workspace;
  if (artifact !== undefined) result.artifact = artifact;
  return { ok: true, value: result };
}
