// progress.ts — the single reading of "where is this lesson" and "what does
// this step run". `nextChapter` and `verifyChapter` both switch on
// `lessonPhase` so the three phases (chapter, e2e pending, done) exist in one
// place, and both hand out the same resolved verification spec.

import type { ChapterData, ChaptersManifest, VerificationSpec } from './schemas/chapters.js';
import type { LessonData } from './schemas/lesson.js';
import type { State } from './schemas/state.js';

export type LessonPhase =
  | { phase: 'chapter'; index: number; chapter: ChapterData }
  | { phase: 'e2e' }
  | { phase: 'done' };

export function lessonPhase(state: State, chapters: ChaptersManifest): LessonPhase {
  if (state.completed_at !== undefined) return { phase: 'done' };
  const index = state.chapter_cursor;
  if (index >= chapters.chapters.length) return { phase: 'e2e' };
  return { phase: 'chapter', index, chapter: chapters.chapters[index] };
}

/**
 * Apply the lesson-level defaults to a verification spec. Returned specs
 * always carry a `cwd` (workspace-relative), so the conductor and the gate
 * run the same command in the same directory.
 */
export function resolveVerification(lesson: LessonData, spec: VerificationSpec): Required<VerificationSpec> {
  return {
    mode: spec.mode,
    command: spec.command,
    cwd: spec.cwd ?? lesson.workspace?.verification_cwd ?? '.',
  };
}
