import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanCourses } from '../mcp/server/src/registry.js';
import type { DiscoveredCourse } from '../mcp/server/src/pluginsRoot.js';

let tempRoots: string[] = [];

function makeTempRoot(prefix = 'acc-course-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function makeWellFormedLesson(root: string, slug: string): void {
  writeJson(path.join(root, slug, 'lesson.json'), {
    slug,
    title: `${slug} title`,
    summary: `${slug} summary`,
    personalization_options: [],
    workspace: { host: 'reference-app' },
  });
  writeJson(path.join(root, slug, 'chapters.json'), {
    schema_version: 2,
    chapters: [
      {
        id: 'c01-bootstrap',
        title: 'Chapter 1',
        brief_md: 'chapters/01-bootstrap.md',
        key_idea: 'first key idea',
        expected_files: ['src/App.tsx'],
        tests: ['tests/app.test.ts'],
        verification: { mode: 'test-suite', command: 'pnpm vitest run tests/app.test.ts' },
      },
    ],
    final_verification: { mode: 'test-suite', command: 'pnpm vitest run' },
  });
}

function buildCourse(name: string, lessonSlugs: string[]): DiscoveredCourse {
  const lessonsRoot = makeTempRoot(`acc-course-${name}-`);
  for (const slug of lessonSlugs) makeWellFormedLesson(lessonsRoot, slug);
  return { name: `${name}@local`, dir: lessonsRoot, lessonsRoot, probes: [], paths: [] };
}

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

describe('scanCourses', () => {
  it('returns an empty result for an empty course list', async () => {
    const result = await scanCourses([]);
    expect(result.lessons).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('namespaces lesson slugs with the course key', async () => {
    const course = buildCourse('deepbook', ['01-orderbook-viewer']);
    const result = await scanCourses([course]);
    expect(result.warnings).toEqual([]);
    expect(result.lessons).toHaveLength(1);
    expect(result.lessons[0].slug).toBe('01-orderbook-viewer');
    expect(result.lessons[0].course_name).toBe('deepbook@local');
    expect(result.lessons[0].namespaced_slug).toBe('deepbook@local/01-orderbook-viewer');
    expect(result.lessons[0].lessons_root).toBe(course.lessonsRoot);
  });

  it('aggregates lessons across multiple courses, keeping namespacing intact', async () => {
    const deepbook = buildCourse('deepbook', ['01-orderbook-viewer']);
    const walrus = buildCourse('walrus', ['01-blob-basics', '02-quilts']);
    const result = await scanCourses([deepbook, walrus]);
    expect(result.warnings).toEqual([]);
    expect(result.lessons).toHaveLength(3);
    const slugs = result.lessons.map((l) => l.namespaced_slug).sort();
    expect(slugs).toEqual([
      'deepbook@local/01-orderbook-viewer',
      'walrus@local/01-blob-basics',
      'walrus@local/02-quilts',
    ]);
  });

  it('forwards per-course registry warnings (e.g. malformed lesson)', async () => {
    const lessonsRoot = makeTempRoot('acc-course-bad-');
    makeWellFormedLesson(lessonsRoot, '01-good');
    writeJson(path.join(lessonsRoot, '02-bad', 'lesson.json'), { slug: '02-bad' });

    const course: DiscoveredCourse = {
      name: 'bad@local',
      dir: lessonsRoot,
      lessonsRoot,
      probes: [],
      paths: [],
    };
    const result = await scanCourses([course]);
    expect(result.lessons).toHaveLength(1);
    expect(result.lessons[0].slug).toBe('01-good');
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.some((w) => w.kind === 'invalid-path-json')).toBe(true);
  });

  it('LessonInfo carries lesson_dir + chapter_count for downstream tools', async () => {
    const course = buildCourse('deepbook', ['01-market-stats']);
    const result = await scanCourses([course]);
    expect(result.lessons[0].chapter_count).toBe(1);
    expect(result.lessons[0].lesson_dir).toBe(
      path.join(course.lessonsRoot, '01-market-stats'),
    );
  });

  it('flags v0.2 lessons (sections.json, no chapters.json) with a migration hint', async () => {
    const lessonsRoot = makeTempRoot('acc-course-legacy-');
    writeJson(path.join(lessonsRoot, '01-old', 'lesson.json'), {
      slug: '01-old',
      title: 'old',
      summary: 'old',
      personalization_options: [],
      build_command: 'pnpm build',
      workspace: { host: 'reference-app', files: [] },
    });
    writeJson(path.join(lessonsRoot, '01-old', 'sections.json'), { schema_version: 1, sections: [] });
    const course: DiscoveredCourse = { name: 'legacy@local', dir: lessonsRoot, lessonsRoot, probes: [], paths: [] };
    const result = await scanCourses([course]);
    expect(result.lessons).toHaveLength(0);
    const w = result.warnings.find((x) => x.kind === 'missing-chapters-json');
    expect(w?.message).toMatch(/chapters\.json/);
    expect(w?.message).toMatch(/v0\.2/);
  });

  it('reports malformed and invalid chapters.json with their own kinds', async () => {
    const lessonsRoot = makeTempRoot('acc-course-chapters-');
    makeWellFormedLesson(lessonsRoot, '01-ok');
    fs.writeFileSync(path.join(lessonsRoot, '01-ok', 'chapters.json'), '{ not json', 'utf8');
    makeWellFormedLesson(lessonsRoot, '02-bad');
    writeJson(path.join(lessonsRoot, '02-bad', 'chapters.json'), { schema_version: 2, chapters: [] });
    const course: DiscoveredCourse = { name: 'c@local', dir: lessonsRoot, lessonsRoot, probes: [], paths: [] };
    const result = await scanCourses([course]);
    expect(result.lessons).toHaveLength(0);
    expect(result.warnings.map((w) => w.kind).sort()).toEqual(['invalid-chapters-json', 'malformed-chapters-json']);
  });
});
