import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLesson } from '../mcp/server/src/schemas/lesson.js';
import { validateChapters } from '../mcp/server/src/schemas/chapters.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SKILL_ROOT = path.join(REPO_ROOT, 'skills', 'lesson-creator');
const TEMPLATES_DIR = path.join(SKILL_ROOT, 'templates');

/**
 * Harness for the v0.3 lesson-creator skill: validates the skill's
 * frontmatter and step structure, asserts every template renders into
 * something the v0.3 schemas accept, and confirms the retired v0.2
 * templates are gone. Heavier end-to-end coverage (dispatching a learner
 * sub-agent through the full workflow) costs real tokens and is left to the
 * skill's own Step 6.
 */

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function fillTemplate(raw: string, values: Record<string, string>): string {
  return raw.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : m,
  );
}

describe('lesson-creator skill: structure', () => {
  const skillPath = path.join(SKILL_ROOT, 'SKILL.md');
  const body = readUtf8(skillPath);

  it('ships SKILL.md with the expected frontmatter keys', () => {
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(body.startsWith('---')).toBe(true);
    expect(body).toMatch(/^name:\s*lesson-creator\s*$/m);
    expect(body).toMatch(/^description:\s*.{40,}/m);
  });

  it('mentions the MCP tool it calls, the Agent dispatch, and validation.json', () => {
    expect(body).toContain('start');
    expect(body).toMatch(/Agent\b/);
    expect(body).toContain('validation.json');
  });

  it('walks the author through every step (0..7)', () => {
    for (let n = 0; n <= 7; n++) {
      expect(body, `SKILL.md should include a Step ${n} section`).toMatch(new RegExp(`^## Step ${n}\\b`, 'm'));
    }
  });

  it('covers the v0.3 pipeline: docs snapshot, chapters, reference-app, e2e, validation', () => {
    expect(body).toContain('docs/INDEX.md');
    expect(body).toContain('chapters.json');
    expect(body).toContain('reference-app/');
    expect(body).toContain('final_verification');
    expect(body).toContain('solution_files');
    expect(body).toMatch(/e2e/);
    expect(body).toContain('--skip-validation');
    expect(body).toContain('chapters_passed');
  });

  it('no longer references the v0.2 section model or the toolkit check', () => {
    expect(body).not.toContain('sections.json');
    expect(body).not.toContain('template.html');
    expect(body).not.toContain('artifact-state.json');
    expect(body).not.toContain('toolkit-installed');
    expect(body).not.toMatch(/output style[s]? .*learning/i);
  });
});

describe('lesson-creator skill: templates', () => {
  it('ships exactly the four v0.3 templates', () => {
    const files = fs.readdirSync(TEMPLATES_DIR).sort();
    expect(files).toEqual(['chapter.md.tmpl', 'chapters.json.tmpl', 'description.md.tmpl', 'lesson.json.tmpl']);
  });

  it('lesson.json template renders into a validateLesson-acceptable manifest', () => {
    const raw = readUtf8(path.join(TEMPLATES_DIR, 'lesson.json.tmpl'));
    const filled = fillTemplate(raw, {
      slug: '99-test-slug',
      title: 'Test Lesson',
      summary: 'A fixture lesson used only to validate the template renders correctly.',
    });
    const parsed = JSON.parse(filled);
    // Exact v0.3 shape from CLAUDE.md.
    expect(Object.keys(parsed).sort()).toEqual(
      ['docs', 'personalization_options', 'personalization_ranges', 'prerequisites', 'slug', 'summary', 'title', 'workspace'].sort(),
    );
    expect(Object.keys(parsed.workspace).sort()).toEqual(
      ['files', 'host', 'host_install_command', 'solution_files', 'verification_cwd'].sort(),
    );

    const r = validateLesson(parsed);
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      expect(r.value.slug).toBe('99-test-slug');
      expect(r.value.title).toBe('Test Lesson');
      expect(r.value.workspace?.host).toBe('reference-app');
    }
  });

  it('chapters.json template renders into a validateChapters-acceptable manifest', () => {
    const raw = readUtf8(path.join(TEMPLATES_DIR, 'chapters.json.tmpl'));
    const parsed = JSON.parse(raw);
    expect(parsed.schema_version).toBe(2);
    expect(parsed.chapters).toHaveLength(1);
    expect(Object.keys(parsed.chapters[0]).sort()).toEqual(
      ['brief_md', 'expected_files', 'id', 'key_idea', 'tests', 'title', 'verification'].sort(),
    );
    expect(parsed.chapters[0].verification).toEqual({
      mode: 'test-suite',
      command: 'pnpm vitest run tests/01-first-step.test.ts',
    });
    expect(parsed.final_verification).toEqual({ mode: 'test-suite', command: 'pnpm vitest run' });

    const r = validateChapters(parsed);
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
  });

  it('chapter.md template renders the three-part brief', () => {
    const raw = readUtf8(path.join(TEMPLATES_DIR, 'chapter.md.tmpl'));
    const filled = fillTemplate(raw, { title: 'Run a query' });
    expect(filled).toMatch(/^# Run a query/m);
    expect(filled).toMatch(/^## What we implement/m);
    expect(filled).toMatch(/^## Done when/m);
    expect(filled).toMatch(/^## Implementation notes/m);
    expect(filled).not.toMatch(/\{\{\s*title\s*\}\}/);
  });

  it('description.md template renders into non-empty markdown', () => {
    const raw = readUtf8(path.join(TEMPLATES_DIR, 'description.md.tmpl'));
    const filled = fillTemplate(raw, { title: 'Test Lesson' });
    expect(filled).toContain('Test Lesson');
    expect(filled.length).toBeGreaterThan(100);
    expect(filled).not.toMatch(/output mode/i);
  });
});

describe('lesson-creator skill: sample lesson cross-check', () => {
  it('a hand-crafted minimal v0.3 lesson passes validateLesson + validateChapters', () => {
    const lessonJson = {
      slug: '99-fixture',
      title: 'Fixture lesson',
      summary: 'For harness coverage.',
      prerequisites: [],
      docs: 'docs/',
      workspace: {
        host: 'reference-app',
        host_install_command: 'pnpm install',
        verification_cwd: '.',
        solution_files: ['src/index.ts'],
        files: [],
      },
      personalization_options: [],
      personalization_ranges: {},
    };
    const chaptersJson = {
      schema_version: 2,
      chapters: [
        {
          id: 'c01-only',
          title: 'Only chapter',
          brief_md: 'chapters/01-only.md',
          key_idea: 'The single concept this fixture would teach.',
          expected_files: ['src/index.ts'],
          tests: ['tests/01-only.test.ts'],
          verification: { mode: 'test-suite', command: 'pnpm vitest run tests/01-only.test.ts' },
        },
      ],
      final_verification: { mode: 'test-suite', command: 'pnpm vitest run' },
    };
    const l = validateLesson(lessonJson);
    expect(l.ok, l.ok ? '' : l.error).toBe(true);
    const c = validateChapters(chaptersJson);
    expect(c.ok, c.ok ? '' : c.error).toBe(true);
  });

  it('a final_verification with mode=simulate is rejected (mode whitelist)', () => {
    const chaptersJson = {
      schema_version: 2,
      chapters: [
        {
          id: 'c01',
          title: 'c',
          brief_md: 'chapters/01.md',
          key_idea: 'k',
          expected_files: ['x'],
          tests: ['t'],
          verification: { mode: 'test-suite', command: 'pnpm vitest run t' },
        },
      ],
      final_verification: { mode: 'simulate', command: 'curl ...' },
    };
    const r = validateChapters(chaptersJson);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/mode/);
  });
});
