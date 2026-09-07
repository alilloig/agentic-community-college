import { describe, expect, it } from 'vitest';
import { validateLesson } from '../mcp/server/src/schemas/lesson.js';

function baseLesson() {
  return {
    slug: '01-basic-agent',
    title: 'Your first agent',
    summary: 'Build the smallest useful agent.',
    personalization_options: [],
  };
}

describe('validateLesson (v0.3)', () => {
  it('accepts the minimum-required shape', () => {
    const r = validateLesson(baseLesson());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.slug).toBe('01-basic-agent');
      expect(r.value.personalization_options).toEqual([]);
      expect(r.value.docs).toBeUndefined();
      expect(r.value.workspace).toBeUndefined();
    }
  });

  it('rejects non-objects', () => {
    for (const bad of [null, undefined, 1, 'x', []]) {
      const r = validateLesson(bad);
      expect(r.ok).toBe(false);
    }
  });

  it('rejects when required fields are missing', () => {
    for (const field of ['slug', 'title', 'summary', 'personalization_options']) {
      const obj = baseLesson() as Record<string, unknown>;
      delete obj[field];
      const r = validateLesson(obj);
      expect(r.ok, field).toBe(false);
    }
  });

  it('ignores retired v0.2 fields instead of failing on them', () => {
    const r = validateLesson({
      ...baseLesson(),
      build_command: 'pnpm build',
      test_command: 'pnpm vitest run',
      artifact: { template: 'artifact/template.html' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.value as Record<string, unknown>)['build_command']).toBeUndefined();
      expect((r.value as Record<string, unknown>)['artifact']).toBeUndefined();
    }
  });

  it('rejects slugs that are not filename-safe', () => {
    for (const slug of ['../x', 'a/b', '.hidden', 'has space']) {
      const r = validateLesson({ ...baseLesson(), slug });
      expect(r.ok, slug).toBe(false);
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

  it('accepts a docs directory and rejects one that escapes the lesson', () => {
    const ok = validateLesson({ ...baseLesson(), docs: 'docs/' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.docs).toBe('docs/');
    expect(validateLesson({ ...baseLesson(), docs: '../docs' }).ok).toBe(false);
    expect(validateLesson({ ...baseLesson(), docs: '/etc' }).ok).toBe(false);
    expect(validateLesson({ ...baseLesson(), docs: '' }).ok).toBe(false);
  });

  it('accepts a workspace block with host, solution_files and starters', () => {
    const r = validateLesson({
      ...baseLesson(),
      workspace: {
        host: 'reference-app',
        host_install_command: 'pnpm install',
        verification_cwd: '.',
        solution_files: ['src/agent.ts', 'src/tools.ts'],
        files: [{ path: 'src/App.tsx', starter: 'starters/App.tsx' }],
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.workspace?.host).toBe('reference-app');
      expect(r.value.workspace?.solution_files).toEqual(['src/agent.ts', 'src/tools.ts']);
      expect(r.value.workspace?.files).toHaveLength(1);
      expect(r.value.workspace?.verification_cwd).toBe('.');
    }
  });

  it('defaults solution_files and files to empty arrays', () => {
    const r = validateLesson({ ...baseLesson(), workspace: { host: 'reference-app' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.workspace?.solution_files).toEqual([]);
      expect(r.value.workspace?.files).toEqual([]);
    }
  });

  it('rejects solution_files that escape the workspace', () => {
    for (const bad of ['../secrets', '/etc/passwd', 'src/../../x']) {
      const r = validateLesson({
        ...baseLesson(),
        workspace: { host: 'reference-app', solution_files: [bad] },
      });
      expect(r.ok, bad).toBe(false);
    }
  });

  it('rejects workspace.host that escapes the lesson', () => {
    const r = validateLesson({ ...baseLesson(), workspace: { host: '../other' } });
    expect(r.ok).toBe(false);
  });

  it('accepts a prerequisites array of arbitrary probe IDs', () => {
    const r = validateLesson({
      ...baseLesson(),
      prerequisites: ['node-22-installed', 'pnpm-installed'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.prerequisites).toEqual(['node-22-installed', 'pnpm-installed']);
  });

  it('accepts an empty prerequisites array', () => {
    const r = validateLesson({ ...baseLesson(), prerequisites: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.prerequisites).toEqual([]);
  });

  it('rejects prerequisites when not an array or with empty entries', () => {
    expect(validateLesson({ ...baseLesson(), prerequisites: 'x' } as unknown).ok).toBe(false);
    expect(validateLesson({ ...baseLesson(), prerequisites: ['ok', ''] }).ok).toBe(false);
  });
});
