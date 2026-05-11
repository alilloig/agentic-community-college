// Cycle 6 — outputStyle warning shape on the missing/disabled-plugin paths (AC-1.1)
// T-306..T-308: probeOutputStyle's two refusal branches (enabledPlugins missing/non-object,
// plugin key absent / not === true) MUST emit a structured warning naming the plugin and
// the activation step. start propagates that warning into response.warnings without
// creating any state file.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeOutputStyle } from '../mcp/server/src/outputStyle.js';
import { runStart } from '../mcp/server/src/tools/start.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const PLUGIN_KEY = 'learning-output-style@claude-plugins-official';
const ACTIVATION_HINT = 'claude plugins enable learning-output-style@claude-plugins-official';

let originalHome: string | undefined;
let tempHome: string;
let tempRoots: string[] = [];

function makeTempRoot(prefix = 'sui-course-c6-os-'): string {
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

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sui-course-c6-os-home-'));
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

describe('AC-1.1: outputStyle missing/non-object enabledPlugins (T-306)', () => {
  it('T-306: returns plugin-not-enabled warning when enabledPlugins is missing or non-object', async () => {
    // Branch A: enabledPlugins key absent.
    writeSettings(JSON.stringify({ someOtherSetting: true }));
    const a = await probeOutputStyle();
    expect(a.ok).toBe(false);
    expect(a.warning).toBeDefined();
    expect(a.warning!.kind).toBe('output-style-plugin-not-enabled');
    expect(typeof a.warning!.message).toBe('string');
    expect(a.warning!.message.indexOf(PLUGIN_KEY)).toBeGreaterThan(-1);
    expect(a.warning!.message.indexOf(ACTIVATION_HINT)).toBeGreaterThan(-1);

    // Branch B: enabledPlugins is a non-object value (string).
    writeSettings(JSON.stringify({ enabledPlugins: 'not-an-object' }));
    const b = await probeOutputStyle();
    expect(b.ok).toBe(false);
    expect(b.warning).toBeDefined();
    expect(b.warning!.kind).toBe('output-style-plugin-not-enabled');
    expect(b.warning!.message.indexOf(PLUGIN_KEY)).toBeGreaterThan(-1);
    expect(b.warning!.message.indexOf(ACTIVATION_HINT)).toBeGreaterThan(-1);
  });
});

describe('AC-1.1: outputStyle plugin key absent or non-true (T-307)', () => {
  it('T-307: returns plugin-not-enabled warning when plugin key is absent or non-true', async () => {
    // Variant A: enabledPlugins is a valid object but missing the plugin key.
    writeSettings(JSON.stringify({ enabledPlugins: {} }));
    const a = await probeOutputStyle();
    expect(a.ok).toBe(false);
    expect(a.warning).toBeDefined();
    expect(a.warning!.kind).toBe('output-style-plugin-not-enabled');
    expect(a.warning!.message.indexOf(PLUGIN_KEY)).toBeGreaterThan(-1);
    expect(a.warning!.message.indexOf(ACTIVATION_HINT)).toBeGreaterThan(-1);

    // Variant B: plugin key explicitly false.
    writeSettings(
      JSON.stringify({
        enabledPlugins: { [PLUGIN_KEY]: false },
      }),
    );
    const b = await probeOutputStyle();
    expect(b.ok).toBe(false);
    expect(b.warning).toBeDefined();
    expect(b.warning!.kind).toBe('output-style-plugin-not-enabled');
    expect(b.warning!.message.indexOf(PLUGIN_KEY)).toBeGreaterThan(-1);
    expect(b.warning!.message.indexOf(ACTIVATION_HINT)).toBeGreaterThan(-1);

    // Variant C: plugin key truthy but not strict-equal to true.
    writeSettings(
      JSON.stringify({
        enabledPlugins: { [PLUGIN_KEY]: 'truthy-but-not-true' },
      }),
    );
    const c = await probeOutputStyle();
    expect(c.ok).toBe(false);
    expect(c.warning).toBeDefined();
    expect(c.warning!.kind).toBe('output-style-plugin-not-enabled');
    expect(c.warning!.message.indexOf(PLUGIN_KEY)).toBeGreaterThan(-1);
    expect(c.warning!.message.indexOf(ACTIVATION_HINT)).toBeGreaterThan(-1);
  });
});

describe('AC-1.1: start propagates warning + AC-1.3 zero state writes (T-308)', () => {
  it('T-308: start propagates output-style-plugin-not-enabled warning and writes no state.json', async () => {
    const projectRoot = makeTempRoot();
    copyOrderbookPathInto(projectRoot);

    // Disabled plugin → outputStyleOk:false.
    writeSettings(
      JSON.stringify({
        enabledPlugins: { [PLUGIN_KEY]: false },
      }),
    );

    const result = await runStart({ projectRoot });

    expect(result.outputStyleOk).toBe(false);
    expect(Array.isArray(result.warnings)).toBe(true);
    const matching = result.warnings.find(
      (w: { kind?: string; message?: string }) =>
        w.kind === 'output-style-plugin-not-enabled',
    );
    expect(matching, JSON.stringify(result.warnings)).toBeDefined();
    expect(typeof (matching as { message?: string }).message).toBe('string');
    expect(
      (matching as { message: string }).message.indexOf(PLUGIN_KEY),
    ).toBeGreaterThan(-1);

    // AC-1.3: refusal path leaves no state file.
    const stateFile = path.join(projectRoot, '.sui-deepbook-course', 'state.json');
    expect(fs.existsSync(stateFile)).toBe(false);
  });
});
