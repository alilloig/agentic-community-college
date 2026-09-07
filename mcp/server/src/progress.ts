// progress.ts — the single reading of "where is this lesson" and "what does
// this step run". `nextChapter` and `verifyChapter` both switch on
// `lessonPhase` so the four phases (chapter, e2e pending, done, stale) exist
// in one place, and both hand out the same resolved verification spec.

import type { ChapterData, ChaptersManifest, VerificationMode, VerificationSpec } from './schemas/chapters.js';
import type { LessonData } from './schemas/lesson.js';
import type { State } from './schemas/state.js';

export type LessonPhase =
  | { phase: 'chapter'; index: number; chapter: ChapterData }
  | { phase: 'e2e' }
  | { phase: 'done' }
  /** `chapter_cursor` is past the manifest: chapters.json changed under the lesson. */
  | { phase: 'stale'; cursor: number; found: number };

export function lessonPhase(state: State, chapters: ChaptersManifest): LessonPhase {
  if (state.completed_at !== undefined) return { phase: 'done' };
  const index = state.chapter_cursor;
  const found = chapters.chapters.length;
  if (index > found) return { phase: 'stale', cursor: index, found };
  if (index === found) return { phase: 'e2e' };
  return { phase: 'chapter', index, chapter: chapters.chapters[index] };
}

/** Error text both tools return for a stale cursor. Prefix is part of the contract. */
export function staleStateError(projectRoot: string, phase: Extract<LessonPhase, { phase: 'stale' }>): string {
  return `Lesson state stale: chapter_cursor ${phase.cursor} is past the ${phase.found} chapters in chapters.json (the course changed on disk). Re-run the course's start command with restart to begin again, or delete ${projectRoot}/.acc/state.json.`;
}

/** A verification spec with every lesson-level default applied. `cwd` is workspace-relative. */
export interface ResolvedVerification {
  mode: VerificationMode;
  command: string;
  cwd: string;
}

/**
 * Apply the lesson-level defaults to a verification spec, so the conductor
 * and the gate run the same command in the same directory.
 */
export function resolveVerification(lesson: LessonData, spec: VerificationSpec): ResolvedVerification {
  return {
    mode: spec.mode,
    command: spec.command,
    cwd: spec.cwd ?? lesson.workspace.verification_cwd ?? '.',
  };
}
