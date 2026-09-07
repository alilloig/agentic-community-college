// State schema v5 — ACC lesson runtime (chapter model).
//
// Migration story: v4 (section model) and earlier states surface as
// `schema-mismatch` in loadState; the learner re-runs the course's start
// command to mint fresh v5 state. No coercion, no data loss. The
// corruption-archive path is unchanged.
//
// Retired in v5 (vs v4): `selected_output_style` (output modes are gone),
// `section_cursor` (renamed `chapter_cursor`). New: `artifacts` (chapter id →
// absolute artifact path, plus the `summary` key) and `completed_at` (set when
// final_verification passed).

export interface Personalization {
  [key: string]: unknown;
}

export interface HistoryEntry {
  ts: string;
  event: string;
}

export interface TestStatus {
  pass: boolean;
  output?: string;
  /** ISO-8601 timestamp of the last verifyChapter run. */
  ts?: string;
  /** True when the run was final_verification (the e2e gate). */
  final?: boolean;
}

export interface State {
  schema_version: number;
  /** Namespaced slug: `<course>/<lesson>`. */
  selected_lesson: string;
  personalization: Personalization;
  /** Zero-based index into chapters. `=== chapters.length` means every
   * chapter passed and the e2e gate is pending or done. */
  chapter_cursor: number;
  history: HistoryEntry[];
  /** Chapter id → absolute artifact path. The summary uses the key `summary`. */
  artifacts: Record<string, string>;
  /** Absolute path to the lesson workspace when the lesson declares one. */
  workspace_path?: string;
  /** Result of the last verifyChapter run. */
  test_status?: TestStatus;
  /** ISO-8601 timestamp set when final_verification passed. */
  completed_at?: string;
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateState(v: unknown): ValidationResult<State> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { ok: false, error: 'state must be a non-null object' };
  }
  const obj = v as Record<string, unknown>;

  if (typeof obj['schema_version'] !== 'number') {
    return { ok: false, error: 'schema_version must be a number' };
  }
  if (typeof obj['selected_lesson'] !== 'string' || (obj['selected_lesson'] as string).length === 0) {
    return { ok: false, error: 'selected_lesson must be a non-empty string' };
  }
  if (
    typeof obj['personalization'] !== 'object' ||
    obj['personalization'] === null ||
    Array.isArray(obj['personalization'])
  ) {
    return { ok: false, error: 'personalization must be a non-null object' };
  }
  if (
    typeof obj['chapter_cursor'] !== 'number' ||
    !Number.isInteger(obj['chapter_cursor']) ||
    (obj['chapter_cursor'] as number) < 0
  ) {
    return { ok: false, error: 'chapter_cursor must be a non-negative integer' };
  }
  if (!Array.isArray(obj['history'])) {
    return { ok: false, error: 'history must be an array' };
  }
  const rawArtifacts = obj['artifacts'] ?? {};
  if (typeof rawArtifacts !== 'object' || rawArtifacts === null || Array.isArray(rawArtifacts)) {
    return { ok: false, error: 'artifacts must be an object' };
  }
  const artifacts: Record<string, string> = {};
  for (const [k, val] of Object.entries(rawArtifacts as Record<string, unknown>)) {
    if (typeof val !== 'string') {
      return { ok: false, error: `artifacts.${k} must be a string` };
    }
    artifacts[k] = val;
  }

  const value: State = {
    schema_version: obj['schema_version'] as number,
    selected_lesson: obj['selected_lesson'] as string,
    personalization: obj['personalization'] as Personalization,
    chapter_cursor: obj['chapter_cursor'] as number,
    history: obj['history'] as HistoryEntry[],
    artifacts,
  };

  if (obj['workspace_path'] !== undefined) {
    if (typeof obj['workspace_path'] !== 'string') {
      return { ok: false, error: 'workspace_path must be a string when present' };
    }
    value.workspace_path = obj['workspace_path'] as string;
  }

  if (obj['completed_at'] !== undefined) {
    if (typeof obj['completed_at'] !== 'string') {
      return { ok: false, error: 'completed_at must be a string when present' };
    }
    value.completed_at = obj['completed_at'] as string;
  }

  if (obj['test_status'] !== undefined) {
    const ts = obj['test_status'];
    if (typeof ts !== 'object' || ts === null || Array.isArray(ts)) {
      return { ok: false, error: 'test_status must be a non-null object when present' };
    }
    const tsObj = ts as Record<string, unknown>;
    if (typeof tsObj['pass'] !== 'boolean') {
      return { ok: false, error: 'test_status.pass must be a boolean' };
    }
    const status: TestStatus = { pass: tsObj['pass'] as boolean };
    if (tsObj['output'] !== undefined) {
      if (typeof tsObj['output'] !== 'string') {
        return { ok: false, error: 'test_status.output must be a string when present' };
      }
      status.output = tsObj['output'] as string;
    }
    if (tsObj['ts'] !== undefined) {
      if (typeof tsObj['ts'] !== 'string') {
        return { ok: false, error: 'test_status.ts must be a string when present' };
      }
      status.ts = tsObj['ts'] as string;
    }
    if (tsObj['final'] !== undefined) {
      if (typeof tsObj['final'] !== 'boolean') {
        return { ok: false, error: 'test_status.final must be a boolean when present' };
      }
      status.final = tsObj['final'] as boolean;
    }
    value.test_status = status;
  }

  return { ok: true, value };
}
