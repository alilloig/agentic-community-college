import { loadState, saveState } from '../state.js';
import { probeOutputStyle } from '../outputStyle.js';
import { discoverCourses } from '../pluginsRoot.js';
import { loadLessonBySlug } from '../registry.js';
import { runVerification, type VerifySpawnFn } from '../verify.js';

export interface VerifySectionResult {
  ok: boolean;
  errors?: string[];
  /** True when the verification subprocess exited 0. */
  pass?: boolean;
  /** Captured stdout+stderr (truncated by the spawn). */
  output?: string;
  /** True when verifySection advanced the cursor (on pass). */
  advanced?: boolean;
  /** True when this verifySection ran the lesson's final_verification. */
  final?: boolean;
  /** True when the cursor reached the end after this run. */
  done?: boolean;
  /** New section_cursor value (post-run). */
  section_cursor?: number;
}

export async function runVerifySection({
  projectRoot,
  spawn,
}: {
  projectRoot: string;
  /** Test seam; production leaves it undefined and we fall back to node:child_process. */
  spawn?: VerifySpawnFn;
}): Promise<VerifySectionResult> {
  const styleCheck = await probeOutputStyle();
  if (!styleCheck.ok) {
    return { ok: false, errors: ['output-style-disabled'] };
  }

  const stateResult = await loadState(projectRoot);
  if (stateResult.kind === 'corrupt') {
    return { ok: false, errors: [`State corrupt: ${stateResult.message}`] };
  }
  if (stateResult.kind === 'schema-mismatch') {
    return { ok: false, errors: [`State schema mismatch: ${stateResult.message}`] };
  }
  if (stateResult.kind === 'absent' || !stateResult.state.selected_lesson) {
    return { ok: false, errors: ['No lesson selected. Call selectLesson first.'] };
  }

  const state = stateResult.state;
  const discovery = discoverCourses();
  const loaded = loadLessonBySlug(discovery.courses, state.selected_lesson);
  if (!loaded.ok) {
    return { ok: false, errors: [loaded.error] };
  }
  const { sections, lesson } = loaded;

  const total = sections.sections.length;
  const cursor = state.section_cursor;
  const isFinal = cursor >= total - 1;

  // Choose verification: the current section's, or final_verification if
  // we're at the last section.
  const section = sections.sections[Math.min(cursor, total - 1)];
  const adapter = isFinal
    ? sections.final_verification
    : section.verification ?? sections.final_verification;

  // Resolve verification cwd against the workspace if one exists.
  const verifyCwd = state.workspace_path ?? projectRoot;
  const fullAdapter = { ...adapter };
  if (lesson.workspace?.verification_cwd && fullAdapter.cwd === undefined) {
    fullAdapter.cwd = lesson.workspace.verification_cwd;
  }

  const verifyOpts = spawn !== undefined ? { spawn } : undefined;
  const v = await runVerification(fullAdapter, verifyCwd, verifyOpts);

  // Advance cursor on pass.
  let newCursor = cursor;
  let advanced = false;
  if (v.pass) {
    newCursor = cursor + 1;
    advanced = newCursor !== cursor;
  }

  const updated = {
    ...state,
    section_cursor: newCursor,
    test_status: {
      pass: v.pass,
      output: v.output,
      ts: new Date().toISOString(),
    },
  };
  try {
    await saveState(projectRoot, updated);
  } catch (err) {
    return { ok: false, errors: [`state-save-failed: ${(err as Error).message}`] };
  }

  return {
    ok: true,
    pass: v.pass,
    output: v.output,
    advanced,
    final: isFinal,
    done: newCursor >= total,
    section_cursor: newCursor,
  };
}
