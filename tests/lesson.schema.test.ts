import { describe, expect, it } from 'vitest';
import { validateLesson } from '../mcp/server/src/schemas/lesson.js';

function baseLesson() {
  return {
    slug: '01-market-stats',
    title: 'Market Stats',
    summary: 'Build a DeepBook market-stats viewer.',
    personalization_options: [],
    build_command: 'pnpm build',
  };
}

describe('validateLesson', () => {
  it('accepts the minimum-required shape', () => {
    const r = validateLesson(baseLesson());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.slug).toBe('01-market-stats');
      expect(r.value.personalization_options).toEqual([]);
      expect(r.value.test_command).toBeUndefined();
      expect(r.value.artifact).toBeUndefined();
    }
  });

  it('rejects non-objects', () => {
    for (const bad of [null, undefined, 1, 'x', []]) {
      const r = validateLesson(bad);
      expect(r.ok).toBe(false);
    }
  });

  it('rejects when required fields are missing', () => {
    for (const field of ['slug', 'title', 'summary', 'build_command', 'personalization_options']) {
      const obj = baseLesson() as Record<string, unknown>;
      delete obj[field];
      const r = validateLesson(obj);
      expect(r.ok).toBe(false);
    }
  });

  it('accepts course-defined personalization keys', () => {
    const r = validateLesson({
      ...baseLesson(),
      personalization_options: ['my_thing', 'another_thing'],
      personalization_ranges: {
        my_thing: { min: 1, max: 10, default: 5 },
        another_thing: { values: ['a', 'b'], default: 'a' },
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.personalization_ranges?.my_thing).toEqual({ min: 1, max: 10, default: 5 });
      expect(r.value.personalization_ranges?.another_thing).toEqual({
        values: ['a', 'b'],
        default: 'a',
      });
    }
  });

  it('rejects personalization_ranges keys not declared in options', () => {
    const r = validateLesson({
      ...baseLesson(),
      personalization_options: ['known_key'],
      personalization_ranges: {
        unknown_key: { min: 0, max: 1, default: 0 },
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown_key/);
  });

  it('rejects integer range where default is outside [min, max]', () => {
    const r = validateLesson({
      ...baseLesson(),
      personalization_options: ['k'],
      personalization_ranges: { k: { min: 1, max: 10, default: 99 } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/out of/);
  });

  it('rejects enum range where default is not in values', () => {
    const r = validateLesson({
      ...baseLesson(),
      personalization_options: ['k'],
      personalization_ranges: { k: { values: ['a', 'b'], default: 'z' } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/is not in values/);
  });

  it('accepts optional test_command', () => {
    const r = validateLesson({ ...baseLesson(), test_command: 'pnpm vitest run' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.test_command).toBe('pnpm vitest run');
  });

  it('accepts an artifact block with a template path', () => {
    const r = validateLesson({
      ...baseLesson(),
      artifact: { template: 'artifact/template.html' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.artifact?.template).toBe('artifact/template.html');
      expect(r.value.artifact?.state_filename).toBeUndefined();
    }
  });

  it('rejects artifact.template that escapes the lesson dir', () => {
    const r = validateLesson({
      ...baseLesson(),
      artifact: { template: '../etc/passwd' },
    });
    expect(r.ok).toBe(false);
  });

  it('rejects artifact.state_filename containing slashes', () => {
    const r = validateLesson({
      ...baseLesson(),
      artifact: { template: 'artifact/template.html', state_filename: 'sub/path.json' },
    });
    expect(r.ok).toBe(false);
  });

  it('accepts a workspace block with a host + one file', () => {
    const r = validateLesson({
      ...baseLesson(),
      workspace: {
        host: 'hosts/orderbook',
        files: [{ path: 'src/App.tsx', starter: 'starters/App.tsx' }],
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.workspace?.host).toBe('hosts/orderbook');
      expect(r.value.workspace?.files).toHaveLength(1);
    }
  });
});
