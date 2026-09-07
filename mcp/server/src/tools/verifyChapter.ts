import { saveState } from '../state.js';
import type { State } from '../state.js';
import { runVerification, type VerifySpawnFn } from '../verify.js';
import { loadSelectedState, resolveSelectedLesson } from './setupGate.js';
import { lessonPhase, resolveVerification, staleStateError } from '../progress.js';
import {
  artifactExists,
  chapterArtifactPath,
  reconcileArtifacts,
  summaryArtifactPath,
  SUMMARY_ARTIFACT_KEY,
} from '../artifacts.js';
import type { ArtifactMissingWarning } from '../warnings.js';

/** Test runners print "N skipped" when a suite opted out (vitest, jest, pytest, mocha). */
const SKIPPED_PATTERN = /\b\d+\s+skipped\b/i;

export interface VerifyChapterOutcome {
  ok: true;
  /** True when the verification subprocess exited 0. */
  pass: boolean;
  /** Captured stdout+stderr. */
  output?: string;
  /** True when the cursor advanced (chapter gate passed). Always `pass && !final`. */
  advanced: boolean;
  /** True when this call ran final_verification (the e2e gate). */
  final: boolean;
  /** True when every chapter passed AND the e2e gate passed. Always `final && pass`. */
  done: boolean;
  /** chapter_cursor after this run. */
  chapter_cursor: number;
  /** True when the conventional artifact file existed and was recorded. */
  artifact_recorded: boolean;
  /** Final gate only: the runner reported skipped tests, so the e2e did not run
   * against a live service (usually missing credentials). */
  skipped?: boolean;
  warnings?: ArtifactMissingWarning[];
}

export type VerifyChapterResult = { ok: false; errors: string[] } | VerifyChapterOutcome;

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
    // Fast path: the lesson is done, so the registry is not touched.
    return recordSummary(projectRoot, state);
  }

  const lessonStep = resolveSelectedLesson(projectRoot, state);
  if (!lessonStep.ok) {
    return { ok: false, errors: lessonStep.errors };
  }
  const { chapters, lesson } = lessonStep.loaded;
  const progress = lessonPhase(state, chapters);
  if (progress.phase === 'stale') {
    return { ok: false, errors: [staleStateError(projectRoot, progress)] };
  }
  if (progress.phase === 'done') {
    // Type-exhaustive arm: `lessonPhase` reports `done` only when
    // `completed_at` is set, which the fast path above already handled.
    return recordSummary(projectRoot, state);
  }

  const isFinal = progress.phase === 'e2e';
  const spec = resolveVerification(
    lesson,
    isFinal ? chapters.final_verification : progress.chapter.verification,
  );
  const verifyOpts = spawn !== undefined ? { spawn } : undefined;
  let v;
  try {
    v = await runVerification(spec, state.workspace_path, verifyOpts);
  } catch (err) {
    // An unparseable command is an authoring error, not a learner failure.
    return { ok: false, errors: [`verification-invalid: ${(err as Error).message}`] };
  }
  const ts = new Date().toISOString();

  const artifactKey = isFinal ? SUMMARY_ARTIFACT_KEY : progress.chapter.id;
  const artifactPath = isFinal
    ? summaryArtifactPath(state.workspace_path)
    : chapterArtifactPath(state.workspace_path, progress.index, progress.chapter.id);

  // Back-fill artifacts written after their gate before recording this one.
  const { artifacts } = await reconcileArtifacts(state, chapters);
  const warnings: ArtifactMissingWarning[] = [];
  let artifactRecorded = false;
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

  const result: VerifyChapterOutcome = {
    ok: true,
    pass: v.pass,
    output: v.output,
    advanced: v.pass && !isFinal,
    final: isFinal,
    done: isFinal && v.pass,
    chapter_cursor: newCursor,
    artifact_recorded: artifactRecorded,
  };
  if (isFinal) result.skipped = SKIPPED_PATTERN.test(v.output ?? '');
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

/**
 * Lesson already complete. The summary artifact is written AFTER the e2e
 * gate, so this re-entrant call is where it gets recorded, together with any
 * chapter artifact written late. Nothing is re-run.
 */
async function recordSummary(projectRoot: string, state: State): Promise<VerifyChapterResult> {
  const artifacts = { ...state.artifacts };
  let changed = false;
  const summaryPath = summaryArtifactPath(state.workspace_path);
  if (artifacts[SUMMARY_ARTIFACT_KEY] === undefined && (await artifactExists(summaryPath))) {
    artifacts[SUMMARY_ARTIFACT_KEY] = summaryPath;
    changed = true;
  }
  if (changed) {
    try {
      await saveState(projectRoot, {
        ...state,
        artifacts,
        history: [
          ...state.history,
          { ts: new Date().toISOString(), event: 'verifyChapter:summary:recorded' },
        ],
      });
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
    artifact_recorded: artifacts[SUMMARY_ARTIFACT_KEY] !== undefined,
    output: 'Lesson already complete; final_verification passed earlier.',
  };
}
