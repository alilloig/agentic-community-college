// Seed-time guards around `workspace.solution_files`: the containment check
// that sits in front of `rm -rf`, the workspace-root refusal, missing
// entries, and the course-namespaced directory name.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareWorkspace, workspaceDirName, WorkspacePrepareError } from '../mcp/server/src/workspace.js';
import type { LessonData } from '../mcp/server/src/schemas/lesson.js';

let temps: string[] = [];

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
}

function seed(): { basePath: string; lessonDir: string } {
  const basePath = tmp('acc-strip-base-');
  const lessonDir = tmp('acc-strip-lesson-');
  const host = path.join(lessonDir, 'reference-app');
  fs.mkdirSync(path.join(host, 'src'), { recursive: true });
  fs.writeFileSync(path.join(host, 'package.json'), '{"name":"host"}');
  fs.writeFileSync(path.join(host, 'src', 'scaffold.ts'), 'export const scaffold = 1;');
  fs.writeFileSync(path.join(host, 'src', 'answer.ts'), 'export const answer = 42;');
  return { basePath, lessonDir };
}

function lesson(solutionFiles: string[], files: LessonData['workspace']['files'] = []): LessonData {
  return {
    slug: '01-demo',
    title: 'demo',
    summary: 's',
    personalization_options: [],
    workspace: { host: 'reference-app', solution_files: solutionFiles, files },
  };
}

afterEach(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
  temps = [];
});

describe('prepareWorkspace — solution_files containment', () => {
  it('strips a declared solution file and reports it', async () => {
    const { basePath, lessonDir } = seed();
    const r = await prepareWorkspace('demo__01-demo', lessonDir, lesson(['src/answer.ts']), { basePath });
    expect(r.created).toBe(true);
    expect(r.strippedFiles).toEqual(['src/answer.ts']);
    expect(fs.existsSync(path.join(r.workspacePath, 'src', 'answer.ts'))).toBe(false);
    expect(fs.existsSync(path.join(r.workspacePath, 'src', 'scaffold.ts'))).toBe(true);
  });

  it('refuses an entry that names the workspace root and leaves the seed intact', async () => {
    const { basePath, lessonDir } = seed();
    await expect(
      prepareWorkspace('demo__01-demo', lessonDir, lesson(['.']), { basePath }),
    ).rejects.toMatchObject({ kind: 'invalid-config' });
    expect(fs.existsSync(path.join(basePath, 'demo__01-demo', 'package.json'))).toBe(true);
  });

  it('refuses an entry that escapes the workspace and never touches the victim', async () => {
    const { basePath, lessonDir } = seed();
    const victim = path.join(basePath, 'victim.txt');
    fs.writeFileSync(victim, 'keep me');
    await expect(
      prepareWorkspace('demo__01-demo', lessonDir, lesson(['../victim.txt']), { basePath }),
    ).rejects.toBeInstanceOf(WorkspacePrepareError);
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep me');
  });

  it('refuses a starter target that escapes the workspace', async () => {
    const { basePath, lessonDir } = seed();
    fs.writeFileSync(path.join(lessonDir, 'starter.ts'), 'export {};');
    await expect(
      prepareWorkspace('demo__01-demo', lessonDir, lesson([], [{ starter: 'starter.ts', path: '../escaped.ts' }]), {
        basePath,
      }),
    ).rejects.toMatchObject({ kind: 'invalid-config' });
    expect(fs.existsSync(path.join(basePath, 'escaped.ts'))).toBe(false);
  });

  it('fails the seed when a solution_files entry does not exist in the host', async () => {
    const { basePath, lessonDir } = seed();
    await expect(
      prepareWorkspace('demo__01-demo', lessonDir, lesson(['src/answer.ts', 'src/renamed.ts']), { basePath }),
    ).rejects.toMatchObject({ kind: 'invalid-config', message: expect.stringMatching(/src\/renamed\.ts/) });
  });
});

describe('workspaceDirName', () => {
  it('carries the course plugin name without its marketplace suffix', () => {
    expect(workspaceDirName('acc-claude-sdk@local/01-basic-agent')).toBe('acc-claude-sdk__01-basic-agent');
    expect(workspaceDirName('acc-claude-sdk@contract-hero/01-basic-agent')).toBe('acc-claude-sdk__01-basic-agent');
    expect(workspaceDirName('plain-slug')).toBe('plain-slug');
  });
});
