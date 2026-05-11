export interface Cursor {
  phase_id: string;
  spot_id: string;
}

export interface Personalization {
  [key: string]: unknown;
}

export interface LadderRung {
  hint_used: boolean;
  reference_shown: boolean;
  auto_completed: boolean;
  auto_write_attempted: boolean;
}

export interface HistoryEntry {
  ts: string;
  event: string;
}

export type SpotStyleKind = 'fill-in-blank' | 'prompted-agentic';

export interface State {
  schema_version: number;
  selected_path: string;
  personalization: Personalization;
  cursor: Cursor;
  ladder: Record<string, LadderRung>;
  history: HistoryEntry[];
  /** Absolute path to the lesson workspace, populated by selectPath when the
   * path declares a workspace block. Older state files (schema_version < 2)
   * omit this. Tools resolve verification cwd and target files against it. */
  workspace_path?: string;
  /** Per-spot exercise style choice. PR 1 only honors 'fill-in-blank';
   * PR 2 lights up 'prompted-agentic'. */
  selected_style_per_spot?: Record<string, SpotStyleKind>;
  /** PR 2 — per-spot prompt cursor for the prompted-agentic flow.
   * Tracks the index of the next prompt the learner has not yet seen. */
  prompt_cursor_per_spot?: Record<string, number>;
}

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function validateState(v: unknown): ValidationResult<State> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { ok: false, error: 'state must be a non-null object' };
  }
  const obj = v as Record<string, unknown>;

  if (typeof obj['schema_version'] !== 'number') {
    return { ok: false, error: 'schema_version must be a number' };
  }

  if (typeof obj['selected_path'] !== 'string') {
    return { ok: false, error: 'selected_path must be a string' };
  }

  if (
    typeof obj['personalization'] !== 'object' ||
    obj['personalization'] === null ||
    Array.isArray(obj['personalization'])
  ) {
    return { ok: false, error: 'personalization must be a non-null object' };
  }

  if (
    typeof obj['cursor'] !== 'object' ||
    obj['cursor'] === null ||
    Array.isArray(obj['cursor'])
  ) {
    return { ok: false, error: 'cursor must be a non-null object' };
  }
  const cursor = obj['cursor'] as Record<string, unknown>;
  if (typeof cursor['phase_id'] !== 'string') {
    return { ok: false, error: 'cursor.phase_id must be a string' };
  }
  if (typeof cursor['spot_id'] !== 'string') {
    return { ok: false, error: 'cursor.spot_id must be a string' };
  }

  if (
    typeof obj['ladder'] !== 'object' ||
    obj['ladder'] === null ||
    Array.isArray(obj['ladder'])
  ) {
    return { ok: false, error: 'ladder must be a non-null object' };
  }

  if (!Array.isArray(obj['history'])) {
    return { ok: false, error: 'history must be an array' };
  }

  // Normalize ladder rungs: add auto_write_attempted: false default if absent.
  const rawLadder = obj['ladder'] as Record<string, unknown>;
  const normalizedLadder: Record<string, LadderRung> = {};
  for (const [key, rung] of Object.entries(rawLadder)) {
    if (typeof rung === 'object' && rung !== null) {
      const r = rung as Record<string, unknown>;
      normalizedLadder[key] = {
        hint_used: typeof r['hint_used'] === 'boolean' ? r['hint_used'] : false,
        reference_shown: typeof r['reference_shown'] === 'boolean' ? r['reference_shown'] : false,
        auto_completed: typeof r['auto_completed'] === 'boolean' ? r['auto_completed'] : false,
        auto_write_attempted: typeof r['auto_write_attempted'] === 'boolean' ? r['auto_write_attempted'] : false,
      };
    }
  }

  // Optional v2 fields. Absent in v1 state — left undefined here; the schema
  // version check (state.ts loadState) is what gates behavioral compatibility,
  // not field presence.
  let workspace_path: string | undefined;
  if (obj['workspace_path'] !== undefined) {
    if (typeof obj['workspace_path'] !== 'string') {
      return { ok: false, error: 'workspace_path must be a string when present' };
    }
    workspace_path = obj['workspace_path'] as string;
  }

  let selected_style_per_spot: Record<string, SpotStyleKind> | undefined;
  if (obj['selected_style_per_spot'] !== undefined) {
    if (
      typeof obj['selected_style_per_spot'] !== 'object' ||
      obj['selected_style_per_spot'] === null ||
      Array.isArray(obj['selected_style_per_spot'])
    ) {
      return { ok: false, error: 'selected_style_per_spot must be a non-null object when present' };
    }
    const raw = obj['selected_style_per_spot'] as Record<string, unknown>;
    const normalized: Record<string, SpotStyleKind> = {};
    for (const [spotId, value] of Object.entries(raw)) {
      if (value !== 'fill-in-blank' && value !== 'prompted-agentic') {
        return {
          ok: false,
          error: `selected_style_per_spot['${spotId}'] must be 'fill-in-blank' or 'prompted-agentic'`,
        };
      }
      normalized[spotId] = value;
    }
    selected_style_per_spot = normalized;
  }

  const value: State = {
    schema_version: obj['schema_version'] as number,
    selected_path: obj['selected_path'] as string,
    personalization: obj['personalization'] as Personalization,
    cursor: {
      phase_id: cursor['phase_id'] as string,
      spot_id: cursor['spot_id'] as string,
    },
    ladder: normalizedLadder,
    history: obj['history'] as HistoryEntry[],
  };
  let prompt_cursor_per_spot: Record<string, number> | undefined;
  if (obj['prompt_cursor_per_spot'] !== undefined) {
    if (
      typeof obj['prompt_cursor_per_spot'] !== 'object' ||
      obj['prompt_cursor_per_spot'] === null ||
      Array.isArray(obj['prompt_cursor_per_spot'])
    ) {
      return { ok: false, error: 'prompt_cursor_per_spot must be a non-null object when present' };
    }
    const raw = obj['prompt_cursor_per_spot'] as Record<string, unknown>;
    const normalized: Record<string, number> = {};
    for (const [spotId, val] of Object.entries(raw)) {
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) {
        return {
          ok: false,
          error: `prompt_cursor_per_spot['${spotId}'] must be a non-negative integer`,
        };
      }
      normalized[spotId] = val;
    }
    prompt_cursor_per_spot = normalized;
  }

  if (workspace_path !== undefined) value.workspace_path = workspace_path;
  if (selected_style_per_spot !== undefined) value.selected_style_per_spot = selected_style_per_spot;
  if (prompt_cursor_per_spot !== undefined) value.prompt_cursor_per_spot = prompt_cursor_per_spot;
  return { ok: true, value };
}
