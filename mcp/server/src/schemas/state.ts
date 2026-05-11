// State schema v4 — ACC lesson runtime.
//
// Migration story: v3 (sui-mcp-course) and earlier states surface as
// `schema-mismatch` in loadState; the existing flow short-circuits and the
// learner re-runs selectLesson to mint fresh v4 state. No coercion, no data
// loss. The corruption-archive path is unchanged.
//
// Retired in v4 (vs v3): `cursor: { phase_id, spot_id }`, `ladder`,
// `selected_style_per_spot`, `prompt_cursor_per_spot`. The new model has no
// phases, no rungs, no per-spot styles — just an ordered section sequence
// with a single integer cursor, and a path-wide output-style choice.

export interface Personalization {
  [key: string]: unknown;
}

export interface HistoryEntry {
  ts: string;
  event: string;
}

export type OutputStyleKind = 'learning' | 'explanatory';

export interface TestStatus {
  pass: boolean;
  output?: string;
  /** ISO-8601 timestamp of the last verifySection run. */
  ts?: string;
}

export interface State {
  schema_version: number;
  /** Namespaced slug: `<course>/<lesson>` (e.g. `acc-deepbook-course@local/01-market-stats`). */
  selected_lesson: string;
  /** Set by setOutputMode between selectLesson and setPersonalization. */
  selected_output_style: OutputStyleKind;
  personalization: Personalization;
  /** Zero-based index into the lesson's sections array. */
  section_cursor: number;
  history: HistoryEntry[];
  /** Absolute path to the lesson workspace when the lesson declares one. */
  workspace_path?: string;
  /** Result of the last verifySection / final_verification run. */
  test_status?: TestStatus;
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
    obj['selected_output_style'] !== 'learning' &&
    obj['selected_output_style'] !== 'explanatory'
  ) {
    return {
      ok: false,
      error: `selected_output_style must be 'learning' or 'explanatory' (got ${JSON.stringify(obj['selected_output_style'])})`,
    };
  }
  if (
    typeof obj['personalization'] !== 'object' ||
    obj['personalization'] === null ||
    Array.isArray(obj['personalization'])
  ) {
    return { ok: false, error: 'personalization must be a non-null object' };
  }
  if (
    typeof obj['section_cursor'] !== 'number' ||
    !Number.isInteger(obj['section_cursor']) ||
    (obj['section_cursor'] as number) < 0
  ) {
    return { ok: false, error: 'section_cursor must be a non-negative integer' };
  }
  if (!Array.isArray(obj['history'])) {
    return { ok: false, error: 'history must be an array' };
  }

  const value: State = {
    schema_version: obj['schema_version'] as number,
    selected_lesson: obj['selected_lesson'] as string,
    selected_output_style: obj['selected_output_style'] as OutputStyleKind,
    personalization: obj['personalization'] as Personalization,
    section_cursor: obj['section_cursor'] as number,
    history: obj['history'] as HistoryEntry[],
  };

  if (obj['workspace_path'] !== undefined) {
    if (typeof obj['workspace_path'] !== 'string') {
      return { ok: false, error: 'workspace_path must be a string when present' };
    }
    value.workspace_path = obj['workspace_path'] as string;
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
    value.test_status = status;
  }

  return { ok: true, value };
}
