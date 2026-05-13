import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmplPath = path.resolve(
  __dirname,
  '..',
  'skills/lesson-creator/templates/template.html.tmpl',
);

const html = fs.readFileSync(tmplPath, 'utf8');

describe('lesson-creator template.html.tmpl — state injection safety', () => {
  it('contains exactly one match for the advanceArtifact injector regex', () => {
    const matches = html.match(/<!--\s*ACC_STATE\s*-->/gi);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  it('marker sits inside the body (between <body> and </body>)', () => {
    const bodyOpen = html.indexOf('<body');
    const bodyClose = html.indexOf('</body>');
    const markerRe = /<!--\s*ACC_STATE\s*-->/i;
    const m = markerRe.test(html);
    expect(m).toBe(true);
    const markerOffset = html.search(markerRe);
    expect(markerOffset).toBeGreaterThan(bodyOpen);
    expect(markerOffset).toBeLessThan(bodyClose);
  });

  it('the only `<!--` followed by `-->` enclosing "ACC_STATE" lives at the marker line', () => {
    // Defensive: no header doc-comment or other commentary should contain the
    // literal token, because the injector matches the first occurrence.
    const matches = [...html.matchAll(/<!--\s*ACC_STATE\s*-->/gi)];
    expect(matches.length).toBe(1);
    const lineNo = html.slice(0, matches[0].index!).split('\n').length;
    // The marker is the placeholder near the end of the body; it should be
    // far below the <html> opening, not within the first 30 lines.
    expect(lineNo).toBeGreaterThan(30);
  });
});
