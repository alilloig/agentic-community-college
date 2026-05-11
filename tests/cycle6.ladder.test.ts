// Cycle 6 — full ladder reachability post-rename (AC-4.2)
// T-315: after rung-3 advance at p1-bootstrap/p1-spot-1, nextSpot returns
// {phase_id:'p2-retry', spot_id:'p2-spot-1', done:false}, and rungs/p2-spot-1/hint.md
// is loadable via requestHint at the new cursor.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });
vi.mock('node:child_process', { spy: true });

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootHarness } from '../scripts/e2e/harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const PLUGIN_KEY = 'learning-output-style@claude-plugins-official';

let originalHome: string | undefined;
let tempHome: string;
let tempRoots: string[] = [];

function makeTempRoot(prefix = 'sui-course-c6-ladder-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writeSettings(content: string): void {
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), content, 'utf8');
}

function copyOrderbookPathInto(projectRoot: string): void {
  const src = path.join(REPO_ROOT, 'paths', '01-orderbook-viewer');
  const dst = path.join(projectRoot, 'paths', '01-orderbook-viewer');
  function copyDir(s: string, d: string): void {
    fs.mkdirSync(d, { recursive: true });
    for (const entry of fs.readdirSync(s, { withFileTypes: true })) {
      const sp = path.join(s, entry.name);
      const dp = path.join(d, entry.name);
      if (entry.isDirectory()) copyDir(sp, dp);
      else if (entry.isFile()) fs.copyFileSync(sp, dp);
    }
  }
  copyDir(src, dst);
}

function parseTextResult(result: unknown): any {
  expect(result).toBeTruthy();
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  expect(Array.isArray(r.content)).toBe(true);
  expect(r.content!.length).toBeGreaterThan(0);
  expect(r.content![0].type).toBe('text');
  expect(typeof r.content![0].text).toBe('string');
  return JSON.parse(r.content![0].text!);
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sui-course-c6-ladder-home-'));
  tempRoots.push(tempHome);
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  for (const dir of tempRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  }
  tempRoots = [];
});

describe('AC-4.2: full ladder reachability post-rename (T-315)', () => {
  it('T-315: after rung-3 advance at p1-spot-1, nextSpot returns cursor at p2-retry/p2-spot-1', async () => {
    const projectRoot = makeTempRoot();
    copyOrderbookPathInto(projectRoot);
    writeSettings(
      JSON.stringify({
        enabledPlugins: {
          'sui-pilot@local': true,
          [PLUGIN_KEY]: true,
        },
      }),
    );

    // Seed src/App.tsx so rung-3 has a file to read+overwrite. The reference
    // snippet maps to lines 39-58 (p1-spot-1) so the file must have at least
    // 58 lines.
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    const lines: string[] = [];
    for (let i = 1; i <= 200; i++) lines.push(`SRC${i}`);
    fs.writeFileSync(
      path.join(projectRoot, 'src', 'App.tsx'),
      lines.join('\n'),
      'utf8',
    );

    const harness: any = await bootHarness({ projectRoot });
    try {
      // start
      const startResult = parseTextResult(
        await harness.callTool('start', { projectRoot }),
      );
      expect(startResult.outputStyleOk).toBe(true);

      // selectPath
      const selectResult = parseTextResult(
        await harness.callTool('selectPath', {
          projectRoot,
          slug: '01-orderbook-viewer',
        }),
      );
      expect(selectResult.ok).toBe(true);

      // setPersonalization (use defaults)
      await harness.callTool('setPersonalization', {
        projectRoot,
        values: { poll_interval_ms: 3000, pool_subset: 'both' },
      });

      // nextSpot — at p1-bootstrap/p1-spot-1.
      const nextAtP1 = parseTextResult(
        await harness.callTool('nextSpot', { projectRoot }),
      );
      expect(nextAtP1.phase.id).toBe('p1-bootstrap');
      expect(nextAtP1.spot.id).toBe('p1-spot-1');
      expect(nextAtP1.done).toBe(false);

      // Rung 1 (hint) — verify must be set to fail before each requestHint.
      await harness.withVerifyStub({ pass: false, output: 'X' });
      const r1 = parseTextResult(
        await harness.callTool('requestHint', { projectRoot, rung: 1 }),
      );
      expect(r1.ok).toBe(true);
      expect(typeof r1.payload).toBe('string');

      // Rung 2 (reference)
      const r2 = parseTextResult(
        await harness.callTool('requestHint', { projectRoot, rung: 2 }),
      );
      expect(r2.ok).toBe(true);

      // Rung 3 (auto-write) — make verify pass for the rung-3 dispatch so
      // the cursor advances.
      await harness.withVerifyStub({ pass: true, output: 'built' });
      const r3 = parseTextResult(
        await harness.callTool('requestHint', { projectRoot, rung: 3 }),
      );
      expect(r3.ok).toBe(true);
      expect(r3.autoVerifyResult).toBeTruthy();
      expect(r3.autoVerifyResult.pass).toBe(true);
      expect(r3.autoVerifyResult.advanced).toBe(true);

      // After rung-3 advance, nextSpot must return the p2-retry cursor.
      const nextAfter = parseTextResult(
        await harness.callTool('nextSpot', { projectRoot }),
      );
      expect(nextAfter.done, JSON.stringify(nextAfter)).toBe(false);
      expect(nextAfter.phase.id, JSON.stringify(nextAfter)).toBe('p2-retry');
      expect(nextAfter.spot.id, JSON.stringify(nextAfter)).toBe('p2-spot-1');

      // requestHint at the new cursor must surface a non-empty payload —
      // proves rungs/p2-spot-1/hint.md is loadable.
      const r1AtP2 = parseTextResult(
        await harness.callTool('requestHint', { projectRoot, rung: 1 }),
      );
      expect(r1AtP2.ok).toBe(true);
      expect(typeof r1AtP2.payload).toBe('string');
      expect(r1AtP2.payload.length).toBeGreaterThan(0);
    } finally {
      await harness.shutdown();
    }
  }, 30000);
});
