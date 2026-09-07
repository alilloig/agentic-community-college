// End-to-end harness for the v0.3 chapter loop, driven through the tool
// entry points (not the MCP transport): selectLesson → nextChapter →
// verifyChapter … → final e2e gate → completed. A temp HOME isolates
// ~/.acc and ~/.claude; ACC_INSTALLED_PLUGINS_FILE points discovery at a
// temp course plugin; verification spawns are stubbed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runSelectLesson } from '../mcp/server/src/tools/selectLesson.js';
import { runNextChapter } from '../mcp/server/src/tools/nextChapter.js';
import { runVerifyChapter } from '../mcp/server/src/tools/verifyChapter.js';
import { runStart } from '../mcp/server/src/tools/start.js';
import { runSetPersonalization } from '../mcp/server/src/tools/setPersonalization.js';
import { loadState } from '../mcp/server/src/state.js';
import type { VerifySpawnFn } from '../mcp/server/src/verify.js';

const COURSE_KEY = 'demo-course@local';
const LESSON_SLUG = '01-demo';
const NAMESPACED = `${COURSE_KEY}/${LESSON_SLUG}`;

let tempRoot: string;
let tempHome: string;
let projectRoot: string;
let originalHome: string | undefined;
let originalRegistry: string | undefined;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function writeText(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, 'utf8');
}

function seedCourse(): string {
  const pluginDir = path.join(tempRoot, 'plugins', 'demo-course');
  writeJson(path.join(pluginDir, '.claude-plugin', 'plugin.json'), {
    name: 'demo-course',
    version: '0.0.1',
    accContent: { lessons: './lessons/' },
  });
  const lessonDir = path.join(pluginDir, 'lessons', LESSON_SLUG);
  writeJson(path.join(lessonDir, 'lesson.json'), {
    slug: LESSON_SLUG,
    title: 'Demo lesson',
    summary: 'Two chapters and an e2e gate.',
    personalization_options: ['greeting'],
    personalization_ranges: { greeting: { values: ['hello', 'hola'], default: 'hello' } },
    docs: 'docs/',
    workspace: {
      host: 'reference-app',
      verification_cwd: '.',
      solution_files: ['src/answer.ts', 'src/extra'],
      files: [],
    },
  });
  writeJson(path.join(lessonDir, 'chapters.json'), {
    schema_version: 2,
    chapters: [
      {
        id: 'c01-answer',
        title: 'Return the answer',
        brief_md: 'chapters/01-answer.md',
        key_idea: 'A function that returns 42.',
        expected_files: ['src/answer.ts'],
        tests: ['tests/answer.test.ts'],
        verification: { mode: 'test-suite', command: 'fake-test tests/answer.test.ts' },
      },
      {
        id: 'c02-extra',
        title: 'Add the extra module',
        brief_md: 'chapters/02-extra.md',
        key_idea: 'Modules compose.',
        expected_files: ['src/extra/index.ts'],
        tests: ['tests/extra.test.ts'],
        verification: { mode: 'test-suite', command: 'fake-test tests/extra.test.ts' },
      },
    ],
    final_verification: { mode: 'test-suite', command: 'fake-test' },
  });
  writeText(path.join(lessonDir, 'chapters', '01-answer.md'), '# Chapter 1\n\nSay {{ greeting }} and return 42.\n');
  writeText(path.join(lessonDir, 'chapters', '02-extra.md'), '# Chapter 2\n\nAdd src/extra/index.ts.\n');
  writeText(path.join(lessonDir, 'docs', 'INDEX.md'), '# Docs\n');
  writeText(path.join(lessonDir, 'description.md'), 'What you will build.\n');
  // reference-app: scaffold + tests + solution
  writeJson(path.join(lessonDir, 'reference-app', 'package.json'), { name: 'demo', type: 'module' });
  writeText(path.join(lessonDir, 'reference-app', 'src', 'scaffold.ts'), 'export const scaffold = true;\n');
  writeText(path.join(lessonDir, 'reference-app', 'src', 'answer.ts'), 'export const answer = 42;\n');
  writeText(path.join(lessonDir, 'reference-app', 'src', 'extra', 'index.ts'), 'export const extra = 1;\n');
  writeText(path.join(lessonDir, 'reference-app', 'tests', 'answer.test.ts'), '// test\n');
  writeText(path.join(lessonDir, 'reference-app', 'tests', 'extra.test.ts'), '// test\n');

  const registryFile = path.join(tempRoot, 'installed_plugins.json');
  writeJson(registryFile, {
    version: 2,
    plugins: { [COURSE_KEY]: [{ scope: 'user', installPath: pluginDir, version: '0.0.1' }] },
  });
  return registryFile;
}

function stubSpawn(status: number, out = ''): VerifySpawnFn {
  return () => ({ status, stdout: out, stderr: '' });
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-loop-'));
  tempHome = path.join(tempRoot, 'home');
  fs.mkdirSync(tempHome, { recursive: true });
  projectRoot = path.join(tempRoot, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  originalHome = process.env.HOME;
  originalRegistry = process.env.ACC_INSTALLED_PLUGINS_FILE;
  process.env.HOME = tempHome;
  process.env.ACC_INSTALLED_PLUGINS_FILE = seedCourse();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalRegistry === undefined) delete process.env.ACC_INSTALLED_PLUGINS_FILE;
  else process.env.ACC_INSTALLED_PLUGINS_FILE = originalRegistry;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('chapter loop (v0.3)', () => {
  it('start reports the catalog with chapter_count and the advisory output style', async () => {
    const s = await runStart({ projectRoot });
    expect(s.courses).toEqual([COURSE_KEY]);
    expect(s.lessons).toHaveLength(1);
    expect(s.lessons[0].namespaced_slug).toBe(NAMESPACED);
    expect(s.lessons[0].chapter_count).toBe(2);
    expect(s.outputStyle.recommended).toBe('Concise');
    expect(s.outputStyle.ok).toBe(false);
    expect(s.state).toBeNull();
  });

  it('selectLesson seeds the workspace without the solution files', async () => {
    const r = await runSelectLesson({ projectRoot, slug: NAMESPACED, homeDir: tempHome });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    expect(r.workspaceCreated).toBe(true);
    expect(r.workspaceStrippedFiles).toEqual(['src/answer.ts', 'src/extra']);
    expect(r.description).toContain('What you will build');
    const ws = r.workspacePath!;
    expect(ws).toBe(path.join(tempHome, '.acc', 'workspaces', LESSON_SLUG));
    expect(fs.existsSync(path.join(ws, 'src', 'scaffold.ts'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'tests', 'answer.test.ts'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'src', 'answer.ts'))).toBe(false);
    expect(fs.existsSync(path.join(ws, 'src', 'extra'))).toBe(false);

    const state = await loadState(projectRoot);
    expect(state.kind).toBe('ok');
    if (state.kind === 'ok') {
      expect(state.state.schema_version).toBe(5);
      expect(state.state.chapter_cursor).toBe(0);
      expect(state.state.artifacts).toEqual({});
    }
  });

  it('walks both chapters, the e2e gate, and records artifacts', async () => {
    const sel = await runSelectLesson({ projectRoot, slug: NAMESPACED, homeDir: tempHome });
    expect(sel.ok).toBe(true);
    const ws = sel.workspacePath!;
    await runSetPersonalization({ projectRoot, values: { greeting: 'hola' } });

    // Chapter 1 envelope
    const c1 = await runNextChapter({ projectRoot });
    expect(c1.ok).toBe(true);
    expect(c1.done).toBe(false);
    expect(c1.index).toBe(0);
    expect(c1.total).toBe(2);
    expect(c1.chapter?.id).toBe('c01-answer');
    expect(c1.chapter?.brief).toContain('Say hola and return 42');
    expect(c1.chapter?.tests).toEqual(['tests/answer.test.ts']);
    expect(c1.chapter?.verification).toEqual({
      mode: 'test-suite',
      command: 'fake-test tests/answer.test.ts',
      cwd: '.',
    });
    expect(c1.workspace_path).toBe(ws);
    expect(c1.docs_dir).toMatch(/lessons\/01-demo\/docs\/?$/);
    expect(c1.artifact_path).toBe(path.join(ws, 'artifacts', '01-c01-answer.html'));
    expect(c1.artifact_nav).toEqual({ next: '02-c02-extra.html' });
    expect(c1.summary_artifact_path).toBeUndefined();
    expect(c1.artifacts).toBeUndefined();
    expect(c1.artifact_conventions_path).toMatch(/skills\/chapter-artifact\/references\/conventions\.md$/);
    expect(c1.final_verification).toBeUndefined();

    // Gate fails → cursor stays
    const fail = await runVerifyChapter({ projectRoot, spawn: stubSpawn(1, 'boom') });
    expect(fail.ok).toBe(true);
    expect(fail.pass).toBe(false);
    expect(fail.advanced).toBe(false);
    expect(fail.chapter_cursor).toBe(0);
    expect(fail.output).toContain('boom');

    // Artifact written, gate passes → cursor advances, artifact recorded
    fs.mkdirSync(path.dirname(c1.artifact_path!), { recursive: true });
    fs.writeFileSync(c1.artifact_path!, '<!doctype html><title>c1</title>');
    const pass1 = await runVerifyChapter({ projectRoot, spawn: stubSpawn(0, 'ok') });
    expect(pass1.pass).toBe(true);
    expect(pass1.advanced).toBe(true);
    expect(pass1.final).toBe(false);
    expect(pass1.artifact_recorded).toBe(true);
    expect(pass1.chapter_cursor).toBe(1);
    expect(pass1.warnings).toBeUndefined();

    // Chapter 2 passes without an artifact → warning, still advances
    const c2 = await runNextChapter({ projectRoot });
    expect(c2.chapter?.id).toBe('c02-extra');
    expect(c2.index).toBe(1);
    expect(c2.artifact_nav).toEqual({ prev: '01-c01-answer.html', next: 'summary.html' });
    const pass2 = await runVerifyChapter({ projectRoot, spawn: stubSpawn(0) });
    expect(pass2.pass).toBe(true);
    expect(pass2.chapter_cursor).toBe(2);
    expect(pass2.artifact_recorded).toBe(false);
    expect(pass2.warnings?.[0].kind).toBe('artifact-missing');

    // All chapters done, e2e pending
    const pending = await runNextChapter({ projectRoot });
    expect(pending.done).toBe(true);
    expect(pending.completed).toBe(false);
    expect(pending.chapter).toBeUndefined();
    expect(pending.artifact_path).toBeUndefined();
    expect(pending.final_verification).toEqual({ mode: 'test-suite', command: 'fake-test', cwd: '.' });
    expect(pending.summary_artifact_path).toBe(path.join(ws, 'artifacts', 'summary.html'));
    expect(pending.artifacts).toEqual({ 'c01-answer': c1.artifact_path });
    expect(pending.publish_available).toBe(false);

    // e2e fails → not completed
    const e2eFail = await runVerifyChapter({ projectRoot, spawn: stubSpawn(1, 'e2e broke') });
    expect(e2eFail.final).toBe(true);
    expect(e2eFail.pass).toBe(false);
    expect(e2eFail.done).toBe(false);
    expect((await runNextChapter({ projectRoot })).completed).toBe(false);

    // e2e passes → completed. The summary is written after the gate, so it is
    // not recorded yet.
    const e2ePass = await runVerifyChapter({ projectRoot, spawn: stubSpawn(0, '3 passed') });
    expect(e2ePass.final).toBe(true);
    expect(e2ePass.pass).toBe(true);
    expect(e2ePass.done).toBe(true);
    expect(e2ePass.artifact_recorded).toBe(false);
    expect(e2ePass.warnings).toBeUndefined();
    expect(e2ePass.chapter_cursor).toBe(2);

    const after = await runNextChapter({ projectRoot });
    expect(after.done).toBe(true);
    expect(after.completed).toBe(true);
    expect(after.final_verification).toBeUndefined();
    expect(after.artifacts).toEqual({ 'c01-answer': c1.artifact_path });

    // Re-entrant verify after completion never re-runs anything. Without a
    // summary file it reports artifact_recorded: false; once the conductor
    // writes summary.html, the next call records it.
    const noSpawn = () => {
      throw new Error('must not spawn');
    };
    const beforeSummary = await runVerifyChapter({ projectRoot, spawn: noSpawn });
    expect(beforeSummary.ok).toBe(true);
    expect(beforeSummary.done).toBe(true);
    expect(beforeSummary.artifact_recorded).toBe(false);
    expect(beforeSummary.output).toMatch(/already complete/);

    fs.writeFileSync(pending.summary_artifact_path!, '<!doctype html><title>summary</title>');
    const again = await runVerifyChapter({ projectRoot, spawn: noSpawn });
    expect(again.ok).toBe(true);
    expect(again.done).toBe(true);
    expect(again.artifact_recorded).toBe(true);
    expect(again.output).toMatch(/already complete/);

    const state = await loadState(projectRoot);
    expect(state.kind).toBe('ok');
    if (state.kind === 'ok') {
      expect(state.state.completed_at).toBeDefined();
      expect(state.state.artifacts).toEqual({
        'c01-answer': c1.artifact_path,
        summary: pending.summary_artifact_path,
      });
      expect(state.state.test_status?.final).toBe(true);
      expect(state.state.history.some((h) => h.event === 'verifyChapter:c01-answer:pass')).toBe(true);
      expect(state.state.history.some((h) => h.event === 'verifyChapter:final:fail')).toBe(true);
      expect(state.state.history.some((h) => h.event === 'verifyChapter:summary:recorded')).toBe(true);
    }
  });

  it('nextChapter and verifyChapter refuse to run without a selected lesson', async () => {
    const n = await runNextChapter({ projectRoot });
    expect(n.ok).toBe(false);
    expect(n.errors?.[0]).toMatch(/No lesson selected/);
    const v = await runVerifyChapter({ projectRoot, spawn: stubSpawn(0) });
    expect(v.ok).toBe(false);
  });

  it('a v4 state file surfaces as a schema mismatch, never coerced', async () => {
    writeJson(path.join(projectRoot, '.acc', 'state.json'), {
      schema_version: 4,
      selected_lesson: NAMESPACED,
      selected_output_style: 'learning',
      personalization: {},
      section_cursor: 1,
      history: [],
    });
    const n = await runNextChapter({ projectRoot });
    expect(n.ok).toBe(false);
    expect(n.errors?.[0]).toMatch(/schema mismatch/i);
    const s = await runStart({ projectRoot });
    expect(s.warnings.some((w) => w.kind === 'state-schema-mismatch')).toBe(true);
  });
});
