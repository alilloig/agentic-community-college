import { describe, expect, it } from 'vitest';
import { validateSections } from '../mcp/server/src/schemas/sections.js';

function baseSection(id: string) {
  return {
    id,
    title: `Section ${id}`,
    body_md: `sections/${id}.md`,
    key_moment: `key moment for ${id}`,
    expected_files: ['src/App.tsx'],
    artifact_section_id: `artifact-${id}`,
  };
}

function baseManifest(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    sections: [baseSection('s01-bootstrap')],
    final_verification: {
      mode: 'test-suite',
      command: 'pnpm vitest run',
    },
    ...overrides,
  };
}

describe('validateSections', () => {
  it('accepts a minimal manifest', () => {
    const r = validateSections(baseManifest());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.schema_version).toBe(1);
      expect(r.value.sections).toHaveLength(1);
      expect(r.value.final_verification.mode).toBe('test-suite');
    }
  });

  it('rejects non-objects', () => {
    expect(validateSections(null).ok).toBe(false);
    expect(validateSections('x').ok).toBe(false);
    expect(validateSections([]).ok).toBe(false);
  });

  it('rejects schema_version other than 1', () => {
    const r = validateSections({ ...baseManifest(), schema_version: 2 });
    expect(r.ok).toBe(false);
  });

  it('rejects empty sections array', () => {
    const r = validateSections({ ...baseManifest(), sections: [] });
    expect(r.ok).toBe(false);
  });

  it('rejects duplicate section ids', () => {
    const r = validateSections({
      ...baseManifest(),
      sections: [baseSection('a'), baseSection('a')],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicated/);
  });

  it('rejects section.body_md that escapes the lesson dir', () => {
    const bad = baseSection('s1');
    bad.body_md = '../escape.md';
    const r = validateSections({ ...baseManifest(), sections: [bad] });
    expect(r.ok).toBe(false);
  });

  it('rejects sections missing required fields', () => {
    for (const field of [
      'id',
      'title',
      'body_md',
      'key_moment',
      'expected_files',
      'artifact_section_id',
    ]) {
      const bad = baseSection('s1') as Record<string, unknown>;
      delete bad[field];
      const r = validateSections({ ...baseManifest(), sections: [bad] });
      expect(r.ok).toBe(false);
    }
  });

  it('accepts a per-section verification spec', () => {
    const section = baseSection('s1') as Record<string, unknown>;
    section.verification = { mode: 'compile', command: 'pnpm build' };
    const r = validateSections({ ...baseManifest(), sections: [section] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sections[0].verification?.mode).toBe('compile');
    }
  });

  it('rejects verification.mode outside the allowed set', () => {
    const r = validateSections({
      ...baseManifest(),
      final_verification: { mode: 'simulate', command: 'whatever' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/mode/);
  });

  it('rejects verification.cwd that escapes the workspace', () => {
    const r = validateSections({
      ...baseManifest(),
      final_verification: { mode: 'test-suite', command: 'x', cwd: '../foo' },
    });
    expect(r.ok).toBe(false);
  });

  it('requires final_verification', () => {
    const r = validateSections({ schema_version: 1, sections: [baseSection('s1')] });
    expect(r.ok).toBe(false);
  });
});
