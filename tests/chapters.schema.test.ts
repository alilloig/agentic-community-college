import { describe, expect, it } from 'vitest';
import { validateChapters } from '../mcp/server/src/schemas/chapters.js';

function chapter(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c01-run-query',
    title: 'Run a query',
    brief_md: 'chapters/01-run-query.md',
    key_idea: 'query() returns an async iterable of typed messages.',
    expected_files: ['src/agent.ts'],
    tests: ['tests/01-run-query.test.ts'],
    verification: { mode: 'test-suite', command: 'pnpm vitest run tests/01-run-query.test.ts' },
    ...overrides,
  };
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 2,
    chapters: [chapter()],
    final_verification: { mode: 'test-suite', command: 'pnpm vitest run' },
    ...overrides,
  };
}

describe('validateChapters', () => {
  it('accepts a well-formed manifest', () => {
    const r = validateChapters(manifest());
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      expect(r.value.schema_version).toBe(2);
      expect(r.value.chapters).toHaveLength(1);
      expect(r.value.chapters[0].tests).toEqual(['tests/01-run-query.test.ts']);
      expect(r.value.chapters[0].verification.mode).toBe('test-suite');
      expect(r.value.final_verification.command).toBe('pnpm vitest run');
    }
  });

  it('rejects non-objects and wrong schema_version', () => {
    for (const bad of [null, 1, 'x', [], manifest({ schema_version: 1 })]) {
      expect(validateChapters(bad).ok).toBe(false);
    }
  });

  it('requires a non-empty chapters array', () => {
    expect(validateChapters(manifest({ chapters: [] })).ok).toBe(false);
    expect(validateChapters(manifest({ chapters: 'x' })).ok).toBe(false);
  });

  it('requires id, title, brief_md, key_idea, expected_files and verification per chapter', () => {
    for (const field of ['id', 'title', 'brief_md', 'key_idea', 'expected_files', 'verification']) {
      const c = chapter() as Record<string, unknown>;
      delete c[field];
      const r = validateChapters(manifest({ chapters: [c] }));
      expect(r.ok, field).toBe(false);
    }
  });

  it('defaults tests to an empty array when absent', () => {
    const c = chapter() as Record<string, unknown>;
    delete c['tests'];
    const r = validateChapters(manifest({ chapters: [c] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.chapters[0].tests).toEqual([]);
  });

  it('rejects duplicate chapter ids and unsafe ids', () => {
    expect(validateChapters(manifest({ chapters: [chapter(), chapter()] })).ok).toBe(false);
    for (const id of ['../x', 'a/b', '.hidden', 'has space']) {
      expect(validateChapters(manifest({ chapters: [chapter({ id })] })).ok, id).toBe(false);
    }
  });

  it('rejects path fields that escape their root', () => {
    expect(validateChapters(manifest({ chapters: [chapter({ brief_md: '../x.md' })] })).ok).toBe(false);
    expect(validateChapters(manifest({ chapters: [chapter({ expected_files: ['/abs'] })] })).ok).toBe(false);
    expect(validateChapters(manifest({ chapters: [chapter({ tests: ['../t.ts'] })] })).ok).toBe(false);
    expect(
      validateChapters(
        manifest({ chapters: [chapter({ verification: { mode: 'compile', command: 'x', cwd: '../up' } })] }),
      ).ok,
    ).toBe(false);
  });

  it('rejects unsupported verification modes and empty commands', () => {
    expect(
      validateChapters(manifest({ chapters: [chapter({ verification: { mode: 'simulate', command: 'x' } })] })).ok,
    ).toBe(false);
    expect(
      validateChapters(manifest({ chapters: [chapter({ verification: { mode: 'compile', command: '' } })] })).ok,
    ).toBe(false);
  });

  it('requires final_verification', () => {
    const m = manifest() as Record<string, unknown>;
    delete m['final_verification'];
    expect(validateChapters(m).ok).toBe(false);
  });
});
