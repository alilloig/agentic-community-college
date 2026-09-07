import { saveState } from '../state.js';
import type { State } from '../state.js';
import { runVerification, type VerifySpawnFn } from '../verify.js';
import { runSetupGate } from './setupGate.js';
import {
  artifactExists,
  chapterArtifactPath,
  summaryArtifactPath,
  SUMMARY_ARTIFACT_KEY,
} from '../artifacts.js';

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
  warnings?: Array<{ kind: string; message: string }>;
}

export async function runVerifyChapter({
  projectRoot,
  spawn,
}: {
  projectRoot: string;
  /** Test seam; production leaves it undefined and we fall back to node:child_process. */
  spawn?: VerifySpawnFn;
}): Promise<VerifyChapterResult> {
  const gate = await runSetupGate(projectRoot);
  if (!gate.ok) {
    return { ok: false, errors: gate.errors };
  }
  const { state, loaded } = gate;
  const { chapters, lesson } = loaded;

  const total = chapters.chapters.length;
  const cursor = state.chapter_cursor;
  const isFinal = cursor >= total;

  if (isFinal && state.completed_at !== undefined) {
    // Lesson done. The summary artifact is written AFTER the e2e gate, so this
    // re-entrant call is where it gets recorded. Nothing is re-run.
    const summaryPath = summaryArtifactPath(projectRoot, state.workspace_path);
    let summaryRecorded = state.artifacts[SUMMARY_ARTIFACT_KEY] !== undefined;
    if (!summaryRecorded && artifactExists(summaryPath)) {
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
      chapter_cursor: cursor,
      artifact_recorded: summaryRecorded,
      output: 'Lesson already complete; final_verification passed earlier.',
    };
  }

  const chapter = isFinal ? undefined : chapters.chapters[cursor];
  const spec = isFinal ? chapters.final_verification : chapter!.verification;

  const verifyCwd = state.workspace_path ?? projectRoot;
  const fullSpec = { ...spec };
  if (lesson.workspace?.verification_cwd && fullSpec.cwd === undefined) {
    fullSpec.cwd = lesson.workspace.verification_cwd;
  }

  const verifyOpts = spawn !== undefined ? { spawn } : undefined;
  const v = await runVerification(fullSpec, verifyCwd, verifyOpts);
  const ts = new Date().toISOString();

  const warnings: VerifyChapterResult['warnings'] = [];
  let artifactRecorded = false;
  const artifacts = { ...state.artifacts };

  if (v.pass) {
    const artifactPath = isFinal
      ? summaryArtifactPath(projectRoot, state.workspace_path)
      : chapterArtifactPath(projectRoot, state.workspace_path, cursor, chapter!.id);
    const key = isFinal ? SUMMARY_ARTIFACT_KEY : chapter!.id;
    if (artifactExists(artifactPath)) {
      artifacts[key] = artifactPath;
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

  const newCursor = v.pass && !isFinal ? cursor + 1 : cursor;
  const eventLabel = isFinal ? 'final' : chapter!.id;

  const updated: State = {
    ...state,
    chapter_cursor: newCursor,
    artifacts,
    history: [
      ...state.history,
      { ts, event: `verifyChapter:${eventLabel}:${v.pass ? 'pass' : 'fail'}` },
    ],
    test_status: {
      pass: v.pass,
      output: v.output,
      ts,
      final: isFinal,
    },
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
