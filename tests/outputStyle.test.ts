import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Spy-mode mocks: ESM namespace bindings are non-writable, so vi.spyOn() on
// `node:fs` / `node:fs/promises` fails with "Cannot redefine property". The
// `{ spy: true }` mode wraps the real module so spies work while behavior
// passes through unchanged.
vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Module under test — does not exist yet at red phase. The import will fail
// and cause vitest to mark the suite as failed (meaningful red).
import { probeOutputStyle } from '../mcp/server/src/outputStyle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ENABLED_PLUGIN_KEY = 'learning-output-style@claude-plugins-official';

let originalHome: string | undefined;
let tempHome: string;

function writeSettings(content: string): void {
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), content, 'utf8');
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sui-course-home-'));
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;
  // Node's POSIX os.homedir() consults process.env.HOME first, so setting
  // HOME is sufficient. (Spy on os.homedir would fail because node:os is an
  // immutable ESM namespace; vi.mock with { spy: true } would also work but
  // the env-var path is simpler and matches how the implementation should
  // resolve the user home anyway.)
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

describe('outputStyle probe', () => {
  it('T-013: returns ok=true when settings.json has the plugin enabled', async () => {
    writeSettings(
      JSON.stringify({
        enabledPlugins: { [ENABLED_PLUGIN_KEY]: true },
      }),
    );

    const result = await probeOutputStyle();

    expect(result.ok).toBe(true);
    expect(result.warning).toBeFalsy();
  });

  it('T-014: returns ok=false with output-style-plugin-not-enabled warning when plugin entry is false (cycle 6 H002)', async () => {
    // Cycle 6 H002 / AC-1.1: previously this branch returned a bare {ok:false}
    // with no warning, hiding the activation step from the student. The remediation
    // attaches an `output-style-plugin-not-enabled` warning naming the plugin and
    // the `claude plugins enable …` command.
    writeSettings(
      JSON.stringify({
        enabledPlugins: { [ENABLED_PLUGIN_KEY]: false },
      }),
    );

    const result = await probeOutputStyle();

    expect(result.ok).toBe(false);
    expect(result.warning).toBeDefined();
    expect(result.warning?.kind).toBe('output-style-plugin-not-enabled');
    expect(result.warning?.message).toContain(ENABLED_PLUGIN_KEY);
    expect(result.warning?.message).toContain('claude plugins enable');
  });

  it('T-015: returns ok=false with structured warning when settings.json is missing', async () => {
    // No settings file written.
    const result = await probeOutputStyle();

    expect(result.ok).toBe(false);
    expect(result.warning).toBeTruthy();
    expect(typeof result.warning?.kind).toBe('string');
    expect(result.warning?.kind).toMatch(/missing/i);
    expect(typeof result.warning?.message).toBe('string');
    expect(result.warning?.message.length).toBeGreaterThan(0);
  });

  it('T-016: returns ok=false with structured warning when settings.json is malformed JSON', async () => {
    writeSettings('{ not json');

    const result = await probeOutputStyle();

    expect(result.ok).toBe(false);
    expect(result.warning).toBeTruthy();
    expect(typeof result.warning?.kind).toBe('string');
    expect(result.warning?.kind).toMatch(/malformed|parse|invalid/i);
    expect(typeof result.warning?.message).toBe('string');
    expect(result.warning?.message.length).toBeGreaterThan(0);
  });

  it('T-017: returns ok=false (silent) when enabledPlugins key is absent', async () => {
    writeSettings(JSON.stringify({ someUnrelatedSetting: true }));

    const result = await probeOutputStyle();

    expect(result.ok).toBe(false);
    // Silent disable path — must not throw, warning is optional but typically absent.
  });

  describe('source-level security guards', () => {
    const sourcePath = path.resolve(__dirname, '../mcp/server/src/outputStyle.ts');

    it('T-029: outputStyle.ts source contains no CLAUDE_OUTPUT_STYLE or process.env.CLAUDE references', () => {
      const content = fs.readFileSync(sourcePath, 'utf8');

      expect(content.indexOf('CLAUDE_OUTPUT_STYLE')).toBe(-1);
      expect(content.indexOf('process.env.CLAUDE')).toBe(-1);
    });

    it('T-030: outputStyle.ts source contains no parent-process or system-prompt scraping', () => {
      const content = fs.readFileSync(sourcePath, 'utf8');

      expect(content.indexOf('process.ppid')).toBe(-1);
      expect(content.indexOf('parent_process')).toBe(-1);
      expect(content.indexOf('/proc/')).toBe(-1);
      expect(content.indexOf('systemPrompt')).toBe(-1);
      expect(content.indexOf('system_prompt')).toBe(-1);
      expect(content.indexOf('getppid')).toBe(-1);
    });

    it('T-031: outputStyle probe only reads from <home>/.claude/settings.json', async () => {
      writeSettings(
        JSON.stringify({
          enabledPlugins: { [ENABLED_PLUGIN_KEY]: true },
        }),
      );

      const expectedPath = path.join(tempHome, '.claude', 'settings.json');
      const observedPaths: string[] = [];

      const recordPath = (p: unknown): void => {
        if (typeof p === 'string') observedPaths.push(p);
        else if (p instanceof URL) observedPaths.push(p.pathname);
        else if (Buffer.isBuffer(p)) observedPaths.push(p.toString('utf8'));
      };

      const realReadFileSync = fs.readFileSync;
      const realReadFile = fs.readFile;
      const realPromisesReadFile = fsPromises.readFile;

      const syncSpy = vi
        .spyOn(fs, 'readFileSync')
        .mockImplementation(((file: any, opts?: any) => {
          recordPath(file);
          return realReadFileSync(file, opts);
        }) as any);
      const cbSpy = vi
        .spyOn(fs, 'readFile')
        .mockImplementation(((file: any, ...rest: any[]) => {
          recordPath(file);
          return (realReadFile as any)(file, ...rest);
        }) as any);
      const promiseSpy = vi
        .spyOn(fsPromises, 'readFile')
        .mockImplementation(((file: any, opts?: any) => {
          recordPath(file);
          return realPromisesReadFile(file, opts);
        }) as any);

      try {
        await probeOutputStyle();
      } finally {
        syncSpy.mockRestore();
        cbSpy.mockRestore();
        promiseSpy.mockRestore();
      }

      expect(observedPaths.length).toBeGreaterThan(0);
      for (const observed of observedPaths) {
        const resolved = path.resolve(observed);
        expect(resolved).toBe(path.resolve(expectedPath));
      }
    });
  });
});
