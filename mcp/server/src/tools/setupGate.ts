// Shared setup gate for MCP tools that require an active lesson.
//
// Three tools (setPersonalization, nextChapter, verifyChapter) share the same
// pre-work, split in two steps so a tool can stop after the cheap one:
//   1. `loadSelectedState` — load + classify state.json; corrupt /
//      schema-mismatch / absent each produce specific error shapes that
//      forward the classified context the learner needs to recover.
//   2. `resolveSelectedLesson` — resolve the namespaced slug to a loaded
//      LessonData + ChaptersManifest + LessonInfo via the course registry
//      (re-reads plugin discovery and the lessons root on every call).
// `runSetupGate` runs both.

import { loadState, STATE_SCHEMA_VERSION, type State } from '../state.js';
import { discoverCourses } from '../pluginsRoot.js';
import { loadLessonBySlug } from '../registry.js';
import type { LessonData } from '../schemas/lesson.js';
import type { ChaptersManifest } from '../schemas/chapters.js';
import type { LessonInfo } from '../registry.js';

export interface LoadedLesson {
  lesson: LessonData;
  chapters: ChaptersManifest;
  info: LessonInfo;
}

export type LoadSelectedStateResult =
  | { ok: false; errors: string[] }
  | { ok: true; state: State };

export type SetupGateResult =
  | { ok: false; errors: string[] }
  | { ok: true; state: State; loaded: LoadedLesson };

/**
 * Load state.json and require a selected lesson. The specific error prefixes
 * (`State corrupt:`, `State schema mismatch:`, `No lesson selected`) are part
 * of the contract — the skills and tests branch on them.
 */
export async function loadSelectedState(projectRoot: string): Promise<LoadSelectedStateResult> {
  const stateResult = await loadState(projectRoot);
  if (stateResult.kind === 'corrupt') {
    const archiveHint = stateResult.archivedTo
      ? ` Original bytes archived to ${stateResult.archivedTo}.`
      : '';
    return {
      ok: false,
      errors: [
        `State corrupt: ${stateResult.message}.${archiveHint} Delete ${projectRoot}/.acc/state.json and re-run the course's start command to mint fresh state.`,
      ],
    };
  }
  if (stateResult.kind === 'schema-mismatch') {
    return {
      ok: false,
      errors: [
        `State schema mismatch: found schema_version ${stateResult.foundVersion}, this ACC build expects ${STATE_SCHEMA_VERSION}. ${stateResult.message} Delete ${projectRoot}/.acc/state.json and re-run the course's start command to mint fresh v${STATE_SCHEMA_VERSION} state.`,
      ],
    };
  }
  if (stateResult.kind === 'absent' || !stateResult.state.selected_lesson) {
    return {
      ok: false,
      errors: [
        "No lesson selected. Call selectLesson first (or invoke the course plugin's start command, e.g. /acc-claude-sdk:start).",
      ],
    };
  }
  return { ok: true, state: stateResult.state };
}

/** Resolve `state.selected_lesson` against the discovered courses. Error prefix: `Lesson not found:`. */
export function resolveSelectedLesson(
  projectRoot: string,
  state: State,
): { ok: false; errors: string[] } | { ok: true; loaded: LoadedLesson } {
  const discovery = discoverCourses();
  const loaded = loadLessonBySlug(discovery.courses, state.selected_lesson);
  if (!loaded.ok) {
    const courseList = discovery.courses.length === 0
      ? 'no course plugins are currently enabled'
      : `enabled courses: ${discovery.courses.map((c) => c.name).join(', ')}`;
    return {
      ok: false,
      errors: [
        `Lesson not found: ${state.selected_lesson} — ${loaded.error}. State references this slug but ${courseList}. Either install/enable the owning course plugin, or delete ${projectRoot}/.acc/state.json and pick a different lesson.`,
      ],
    };
  }
  return { ok: true, loaded: { lesson: loaded.lesson, chapters: loaded.chapters, info: loaded.info } };
}

export async function runSetupGate(projectRoot: string): Promise<SetupGateResult> {
  const stateStep = await loadSelectedState(projectRoot);
  if (!stateStep.ok) return stateStep;
  const lessonStep = resolveSelectedLesson(projectRoot, stateStep.state);
  if (!lessonStep.ok) return lessonStep;
  return { ok: true, state: stateStep.state, loaded: lessonStep.loaded };
}
