import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCourseProbes } from '../mcp/server/src/schemas/courseProbes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmplPath = path.resolve(
  __dirname,
  '..',
  'skills/course-creator/templates/plugin.json.tmpl',
);

const rendered = fs
  .readFileSync(tmplPath, 'utf8')
  .replace(/\{\{ name \}\}/g, 'acc-test-course')
  .replace(/\{\{ description \}\}/g, 'test')
  .replace(/\{\{ author \}\}/g, 'Test')
  .replace(/\{\{ keywords_json \}\}/g, '"test"');

describe('course-creator plugin.json.tmpl — toolkit-installed probe seed', () => {
  const parsed = JSON.parse(rendered);

  it('substitutes + parses to valid JSON with the seeded probe', () => {
    expect(parsed.accContent.probes).toHaveLength(1);
    expect(parsed.accContent.probes[0].id).toBe('toolkit-installed');
  });

  it('passes the courseProbes schema validator', () => {
    const result = validateCourseProbes(parsed.accContent.probes);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]).toMatchObject({
        id: 'toolkit-installed',
        kind: 'claude-plugin-enabled',
        params: { plugin_key: 'toolkit@contract-hero' },
      });
    }
  });
});
