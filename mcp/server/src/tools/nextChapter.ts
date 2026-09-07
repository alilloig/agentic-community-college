import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { substitutePromptOnly } from '../personalization.js';
import { runSetupGate } from './setupGate.js';
import { lessonPhase, resolveVerification } from '../progress.js';
import {
  artifactNav,
  chapterArtifactPath,
  CONVENTIONS_PATH,
  summaryArtifactPath,
  type ArtifactNav,
} from '../artifacts.js';
import { isClaudePluginEnabled } from '../outputStyle.js';
import type { VerificationSpec } from '../schemas/chapters.js';

/** The plugin whose `publish-html` skill the conductor offers after the summary. */
export const PUBLISH_PLUGIN_KEY = 'toolkit@contract-hero';

export interface NextChapterResult {
  ok: boolean;
  errors?: string[];
  /** True when every chapter has passed. Check `completed` to tell whether
   * the e2e gate still has to run. */
  done?: boolean;
  /** True once final_verification passed. */
  completed?: boolean;
  /** Total chapters in the lesson. */
  total?: number;
  /** Zero-based index of the chapter returned (equals state.chapter_cursor). */
  index?: number;
  chapter?: {
    id: string;
    title: string;
    /** Chapter brief (markdown) with personalization placeholders rendered. */
    brief: string;
    key_idea: string;
    expected_files: string[];
    tests: string[];
    /** Resolved: `cwd` is always present, relative to `workspace_path`. */
    verification: Required<VerificationSpec>;
  };
  /** Absolute path to the lesson's docs snapshot, when the lesson declares one. */
  docs_dir?: string;
  workspace_path?: string;
  /** Absolute path to ACC's artifact conventions file. */
  artifact_conventions_path?: string;
  /** Chapter envelope only: where the conductor must write this chapter's artifact. */
  artifact_path?: string;
  /** Chapter envelope only: relative filenames for the artifact's footer links. */
  artifact_nav?: ArtifactNav;
  /** Done envelope only: where the conductor must write the summary artifact. */
  summary_artifact_path?: string;
  /** Done envelope only: chapter id → recorded artifact path (plus `summary` once recorded). */
  artifacts?: Record<string, string>;
  /** Done envelope only: true when the publish-html plugin is enabled. */
  publish_available?: boolean;
  /** Done envelope only, while `completed` is false: the e2e gate verifyChapter runs next. */
  final_verification?: Required<VerificationSpec>;
}

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

  const common: Partial<NextChapterResult> = {
    total: chapters.chapters.length,
    index: state.chapter_cursor,
    artifact_conventions_path: CONVENTIONS_PATH,
  };
  if (state.workspace_path !== undefined) common.workspace_path = state.workspace_path;
  if (lesson.docs !== undefined) common.docs_dir = path.join(info.lesson_dir, lesson.docs);

  const progress = lessonPhase(state, chapters);
  if (progress.phase !== 'chapter') {
    const result: NextChapterResult = {
      ok: true,
      done: true,
      completed: progress.phase === 'done',
      ...common,
      summary_artifact_path: summaryArtifactPath(projectRoot, state.workspace_path),
      artifacts: state.artifacts,
      publish_available: isClaudePluginEnabled(PUBLISH_PLUGIN_KEY),
    };
    if (progress.phase === 'e2e') {
      result.final_verification = resolveVerification(lesson, chapters.final_verification);
    }
    return result;
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
    ok: true,
    done: false,
    completed: false,
    ...common,
    chapter: {
      id: chapter.id,
      title: chapter.title,
      brief,
      key_idea: chapter.key_idea,
      expected_files: chapter.expected_files,
      tests: chapter.tests,
      verification: resolveVerification(lesson, chapter.verification),
    },
    artifact_path: chapterArtifactPath(projectRoot, state.workspace_path, index, chapter.id),
    artifact_nav: artifactNav(chapters.chapters, index),
  };
}
