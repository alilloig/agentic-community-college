import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateLesson, type LessonData } from './schemas/lesson.js';
import { validateChapters, type ChaptersManifest } from './schemas/chapters.js';
import type { DiscoveredCourse } from './pluginsRoot.js';
import type { RegistryWarning } from './warnings.js';

export type { RegistryWarning };

/**
 * Public summary of a lesson, surfaced to the course-engine and `start` tool.
 * The full `LessonData` and `ChaptersManifest` are loaded lazily by tools
 * that need them (selectLesson, nextChapter, verifyChapter).
 */
export interface LessonInfo {
  slug: string;
  title: string;
  summary: string;
  personalization_options: string[];
  /** Plugin key of the owning course (e.g. `acc-claude-sdk@contract-hero`). */
  course_name: string;
  /** Course-prefixed slug used as the public identifier: `<course>/<slug>`. */
  namespaced_slug: string;
  /** Absolute path to the course's lessons root. */
  lessons_root: string;
  /** Absolute path to this lesson's directory. */
  lesson_dir: string;
  /** Total number of chapters (loaded eagerly so the catalog can render
   * "N chapters" without a second tool round-trip). */
  chapter_count: number;
}

export interface CoursesRegistryResult {
  lessons: LessonInfo[];
  warnings: RegistryWarning[];
}

interface ScanSingleRootResult {
  lessons: Array<{
    info: LessonInfo;
    lesson: LessonData;
    chapters: ChaptersManifest;
  }>;
  warnings: RegistryWarning[];
}

/**
 * Scan a single lessons-root directory. Each immediate subdirectory is
 * interpreted as a lesson and validated against `lesson.json` + `chapters.json`
 * together.
 *
 * Internal helper — most callers go through `scanCourses` instead.
 */
export function scanLessonsRoot(
  scanRoot: string,
  courseName: string,
): ScanSingleRootResult {
  const result: ScanSingleRootResult = { lessons: [], warnings: [] };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(scanRoot, { withFileTypes: true });
  } catch {
    result.warnings.push({
      kind: 'no-paths-dir',
      message: `Lessons directory not found: ${scanRoot}`,
      path: scanRoot,
    });
    return result;
  }

  const dirEntries = entries.filter((e) => e.isDirectory());
  if (dirEntries.length === 0) {
    result.warnings.push({
      kind: 'empty-paths-dir',
      message: `Lessons directory exists but contains no lesson subdirectories: ${scanRoot}`,
      path: scanRoot,
    });
    return result;
  }

  for (const entry of dirEntries) {
    const lessonDir = path.join(scanRoot, entry.name);
    const lessonJsonFile = path.join(lessonDir, 'lesson.json');

    if (!fs.existsSync(lessonJsonFile)) {
      result.warnings.push({
        kind: 'missing-path-json',
        message: `No lesson.json found in ${lessonDir}`,
        path: lessonDir,
      });
      continue;
    }

    let lessonRaw: string;
    try {
      lessonRaw = fs.readFileSync(lessonJsonFile, 'utf8');
    } catch (err) {
      result.warnings.push({
        kind: 'malformed-path-json',
        message: `Failed to read ${lessonJsonFile}: ${err instanceof Error ? err.message : String(err)}`,
        path: lessonJsonFile,
      });
      continue;
    }

    let lessonParsed: unknown;
    try {
      lessonParsed = JSON.parse(lessonRaw);
    } catch (err) {
      result.warnings.push({
        kind: 'malformed-path-json',
        message: `Failed to parse ${lessonJsonFile}: ${err instanceof Error ? err.message : String(err)}`,
        path: lessonJsonFile,
      });
      continue;
    }

    const lessonValidation = validateLesson(lessonParsed);
    if (!lessonValidation.ok) {
      result.warnings.push({
        kind: 'invalid-path-json',
        message: `Schema validation failed for ${lessonJsonFile}: ${lessonValidation.error}`,
        path: lessonJsonFile,
      });
      continue;
    }

    // chapters.json is load-bearing: a lesson without it is not runnable.
    const chaptersJsonFile = path.join(lessonDir, 'chapters.json');
    let chaptersRaw: string;
    try {
      chaptersRaw = fs.readFileSync(chaptersJsonFile, 'utf8');
    } catch {
      const legacyHint = fs.existsSync(path.join(lessonDir, 'sections.json'))
        ? ' This lesson uses the v0.2 sections.json model; migrate it to chapters.json (ACC v0.3).'
        : '';
      result.warnings.push({
        kind: 'missing-phases-json',
        message: `No chapters.json found in ${lessonDir}.${legacyHint}`,
        path: lessonDir,
      });
      continue;
    }

    let chaptersParsed: unknown;
    try {
      chaptersParsed = JSON.parse(chaptersRaw);
    } catch (err) {
      result.warnings.push({
        kind: 'malformed-phases-json',
        message: `Failed to parse ${chaptersJsonFile}: ${err instanceof Error ? err.message : String(err)}`,
        path: chaptersJsonFile,
      });
      continue;
    }

    const chaptersValidation = validateChapters(chaptersParsed);
    if (!chaptersValidation.ok) {
      result.warnings.push({
        kind: 'invalid-phases-json',
        message: `Schema validation failed for ${chaptersJsonFile}: ${chaptersValidation.error}`,
        path: chaptersJsonFile,
      });
      continue;
    }

    const lesson = lessonValidation.value;
    const chapters = chaptersValidation.value;
    result.lessons.push({
      info: {
        slug: lesson.slug,
        title: lesson.title,
        summary: lesson.summary,
        personalization_options: lesson.personalization_options,
        course_name: courseName,
        namespaced_slug: `${courseName}/${lesson.slug}`,
        lessons_root: scanRoot,
        lesson_dir: lessonDir,
        chapter_count: chapters.chapters.length,
      },
      lesson,
      chapters,
    });
  }

  return result;
}

/**
 * Aggregate lessons across every discovered course. Each course's
 * `lessonsRoot` is scanned through `scanLessonsRoot`; results are namespaced
 * by course name so a downstream tool can always tell which course a lesson
 * belongs to.
 */
export async function scanCourses(
  courses: readonly DiscoveredCourse[],
): Promise<CoursesRegistryResult> {
  const lessons: LessonInfo[] = [];
  const warnings: RegistryWarning[] = [];

  for (const course of courses) {
    const inner = scanLessonsRoot(course.lessonsRoot, course.name);
    warnings.push(...inner.warnings);
    for (const lesson of inner.lessons) {
      lessons.push(lesson.info);
    }
  }

  return { lessons, warnings };
}

/**
 * Eager-load the lesson + chapters for a single namespaced slug. Used by
 * tools that need the full manifests, not just the public summary.
 */
export function loadLessonBySlug(
  courses: readonly DiscoveredCourse[],
  namespacedSlug: string,
): { ok: true; lesson: LessonData; chapters: ChaptersManifest; info: LessonInfo }
| { ok: false; error: string } {
  const slashIdx = namespacedSlug.indexOf('/');
  if (slashIdx <= 0) {
    return { ok: false, error: `Slug must be namespaced as <course>/<lesson> (got '${namespacedSlug}')` };
  }
  const courseName = namespacedSlug.slice(0, slashIdx);
  const lessonSlug = namespacedSlug.slice(slashIdx + 1);
  const course = courses.find((c) => c.name === courseName);
  if (!course) {
    return { ok: false, error: `Course '${courseName}' is not discovered.` };
  }
  const scan = scanLessonsRoot(course.lessonsRoot, course.name);
  const hit = scan.lessons.find((l) => l.lesson.slug === lessonSlug);
  if (!hit) {
    return { ok: false, error: `Lesson '${lessonSlug}' not found in course '${courseName}'.` };
  }
  return { ok: true, lesson: hit.lesson, chapters: hit.chapters, info: hit.info };
}
