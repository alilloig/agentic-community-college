import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLesson } from '../mcp/server/src/schemas/lesson.js';
import { validateSections } from '../mcp/server/src/schemas/sections.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SKILL_ROOT = path.join(REPO_ROOT, 'skills', 'lesson-creator');
const TEMPLATES_DIR = path.join(SKILL_ROOT, 'templates');

/**
 * Light-weight harness for the lesson-creator skill: validates the skill's
 * frontmatter, asserts every template renders into something the schemas
 * accept, and confirms the artifact template carries its self-contained
 * polling script. Heavier end-to-end coverage (dispatching a learner
 * sub-agent through the full 7-step workflow) is left for a separate
 * runner — that test costs real tokens and shouldn't run in CI.
 */

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function fillTemplate(raw: string, values: Record<string, string>): string {
  return raw.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : m,
  );
}

describe('lesson-creator skill — structure', () => {
  it('ships SKILL.md with the expected frontmatter keys', () => {
    const skillPath = path.join(SKILL_ROOT, 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);
    const body = readUtf8(skillPath);
    expect(body.startsWith('---')).toBe(true);
    expect(body).toMatch(/^name:\s*lesson-creator\s*$/m);
    expect(body).toMatch(/^description:\s*.{40,}/m);
  });

  it('SKILL.md mentions every load-bearing MCP tool it relies on', () => {
    const body = readUtf8(path.join(SKILL_ROOT, 'SKILL.md'));
    // lesson-creator authors files; it doesn't run lessons. The only MCP tool
    // it calls directly is `start` (to enumerate discovered courses).
    expect(body).toContain('start');
    // It must also reference the validation pass and its agent dispatch.
    expect(body).toMatch(/Agent\b/);
    expect(body).toContain('validation.json');
  });

  it('SKILL.md walks the user through every authoring step (1..7)', () => {
    const body = readUtf8(path.join(SKILL_ROOT, 'SKILL.md'));
    // Loose check — every step header should be present.
    for (let n = 1; n <= 7; n++) {
      expect(body, `SKILL.md should include a Step ${n} section`).toMatch(
        new RegExp(`## Step ${n}`),
      );
    }
  });
});

describe('lesson-creator skill — templates', () => {
  it('lesson.json template renders into a validateLesson-acceptable manifest', () => {
    const raw = readUtf8(path.join(TEMPLATES_DIR, 'lesson.json.tmpl'));
    const filled = fillTemplate(raw, {
      slug: '99-test-slug',
      title: 'Test Lesson',
      summary: 'A fixture lesson used only to validate the template renders correctly.',
    });
    const parsed = JSON.parse(filled);
    const r = validateLesson(parsed);
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      expect(r.value.slug).toBe('99-test-slug');
      expect(r.value.title).toBe('Test Lesson');
      expect(r.value.artifact?.template).toBe('artifact/template.html');
    }
  });

  it('sections.json template renders into a validateSections-acceptable manifest', () => {
    const raw = readUtf8(path.join(TEMPLATES_DIR, 'sections.json.tmpl'));
    const parsed = JSON.parse(raw);
    const r = validateSections(parsed);
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      expect(r.value.schema_version).toBe(1);
      expect(r.value.sections).toHaveLength(1);
      expect(r.value.final_verification.mode).toBe('test-suite');
    }
  });

  it('template.html ships the self-contained state poller', () => {
    const raw = readUtf8(path.join(TEMPLATES_DIR, 'template.html.tmpl'));
    expect(raw).toContain('<!doctype html>');
    expect(raw).toContain('artifact-state.json');
    expect(raw).toContain('data-section-id');
    expect(raw).toMatch(/setTimeout\(.*2000\)/);
    // No external script srcs — must be fully self-contained.
    expect(raw).not.toMatch(/<script[^>]*\bsrc=/);
    expect(raw).not.toMatch(/<link[^>]*\bhref=/);
  });

  it('description.md template renders into non-empty markdown', () => {
    const raw = readUtf8(path.join(TEMPLATES_DIR, 'description.md.tmpl'));
    const filled = fillTemplate(raw, { title: 'Test Lesson' });
    expect(filled).toContain('Test Lesson');
    expect(filled.length).toBeGreaterThan(100);
  });
});

describe('lesson-creator skill — sample lesson cross-check', () => {
  it('a hand-crafted minimal lesson passes validateLesson + validateSections', () => {
    const lessonJson = {
      slug: '99-fixture',
      title: 'Fixture lesson',
      summary: 'For harness coverage.',
      personalization_options: [],
      build_command: 'pnpm vitest run',
      artifact: { template: 'artifact/template.html' },
    };
    const sectionsJson = {
      schema_version: 1,
      sections: [
        {
          id: 's01-only',
          title: 'Only section',
          body_md: 'sections/01-only.md',
          key_moment: 'The single load-bearing piece this fixture would teach.',
          expected_files: ['src/index.ts'],
          artifact_section_id: 's01-only',
        },
      ],
      final_verification: { mode: 'test-suite', command: 'pnpm vitest run' },
    };
    expect(validateLesson(lessonJson).ok).toBe(true);
    expect(validateSections(sectionsJson).ok).toBe(true);
  });

  it('a verification spec with mode=simulate is rejected (mode whitelist)', () => {
    const sectionsJson = {
      schema_version: 1,
      sections: [
        {
          id: 's01',
          title: 's',
          body_md: 'sections/01.md',
          key_moment: 'k',
          expected_files: ['x'],
          artifact_section_id: 's01',
        },
      ],
      final_verification: { mode: 'simulate', command: 'curl ...' },
    };
    const r = validateSections(sectionsJson);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/mode/);
  });
});
