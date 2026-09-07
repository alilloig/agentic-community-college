import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The conductor generates every artifact at runtime from these templates.
 * A template that pulls an external asset would produce artifacts that break
 * offline or on file://, so both templates must be fully self-contained,
 * carry the ACC dark-theme tokens, and expose the fixed section headings
 * that references/conventions.md prescribes.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..', 'skills', 'chapter-artifact');
const TEMPLATES_DIR = path.join(SKILL_ROOT, 'templates');

const TOKENS: Record<string, string> = {
  '--bg': '#0e1117',
  '--panel': '#161b22',
  '--panel-2': '#1f242d',
  '--border': '#2a313c',
  '--fg': '#d5d9e0',
  '--muted': '#8b94a7',
  '--accent': '#79b8ff',
  '--good': '#6dd56d',
  '--warn': '#e6c07b',
  '--bad': '#e08585',
  '--code-bg': '#0b0e13',
};

const CHAPTER_HEADINGS = ['What was built', 'How it works', 'The code', 'Tests that prove it', 'Next'];
const SUMMARY_HEADINGS = ['What you built', 'Chapters', 'Most important learnings', 'Where to go next'];

function readTemplate(name: string): string {
  return fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf8');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Template comments are guidance for the conductor, not markup; drop them before asset checks. */
function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

describe.each([
  ['chapter.html.tmpl', CHAPTER_HEADINGS],
  ['summary.html.tmpl', SUMMARY_HEADINGS],
])('chapter-artifact template %s', (file, headings) => {
  const html = readTemplate(file);

  it('is a complete HTML document', () => {
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    expect(html).toContain('<meta name="viewport"');
  });

  it('is self-contained: no external scripts, stylesheets, fonts, or URL assets', () => {
    const markup = stripComments(html);
    expect(markup).not.toMatch(/<script[^>]*\bsrc\s*=/i);
    expect(markup).not.toMatch(/<link[^>]*\bhref\s*=/i);
    expect(markup).not.toMatch(/\b(src|href)\s*=\s*["']?\s*https?:/i);
    expect(markup).not.toMatch(/@import\b/i);
    expect(markup).not.toMatch(/url\(\s*["']?\s*https?:/i);
    expect(markup).not.toMatch(/@font-face/i);
  });

  it('declares the ACC dark-theme token block', () => {
    for (const [name, value] of Object.entries(TOKENS)) {
      expect(html, `missing token ${name}: ${value}`).toMatch(new RegExp(`${escapeRe(name)}\\s*:\\s*${value}`, 'i'));
    }
  });

  it('uses the system font stack, a 1100px max width, and a mobile breakpoint', () => {
    expect(html).toMatch(/-apple-system,\s*BlinkMacSystemFont/);
    expect(html).toMatch(/max-width:\s*1100px/);
    expect(html).toMatch(/@media\s*\(max-width:\s*\d+px\)/);
  });

  it('contains the fixed section headings, in order', () => {
    let cursor = 0;
    for (const heading of headings) {
      const re = new RegExp(`<h2>\\s*${escapeRe(heading)}\\s*</h2>`);
      const idx = html.slice(cursor).search(re);
      expect(idx, `heading "${heading}" missing or out of order`).toBeGreaterThanOrEqual(0);
      cursor += idx + 1;
    }
  });

  it('uses {{ placeholders }} for the conductor to fill', () => {
    expect(html).toMatch(/\{\{\s*lesson_title\s*\}\}/);
  });

  it('stays small (< 250 lines)', () => {
    expect(html.split('\n').length).toBeLessThan(250);
  });
});

describe('chapter-artifact template specifics', () => {
  it('chapter template carries the header fields and the footer navigation', () => {
    const html = readTemplate('chapter.html.tmpl');
    expect(html).toMatch(/Chapter \{\{\s*n\s*\}\} of \{\{\s*m\s*\}\}/);
    expect(html).toMatch(/\{\{\s*chapter_title\s*\}\}/);
    expect(html).toMatch(/\{\{\s*key_idea\s*\}\}/);
    expect(html).toContain('<svg');
    expect(html).toMatch(/<pre><code>/);
    expect(html).toMatch(/href="\{\{\s*prev_file\s*\}\}"/);
    expect(html).toMatch(/href="\{\{\s*next_file\s*\}\}"/);
  });

  it('summary template carries the e2e status and chapter cards', () => {
    const html = readTemplate('summary.html.tmpl');
    expect(html).toMatch(/\{\{\s*completed_date\s*\}\}/);
    expect(html).toMatch(/\{\{\s*e2e_status\s*\}\}/);
    expect(html).toMatch(/class="status \{\{\s*e2e_class\s*\}\}"/);
    expect(html).toMatch(/\.status\.good/);
    expect(html).toMatch(/\.status\.warn/);
    expect(html).toMatch(/\.status\.bad/);
    expect(html).toMatch(/class="card" href="\{\{\s*chapter_1_file\s*\}\}"/);
    expect(html).toContain('<svg');
  });
});

describe('chapter-artifact skill files', () => {
  it('ships SKILL.md with the chapter-artifact name', () => {
    const body = fs.readFileSync(path.join(SKILL_ROOT, 'SKILL.md'), 'utf8');
    expect(body.startsWith('---')).toBe(true);
    expect(body).toMatch(/^name:\s*chapter-artifact\s*$/m);
    expect(body).toContain('artifact_conventions_path');
  });

  it('ships references/conventions.md with the token block and both page structures', () => {
    const conv = fs.readFileSync(path.join(SKILL_ROOT, 'references', 'conventions.md'), 'utf8');
    for (const [name, value] of Object.entries(TOKENS)) {
      expect(conv).toMatch(new RegExp(`${escapeRe(name)}\\s*:\\s*${value}`, 'i'));
    }
    for (const heading of [...CHAPTER_HEADINGS, ...SUMMARY_HEADINGS]) {
      expect(conv, `conventions should describe "${heading}"`).toContain(heading);
    }
    expect(conv).toMatch(/at most 8 boxes/i);
    expect(conv).toMatch(/verbatim/i);
  });
});
