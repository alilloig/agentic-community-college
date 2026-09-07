import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { substitutePromptOnly } from '../personalization.js';
import { saveState } from '../state.js';
import { runSetupGate } from './setupGate.js';
import {
  lessonPhase,
  resolveVerification,
  staleStateError,
  type ResolvedVerification,
} from '../progress.js';
import {
  artifactNav,
  chapterArtifactPath,
  CONVENTIONS_PATH,
  reconcileArtifacts,
  summaryArtifactPath,
  type ArtifactNav,
} from '../artifacts.js';
import { isClaudePluginEnabled } from '../outputStyle.js';

/** The plugin whose `publish-html` skill the conductor offers after the summary. */
export const PUBLISH_PLUGIN_KEY = 'toolkit@contract-hero';

interface ChapterLoopCommon {
  /** Total chapters in the lesson. */
  total: number;
  /** Zero-based chapter cursor (equals `total` once every chapter passed). */
  index: number;
  workspace_path: string;
  /** Absolute path to ACC's artifact conventions file. */
  artifact_conventions_path: string;
  /** Absolute path to the lesson's docs snapshot, when the lesson declares one. */
  docs_dir?: string;
}

export interface ChapterEnvelope extends ChapterLoopCommon {
  ok: true;
  done: false;
  completed: false;
  chapter: {
    id: string;
    title: string;
    /** Chapter brief (markdown) with personalization placeholders rendered. */
    brief: string;
    key_idea: string;
    expected_files: string[];
    tests: string[];
    /** Resolved: `cwd` is always present, relative to `workspace_path`. */
    verification: ResolvedVerification;
  };
  /** Where the conductor must write this chapter's artifact. */
  artifact_path: string;
  /** Relative filenames for the artifact's footer links. */
  artifact_nav: ArtifactNav;
}

interface DoneCommon extends ChapterLoopCommon {
  ok: true;
  done: true;
  /** Where the conductor must write the summary artifact. */
  summary_artifact_path: string;
  /** Chapter id → recorded artifact path (plus `summary` once recorded). */
  artifacts: Record<string, string>;
  /** True when the publish-html plugin is enabled. */
  publish_available: boolean;
}

/** Every chapter passed; the e2e gate has not run yet. */
export interface E2ePendingEnvelope extends DoneCommon {
  completed: false;
  final_verification: ResolvedVerification;
}

/** The e2e gate passed. */
export interface CompletedEnvelope extends DoneCommon {
  completed: true;
}

export type NextChapterResult =
  | { ok: false; errors: string[] }
  | ChapterEnvelope
  | E2ePendingEnvelope
  | CompletedEnvelope;

export async function runNextChapter({
  projectRoot,
}: {
  projectRoot: string;
}): Promise<NextChapterResult> {
  const gate = await runSetupGate(projectRoot);
  if (!gate.ok) {
    return { ok: false, errors: gate.errors };
  }
  const { state, loaded } = gate;
  const { chapters, lesson, info } = loaded;

  const common: ChapterLoopCommon = {
    total: chapters.chapters.length,
    index: state.chapter_cursor,
    workspace_path: state.workspace_path,
    artifact_conventions_path: CONVENTIONS_PATH,
  };
  if (lesson.docs !== undefined) common.docs_dir = path.join(info.lesson_dir, lesson.docs);

  const progress = lessonPhase(state, chapters);
  if (progress.phase === 'stale') {
    return { ok: false, errors: [staleStateError(projectRoot, progress)] };
  }

  if (progress.phase !== 'chapter') {
    // Artifacts written after their gate are picked up here so the summary
    // cards never miss a chapter.
    const reconciled = await reconcileArtifacts(state, chapters);
    if (reconciled.changed) {
      try {
        await saveState(projectRoot, { ...state, artifacts: reconciled.artifacts });
      } catch (err) {
        return { ok: false, errors: [`state-save-failed: ${(err as Error).message}`] };
      }
    }
    const done: DoneCommon = {
      ...common,
      ok: true,
      done: true,
      summary_artifact_path: summaryArtifactPath(state.workspace_path),
      artifacts: reconciled.artifacts,
      publish_available: isClaudePluginEnabled(PUBLISH_PLUGIN_KEY),
    };
    if (progress.phase === 'e2e') {
      return {
        ...done,
        completed: false,
        final_verification: resolveVerification(lesson, chapters.final_verification),
      };
    }
    return { ...done, completed: true };
  }

  const { index, chapter } = progress;
  const briefPath = path.join(info.lesson_dir, chapter.brief_md);
  let brief: string;
  try {
    brief = await fsPromises.readFile(briefPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      errors: [`chapter-brief-missing: ${briefPath} (${(err as Error).message})`],
    };
  }
  brief = substitutePromptOnly(brief, state.personalization);

  return {
    ...common,
    ok: true,
    done: false,
    completed: false,
    chapter: {
      id: chapter.id,
      title: chapter.title,
      brief,
      key_idea: chapter.key_idea,
      expected_files: chapter.expected_files,
      tests: chapter.tests,
      verification: resolveVerification(lesson, chapter.verification),
    },
    artifact_path: chapterArtifactPath(state.workspace_path, index, chapter.id),
    artifact_nav: artifactNav(chapters.chapters, index),
  };
}
