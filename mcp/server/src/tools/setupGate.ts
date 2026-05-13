// Shared setup gate for MCP tools that require an active lesson.
//
// Five tools (setOutputMode, setPersonalization, nextSection, verifySection,
// advanceArtifact) share the same pre-work:
//   1. Probe the learning-output-style plugin (L002 carry-forward — MUST run
//      before any state load).
//   2. Load + classify state.json; corrupt / schema-mismatch / absent each
//      produce specific error shapes that forward the classified context the
//      learner needs to recover (archive path, found schema version, missing
//      slug + visible courses).
//   3. Require state.selected_lesson — these tools are meaningless without one.
//   4. (Optional) Resolve the namespaced slug to a loaded LessonData +
//      SectionsManifest + LessonInfo via the course registry.
//
// Returning a tagged union keeps the call sites flat: each tool either bails
// with the carried `errors` or destructures `state` / `loaded` and continues.

import { loadState, STATE_SCHEMA_VERSION, type State } from '../state.js';
import { probeOutputStyle } from '../outputStyle.js';
import { discoverCourses } from '../pluginsRoot.js';
import { loadLessonBySlug } from '../registry.js';
import type { LessonData } from '../schemas/lesson.js';
import type { SectionsManifest } from '../schemas/sections.js';
import type { LessonInfo } from '../registry.js';

export interface LoadedLesson {
  lesson: LessonData;
  sections: SectionsManifest;
  info: LessonInfo;
}

export type SetupGateResult =
  | { ok: false; errors: string[] }
  | { ok: true; state: State; loaded: LoadedLesson };

/**
 * Run the canonical tool entry sequence:
 *   output-style probe → state load → selected-lesson lookup → registry resolve.
 *
 * Each failure mode surfaces a structured, actionable error string. The
 * specific prefixes (`output-style-disabled`, `State corrupt:`, `State
 * schema mismatch:`, `No lesson selected`, `Lesson not found:`) are part of
 * the contract — the conductor and tests branch on them.
 */
export async function runSetupGate(projectRoot: string): Promise<SetupGateResult> {
  const styleCheck = await probeOutputStyle();
  if (!styleCheck.ok) {
    return { ok: false, errors: ['output-style-disabled'] };
  }

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
  if (stateResult.kind === 'absent') {
    return {
      ok: false,
      errors: [
        'No lesson selected. Call selectLesson first (or invoke the course plugin\'s start command, e.g. /acc-deepbook-course:start).',
      ],
    };
  }
  if (!stateResult.state.selected_lesson) {
    return {
      ok: false,
      errors: [
        'No lesson selected. Call selectLesson first (or invoke the course plugin\'s start command, e.g. /acc-deepbook-course:start).',
      ],
    };
  }

  const state = stateResult.state;
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

  return {
    ok: true,
    state,
    loaded: { lesson: loaded.lesson, sections: loaded.sections, info: loaded.info },
  };
}
