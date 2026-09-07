// lesson.ts — validator for the lesson manifest (`<lesson>/lesson.json`), ACC v0.3.
//
// Changes from v0.2:
//   1. `build_command`, `test_command` and `artifact` are gone. Verification
//      lives per chapter in `chapters.json`; artifacts are generated at
//      runtime by the conductor.
//   2. `workspace.solution_files` lists the workspace-relative files that are
//      deleted from the seeded copy of `workspace.host`, so the learner's
//      workspace holds scaffold + tests, never the solution.
//   3. Optional `docs` names the lesson-relative directory that holds the
//      Phase 0 documentation snapshot.
//
// Unknown fields are ignored. Path safety: every relative-path field goes
// through `isLessonRelPath`, which rejects leading slashes and `..` segments.

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
  /** Lesson-relative directory copied whole into the workspace. */
  host: string;
  host_install_command?: string;
  verification_cwd?: string;
  /** Workspace-relative files deleted from the seeded copy. */
  solution_files: string[];
  /** Starter files copied in after stripping. */
  files: WorkspaceFileSpec[];
}

export interface LessonData {
  slug: string;
  title: string;
  summary: string;
  /** Course-defined personalization option names. May be empty. */
  personalization_options: string[];
  personalization_ranges?: PersonalizationRanges;
  /** Probe IDs the course-engine must pass before the learner starts. */
  prerequisites?: string[];
  /** Lesson-relative directory holding the Phase 0 docs snapshot. */
  docs?: string;
  workspace?: WorkspaceConfig;
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function isLessonRelPath(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  const segments = p.replace(/\\/g, '/').split('/');
  return !segments.includes('..');
}

function isInteger(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n);
}

export function validateLesson(v: unknown): ValidationResult<LessonData> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { ok: false, error: 'lesson.json must be an object' };
  }
  const obj = v as Record<string, unknown>;

  if (typeof obj['slug'] !== 'string' || obj['slug'].length === 0) {
    return { ok: false, error: 'Missing required field: slug' };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(obj['slug'] as string)) {
    return {
      ok: false,
      error: `slug '${obj['slug']}' must be filename-safe ([A-Za-z0-9._-], no leading dot)`,
    };
  }
  if (typeof obj['title'] !== 'string' || obj['title'].length === 0) {
    return { ok: false, error: 'Missing required field: title' };
  }
  if (typeof obj['summary'] !== 'string') {
    return { ok: false, error: 'Missing required field: summary' };
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
      if (Array.isArray(r['values'])) {
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

  let docs: string | undefined;
  if (obj['docs'] !== undefined) {
    if (typeof obj['docs'] !== 'string' || (obj['docs'] as string).length === 0) {
      return { ok: false, error: 'docs must be a non-empty string when present' };
    }
    if (!isLessonRelPath(obj['docs'] as string)) {
      return {
        ok: false,
        error: `docs '${obj['docs']}' must be a relative path with no '..' segments and no leading '/'`,
      };
    }
    docs = obj['docs'] as string;
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

    const rawFiles = w['files'] ?? [];
    if (!Array.isArray(rawFiles)) {
      return { ok: false, error: 'workspace.files must be an array' };
    }
    const files: WorkspaceFileSpec[] = [];
    for (const f of rawFiles as unknown[]) {
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

    const rawSolution = w['solution_files'] ?? [];
    if (!Array.isArray(rawSolution)) {
      return { ok: false, error: 'workspace.solution_files must be an array' };
    }
    const solution_files: string[] = [];
    for (const s of rawSolution as unknown[]) {
      if (typeof s !== 'string' || s.length === 0) {
        return { ok: false, error: 'workspace.solution_files entries must be non-empty strings' };
      }
      if (!isLessonRelPath(s)) {
        return {
          ok: false,
          error: `workspace.solution_files entry '${s}' must be a relative path with no '..' segments and no leading '/'`,
        };
      }
      solution_files.push(s);
    }

    workspace = { host: w['host'] as string, files, solution_files };
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

  let prerequisites: string[] | undefined;
  if (obj['prerequisites'] !== undefined) {
    if (!Array.isArray(obj['prerequisites'])) {
      return { ok: false, error: 'prerequisites must be an array when present' };
    }
    const list: string[] = [];
    for (const entry of obj['prerequisites'] as unknown[]) {
      if (typeof entry !== 'string' || entry.length === 0) {
        return {
          ok: false,
          error: `prerequisites entries must be non-empty strings (got ${JSON.stringify(entry)})`,
        };
      }
      list.push(entry);
    }
    prerequisites = list;
  }

  const result: LessonData = {
    slug: obj['slug'] as string,
    title: obj['title'] as string,
    summary: obj['summary'] as string,
    personalization_options: obj['personalization_options'] as string[],
  };
  if (personalization_ranges !== undefined) result.personalization_ranges = personalization_ranges;
  if (prerequisites !== undefined) result.prerequisites = prerequisites;
  if (docs !== undefined) result.docs = docs;
  if (workspace !== undefined) result.workspace = workspace;
  return { ok: true, value: result };
}
