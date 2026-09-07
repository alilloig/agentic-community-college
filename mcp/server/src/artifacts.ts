// artifacts.ts — where runtime-generated artifacts live and where the
// conventions file is.
//
// The conductor WRITES the HTML (the MCP never generates markup). These
// helpers only agree on paths so `nextChapter` can hand the conductor an
// absolute target and `verifyChapter` can record what exists.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARTIFACTS_DIRNAME = 'artifacts';
export const SUMMARY_ARTIFACT_KEY = 'summary';

/** Base directory for a lesson's artifacts: the workspace when the lesson has
 * one, otherwise `<projectRoot>/.acc`. */
export function artifactsBase(projectRoot: string, workspacePath?: string): string {
  return workspacePath ?? path.join(projectRoot, '.acc');
}

export function artifactsDir(projectRoot: string, workspacePath?: string): string {
  return path.join(artifactsBase(projectRoot, workspacePath), ARTIFACTS_DIRNAME);
}

export function chapterArtifactFilename(index: number, chapterId: string): string {
  return `${String(index + 1).padStart(2, '0')}-${chapterId}.html`;
}

export function chapterArtifactPath(
  projectRoot: string,
  workspacePath: string | undefined,
  index: number,
  chapterId: string,
): string {
  return path.join(artifactsDir(projectRoot, workspacePath), chapterArtifactFilename(index, chapterId));
}

export function summaryArtifactPath(projectRoot: string, workspacePath?: string): string {
  return path.join(artifactsDir(projectRoot, workspacePath), 'summary.html');
}

/**
 * Absolute path to `skills/chapter-artifact/references/conventions.md`.
 * Both `src/artifacts.ts` (tsx / vitest) and `dist/index.js` (esbuild bundle)
 * sit three levels below the repo root, so one relative hop works for both.
 */
export function conventionsPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'skills', 'chapter-artifact', 'references', 'conventions.md');
}

export function artifactExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
