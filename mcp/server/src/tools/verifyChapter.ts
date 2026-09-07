import { saveState } from '../state.js';
import type { State } from '../state.js';
import { runVerification, type VerifySpawnFn } from '../verify.js';
import { loadSelectedState, resolveSelectedLesson } from './setupGate.js';
import { lessonPhase, resolveVerification } from '../progress.js';
import {
  artifactExists,
  chapterArtifactPath,
  summaryArtifactPath,
  SUMMARY_ARTIFACT_KEY,
} from '../artifacts.js';
import type { ArtifactMissingWarning } from '../warnings.js';

export interface VerifyChapterResult {
  ok: boolean;
  errors?: string[];
  /** True when the verification subprocess exited 0. */
  pass?: boolean;
  /** Captured stdout+stderr. */
  output?: string;
  /** True when the cursor advanced (chapter gate passed). */
  advanced?: boolean;
  /** True when this call ran final_verification (the e2e gate). */
  final?: boolean;
  /** True when every chapter passed AND the e2e gate passed. */
  done?: boolean;
  /** chapter_cursor after this run. */
  chapter_cursor?: number;
  /** True when the conventional artifact file existed and was recorded. */
  artifact_recorded?: boolean;
  warnings?: ArtifactMissingWarning[];
}

export async function runVerifyChapter({
  projectRoot,
  spawn,
}: {
  projectRoot: string;
  /** Test seam; production leaves it undefined and we fall back to node:child_process. */
  spawn?: VerifySpawnFn;
}): Promise<VerifyChapterResult> {
  const stateStep = await loadSelectedState(projectRoot);
  if (!stateStep.ok) {
    return { ok: false, errors: stateStep.errors };
  }
  const { state } = stateStep;

  if (state.completed_at !== undefined) {
    return recordSummary(projectRoot, state);
  }

  const lessonStep = resolveSelectedLesson(projectRoot, state);
  if (!lessonStep.ok) {
    return { ok: false, errors: lessonStep.errors };
  }
  const { chapters, lesson } = lessonStep.loaded;
  const progress = lessonPhase(state, chapters);
  if (progress.phase === 'done') {
    return recordSummary(projectRoot, state);
  }

  const isFinal = progress.phase === 'e2e';
  const spec = resolveVerification(
    lesson,
    isFinal ? chapters.final_verification : progress.chapter.verification,
  );
  const verifyOpts = spawn !== undefined ? { spawn } : undefined;
  const v = await runVerification(spec, state.workspace_path ?? projectRoot, verifyOpts);
  const ts = new Date().toISOString();

  const artifactKey = isFinal ? SUMMARY_ARTIFACT_KEY : progress.chapter.id;
  const artifactPath = isFinal
    ? summaryArtifactPath(projectRoot, state.workspace_path)
    : chapterArtifactPath(projectRoot, state.workspace_path, progress.index, progress.chapter.id);

  const warnings: ArtifactMissingWarning[] = [];
  let artifactRecorded = false;
  const artifacts = { ...state.artifacts };
  if (v.pass) {
    if (await artifactExists(artifactPath)) {
      artifacts[artifactKey] = artifactPath;
      artifactRecorded = true;
    } else if (!isFinal) {
      // The summary is written AFTER the e2e gate by design, so its absence
      // here is expected. A missing chapter artifact means the conductor
      // skipped the explain step; surface it, do not block.
      warnings.push({
        kind: 'artifact-missing',
        message: `No artifact found at ${artifactPath}. The chapter passed; write the artifact before moving on.`,
      });
    }
  }

  const newCursor = v.pass && !isFinal ? state.chapter_cursor + 1 : state.chapter_cursor;
  const updated: State = {
    ...state,
    chapter_cursor: newCursor,
    artifacts,
    history: [
      ...state.history,
      { ts, event: `verifyChapter:${isFinal ? 'final' : progress.chapter.id}:${v.pass ? 'pass' : 'fail'}` },
    ],
    test_status: { pass: v.pass, output: v.output, ts, final: isFinal },
  };
  if (isFinal && v.pass) updated.completed_at = ts;

  try {
    await saveState(projectRoot, updated);
  } catch (err) {
    return { ok: false, errors: [`state-save-failed: ${(err as Error).message}`] };
  }

  const result: VerifyChapterResult = {
    ok: true,
    pass: v.pass,
    output: v.output,
    advanced: v.pass && !isFinal,
    final: isFinal,
    done: isFinal && v.pass,
    chapter_cursor: newCursor,
    artifact_recorded: artifactRecorded,
  };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

/**
 * Lesson already complete. The summary artifact is written AFTER the e2e
 * gate, so this re-entrant call is where it gets recorded. Nothing is re-run,
 * and the registry is not touched.
 */
async function recordSummary(projectRoot: string, state: State): Promise<VerifyChapterResult> {
  const summaryPath = summaryArtifactPath(projectRoot, state.workspace_path);
  let summaryRecorded = state.artifacts[SUMMARY_ARTIFACT_KEY] !== undefined;
  if (!summaryRecorded && (await artifactExists(summaryPath))) {
    try {
      await saveState(projectRoot, {
        ...state,
        artifacts: { ...state.artifacts, [SUMMARY_ARTIFACT_KEY]: summaryPath },
        history: [
          ...state.history,
          { ts: new Date().toISOString(), event: 'verifyChapter:summary:recorded' },
        ],
      });
      summaryRecorded = true;
    } catch (err) {
      return { ok: false, errors: [`state-save-failed: ${(err as Error).message}`] };
    }
  }
  return {
    ok: true,
    pass: true,
    final: true,
    done: true,
    advanced: false,
    chapter_cursor: state.chapter_cursor,
    artifact_recorded: summaryRecorded,
    output: 'Lesson already complete; final_verification passed earlier.',
  };
}
