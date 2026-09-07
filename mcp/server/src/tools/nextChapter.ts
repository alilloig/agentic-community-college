import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { substitutePromptOnly } from '../personalization.js';
import { runSetupGate } from './setupGate.js';
import {
  chapterArtifactPath,
  conventionsPath,
  summaryArtifactPath,
} from '../artifacts.js';
import type { VerificationSpec } from '../schemas/chapters.js';

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
    verification: VerificationSpec;
  };
  /** Absolute path to the lesson's docs snapshot, when the lesson declares one. */
  docs_dir?: string;
  workspace_path?: string;
  /** Where the conductor must write this chapter's artifact. */
  artifact_path?: string;
  /** Absolute path to ACC's artifact conventions file. */
  artifact_conventions_path?: string;
  /** Where the conductor must write the summary artifact after the e2e gate. */
  summary_artifact_path?: string;
  /** Present only when `done && !completed`: the e2e gate verifyChapter will run next. */
  final_verification?: VerificationSpec;
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

  const total = chapters.chapters.length;
  const cursor = state.chapter_cursor;

  const common: Partial<NextChapterResult> = {
    total,
    index: cursor,
    artifact_conventions_path: conventionsPath(),
    summary_artifact_path: summaryArtifactPath(projectRoot, state.workspace_path),
  };
  if (state.workspace_path !== undefined) common.workspace_path = state.workspace_path;
  if (lesson.docs !== undefined) common.docs_dir = path.join(info.lesson_dir, lesson.docs);

  if (cursor >= total) {
    if (state.completed_at !== undefined) {
      return { ok: true, done: true, completed: true, ...common };
    }
    return {
      ok: true,
      done: true,
      completed: false,
      final_verification: chapters.final_verification,
      ...common,
    };
  }

  const chapter = chapters.chapters[cursor];

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
      verification: chapter.verification,
    },
    artifact_path: chapterArtifactPath(projectRoot, state.workspace_path, cursor, chapter.id),
  };
}
