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
import type { ChapterData, ChaptersManifest } from './schemas/chapters.js';
import type { State } from './schemas/state.js';

export const SUMMARY_ARTIFACT_KEY = 'summary';
const SUMMARY_FILENAME = 'summary.html';

function artifactsDir(workspacePath: string): string {
  return path.join(workspacePath, 'artifacts');
}

function chapterFilename(index: number, chapterId: string): string {
  return `${String(index + 1).padStart(2, '0')}-${chapterId}.html`;
}

export function chapterArtifactPath(workspacePath: string, index: number, chapterId: string): string {
  return path.join(artifactsDir(workspacePath), chapterFilename(index, chapterId));
}

export function summaryArtifactPath(workspacePath: string): string {
  return path.join(artifactsDir(workspacePath), SUMMARY_FILENAME);
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

/** True iff a regular file exists at `p`. ENOENT/ENOTDIR mean absent; anything else re-throws. */
export async function artifactExists(p: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(p)).isFile();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw err;
  }
}

/**
 * Back-fill `state.artifacts` with every artifact that exists on disk but was
 * written after its gate: chapters below the cursor and, once the lesson is
 * complete, the summary. Returns the merged map and whether anything changed.
 */
export async function reconcileArtifacts(
  state: State,
  chapters: ChaptersManifest,
): Promise<{ artifacts: Record<string, string>; changed: boolean }> {
  const artifacts = { ...state.artifacts };
  let changed = false;
  const passed = Math.min(state.chapter_cursor, chapters.chapters.length);
  for (let i = 0; i < passed; i++) {
    const id = chapters.chapters[i].id;
    if (artifacts[id] !== undefined) continue;
    const p = chapterArtifactPath(state.workspace_path, i, id);
    if (await artifactExists(p)) {
      artifacts[id] = p;
      changed = true;
    }
  }
  if (state.completed_at !== undefined && artifacts[SUMMARY_ARTIFACT_KEY] === undefined) {
    const p = summaryArtifactPath(state.workspace_path);
    if (await artifactExists(p)) {
      artifacts[SUMMARY_ARTIFACT_KEY] = p;
      changed = true;
    }
  }
  return { artifacts, changed };
}
