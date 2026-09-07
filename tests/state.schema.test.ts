import { describe, expect, it } from 'vitest';
import { validateState, STATE_SCHEMA_VERSION } from '../mcp/server/src/schemas/state.js';

function base() {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    selected_lesson: 'course@local/01-demo',
    personalization: {},
    chapter_cursor: 0,
    history: [],
    artifacts: {},
    workspace_path: '/tmp/ws',
  };
}

describe('validateState (v5)', () => {
  it('accepts the minimal v5 shape and defaults artifacts', () => {
    const obj = base() as Record<string, unknown>;
    delete obj['artifacts'];
    const r = validateState(obj);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.artifacts).toEqual({});
  });

  it('rejects any other schema_version inside the validator itself', () => {
    expect(validateState({ ...base(), schema_version: 4 }).ok).toBe(false);
    expect(validateState({ ...base(), schema_version: '5' }).ok).toBe(false);
  });

  it('requires workspace_path', () => {
    const obj = base() as Record<string, unknown>;
    delete obj['workspace_path'];
    expect(validateState(obj).ok).toBe(false);
    expect(validateState({ ...base(), workspace_path: '' }).ok).toBe(false);
  });

  it('rejects non-string artifact entries and malformed maps', () => {
    expect(validateState({ ...base(), artifacts: { c01: 1 } }).ok).toBe(false);
    expect(validateState({ ...base(), artifacts: ['x'] }).ok).toBe(false);
  });

  it('rejects a negative or fractional cursor', () => {
    expect(validateState({ ...base(), chapter_cursor: -1 }).ok).toBe(false);
    expect(validateState({ ...base(), chapter_cursor: 1.5 }).ok).toBe(false);
  });
});
