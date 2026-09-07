// artifacts.ts — where runtime-generated artifacts live and where the
// conventions file is.
//
// The conductor WRITES the HTML (the MCP never generates markup). These
// helpers only agree on paths so `nextChapter` can hand the conductor an
// absolute target plus its neighbours' filenames, and `verifyChapter` can
// record what exists.

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChapterData } from './schemas/chapters.js';

export const SUMMARY_ARTIFACT_KEY = 'summary';
const SUMMARY_FILENAME = 'summary.html';

/** `<workspace>/artifacts`, or `<projectRoot>/.acc/artifacts` for lessons without a workspace. */
function artifactsDir(projectRoot: string, workspacePath?: string): string {
  return path.join(workspacePath ?? path.join(projectRoot, '.acc'), 'artifacts');
}

function chapterFilename(index: number, chapterId: string): string {
  return `${String(index + 1).padStart(2, '0')}-${chapterId}.html`;
}

export function chapterArtifactPath(
  projectRoot: string,
  workspacePath: string | undefined,
  index: number,
  chapterId: string,
): string {
  return path.join(artifactsDir(projectRoot, workspacePath), chapterFilename(index, chapterId));
}

export function summaryArtifactPath(projectRoot: string, workspacePath?: string): string {
  return path.join(artifactsDir(projectRoot, workspacePath), SUMMARY_FILENAME);
}

export interface ArtifactNav {
  /** Relative filename of the previous chapter's artifact. Absent on chapter 1. */
  prev?: string;
  /** Relative filename of the next artifact: the next chapter, or the summary. */
  next: string;
}

/** Footer-navigation filenames for the chapter at `index`, so the conductor never derives them. */
export function artifactNav(chapters: readonly ChapterData[], index: number): ArtifactNav {
  const next = index + 1 < chapters.length
    ? chapterFilename(index + 1, chapters[index + 1].id)
    : SUMMARY_FILENAME;
  return index > 0 ? { prev: chapterFilename(index - 1, chapters[index - 1].id), next } : { next };
}

/**
 * Absolute path to `skills/chapter-artifact/references/conventions.md`.
 * Both `src/artifacts.ts` (tsx / vitest) and `dist/index.js` (esbuild bundle)
 * sit three levels below the repo root, so one relative hop works for both.
 */
export const CONVENTIONS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'skills', 'chapter-artifact', 'references', 'conventions.md',
);

export async function artifactExists(p: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(p)).isFile();
  } catch {
    return false;
  }
}
