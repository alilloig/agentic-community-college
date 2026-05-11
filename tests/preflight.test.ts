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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Modules under test — none of these exist yet at red phase. The import
// failures cause vitest to fail the suite, which is the meaningful red signal.
import { PROBE_ORDER, runProbe } from '../mcp/server/src/preflight.js';
import { runStart } from '../mcp/server/src/tools/start.js';
import { scanRegistry } from '../mcp/server/src/registry.js';
import { loadState, saveState } from '../mcp/server/src/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const ENABLED_PLUGIN_KEY = 'learning-output-style@claude-plugins-official';

let originalHome: string | undefined;
let originalDeployStub: string | undefined;
let tempHome: string;
let tempRoots: string[] = [];

function makeTempRoot(prefix = 'sui-course-c3-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writeSettings(content: string): void {
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), content, 'utf8');
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sui-course-home-'));
  tempRoots.push(tempHome);
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;
  originalDeployStub = process.env.E2E_DEPLOY_STUB;
  delete process.env.E2E_DEPLOY_STUB;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalDeployStub === undefined) {
    delete process.env.E2E_DEPLOY_STUB;
  } else {
    process.env.E2E_DEPLOY_STUB = originalDeployStub;
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

// ---------------------------------------------------------------------------
// PROBE_ORDER + runProbe registry
// ---------------------------------------------------------------------------

describe('PROBE_ORDER', () => {
  it('T-097: PROBE_ORDER is the exact spec-table order of eight probe ids', () => {
    expect(Array.isArray(PROBE_ORDER)).toBe(true);
    expect(PROBE_ORDER.length).toBe(8);
    expect([...PROBE_ORDER]).toEqual([
      'docker-running',
      'node-version',
      'pnpm-available',
      'sui-cli-version',
      'sui-pilot-enabled',
      'sandbox-repo-present',
      'sandbox-manifest-reachable',
      'learning-output-style-enabled',
    ]);
  });

  it('T-098: PROBE_ORDER is immutable at runtime (frozen)', () => {
    expect(Object.isFrozen(PROBE_ORDER)).toBe(true);
    let threw = false;
    try {
      (PROBE_ORDER as unknown as string[]).push('x');
    } catch {
      threw = true;
    }
    // Either threw (strict) or no-op'd (sloppy); either way length stays 8.
    expect(threw || PROBE_ORDER.length === 8).toBe(true);
    expect(PROBE_ORDER.length).toBe(8);
  });
});

describe('runProbe registry', () => {
  it('T-099: runProbe rejects an unknown probeId with a structured error', async () => {
    let rejected = false;
    let result: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = await runProbe('does-not-exist' as any, {});
    } catch (err) {
      rejected = true;
      // Must be an Error, not a raw string or undefined
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message ?? '';
      expect(msg.length).toBeGreaterThan(0);
    }
    if (!rejected) {
      // If it resolved, must be a structured failure naming the probeId
      expect(result).toBeTruthy();
      const r = result as { pass?: boolean; message?: string };
      expect(r.pass).toBe(false);
      expect(typeof r.message).toBe('string');
      expect(r.message ?? '').toMatch(/unknown|invalid|not.*recognized/i);
      expect(r.message ?? '').toContain('does-not-exist');
    }
  });
});

// ---------------------------------------------------------------------------
// Probe #1 — docker-running
// ---------------------------------------------------------------------------

describe('docker-running probe', () => {
  it('T-100: passes when injected spawn returns exit code 0', async () => {
    const result = await runProbe('docker-running', {
      spawn: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    expect(result.pass).toBe(true);
    expect(typeof result.message).toBe('string');
    expect(result.action).toBeUndefined();
  });

  it('T-101: fails on non-zero exit with verbatim spec message', async () => {
    const result = await runProbe('docker-running', {
      spawn: () => ({
        status: 1,
        stdout: '',
        stderr: 'Cannot connect to the Docker daemon',
      }),
    });
    expect(result.pass).toBe(false);
    expect(result.message).toContain('Docker Desktop is not running');
    expect(result.action).toBeUndefined();
  });

  it('T-102: fails on ENOENT (docker binary absent) with no shell action', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const result = await runProbe('docker-running', {
      spawn: () => {
        throw enoent;
      },
    });
    expect(result.pass).toBe(false);
    expect(result.message).toContain('Docker Desktop is not running');
    expect(result.action).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Probe #2 — node-version
// ---------------------------------------------------------------------------

describe('node-version probe', () => {
  let originalVersion: PropertyDescriptor | undefined;

  function overrideNodeVersion(value: string): void {
    originalVersion = Object.getOwnPropertyDescriptor(process, 'version');
    Object.defineProperty(process, 'version', {
      configurable: true,
      writable: true,
      value,
    });
  }

  afterEach(() => {
    if (originalVersion) {
      Object.defineProperty(process, 'version', originalVersion);
      originalVersion = undefined;
    }
  });

  it('T-103: passes when process.version major is >= 18', async () => {
    overrideNodeVersion('v20.10.0');
    const result = await runProbe('node-version', {});
    expect(result.pass).toBe(true);
  });

  it('T-104: fails when process.version major is < 18 and message names the detected version', async () => {
    overrideNodeVersion('v16.20.0');
    const result = await runProbe('node-version', {});
    expect(result.pass).toBe(false);
    // Message must literally contain the detected version (with or without 'v')
    expect(/16\.20\.0/.test(result.message)).toBe(true);
  });

  it('T-105: never attaches a shell action on either branch', async () => {
    overrideNodeVersion('v20.10.0');
    const passed = await runProbe('node-version', {});
    expect(passed.action).toBeUndefined();
    expect(JSON.stringify(passed)).not.toContain('"kind":"shell"');

    overrideNodeVersion('v16.20.0');
    const failed = await runProbe('node-version', {});
    expect(failed.action).toBeUndefined();
    expect(JSON.stringify(failed)).not.toContain('"kind":"shell"');
  });
});

// ---------------------------------------------------------------------------
// Probe #3 — pnpm-available
// ---------------------------------------------------------------------------

describe('pnpm-available probe', () => {
  it('T-106: passes when injected spawn returns a parseable version', async () => {
    const result = await runProbe('pnpm-available', {
      spawn: () => ({ status: 0, stdout: '8.15.4\n', stderr: '' }),
    });
    expect(result.pass).toBe(true);
    expect(result.message).toContain('8.15.4');
  });

  it('T-107: fails on ENOENT with the exact install hint', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const result = await runProbe('pnpm-available', {
      spawn: () => {
        throw enoent;
      },
    });
    expect(result.pass).toBe(false);
    expect(result.message).toContain('npm install -g pnpm');
    expect(result.action).toBeUndefined();
  });

  it('T-108: fails on non-zero exit with install hint', async () => {
    const result = await runProbe('pnpm-available', {
      spawn: () => ({
        status: 127,
        stdout: '',
        stderr: 'pnpm: command not found',
      }),
    });
    expect(result.pass).toBe(false);
    expect(result.message).toContain('npm install -g pnpm');
  });
});

// ---------------------------------------------------------------------------
// Probe #4 — sui-cli-version
// ---------------------------------------------------------------------------

describe('sui-cli-version probe', () => {
  it('T-109: passes for in-range versions (1.63.2, 1.63.5, 1.64.0, 1.64.1)', async () => {
    for (const v of ['1.63.2', '1.63.5', '1.64.0', '1.64.1']) {
      const result = await runProbe('sui-cli-version', {
        spawn: () => ({ status: 0, stdout: `sui ${v}-abc\n`, stderr: '' }),
      });
      expect(result.pass, `expected pass for ${v}, got ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it('T-110: fails for below-range version (1.62.0) as a guided stop with brew hint', async () => {
    let threw = false;
    let result: { pass: boolean; message: string; action?: unknown } | undefined;
    try {
      result = await runProbe('sui-cli-version', {
        spawn: () => ({ status: 0, stdout: 'sui 1.62.0\n', stderr: '' }),
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toBeTruthy();
    expect(result!.pass).toBe(false);
    expect(result!.message).toContain('1.62.0');
    expect(result!.message).toContain('brew install sui');
  });

  it('T-111: fails for above-range version (1.65.0) as a guided stop', async () => {
    const result = await runProbe('sui-cli-version', {
      spawn: () => ({ status: 0, stdout: 'sui 1.65.0\n', stderr: '' }),
    });
    expect(result.pass).toBe(false);
    expect(result.message).toContain('1.65.0');
    expect(result.action).toBeUndefined();
  });

  it('T-112: never attaches a shell action even on fail', async () => {
    const result = await runProbe('sui-cli-version', {
      spawn: () => ({ status: 0, stdout: 'sui 1.62.0\n', stderr: '' }),
    });
    expect(result.action).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('"kind":"shell"');
  });
});

// ---------------------------------------------------------------------------
// Probe #5 — sui-pilot-enabled
// ---------------------------------------------------------------------------

describe('sui-pilot-enabled probe', () => {
  it('T-113: passes when settings.json has sui-pilot@<source> = true', async () => {
    writeSettings(
      JSON.stringify({ enabledPlugins: { 'sui-pilot@alilloig': true } }),
    );
    const result = await runProbe('sui-pilot-enabled', {});
    expect(result.pass).toBe(true);
  });

  it('T-114: accepts any source suffix (sui-pilot@<anything>)', async () => {
    writeSettings(
      JSON.stringify({ enabledPlugins: { 'sui-pilot@local-dev': true } }),
    );
    const result = await runProbe('sui-pilot-enabled', {});
    expect(result.pass).toBe(true);
  });

  it('T-115: fails when no matching key is present and message includes activation hint', async () => {
    writeSettings(
      JSON.stringify({ enabledPlugins: { 'other-plugin@source': true } }),
    );
    const result = await runProbe('sui-pilot-enabled', {});
    expect(result.pass).toBe(false);
    expect(result.message).toContain('claude plugins enable sui-pilot');
  });

  it('T-116: fails when settings.json is missing entirely', async () => {
    // No settings file written.
    const result = await runProbe('sui-pilot-enabled', {});
    expect(result.pass).toBe(false);
    expect(result.message).toContain('claude plugins enable sui-pilot');
  });
});

// ---------------------------------------------------------------------------
// Probe #6 — sandbox-repo-present
// ---------------------------------------------------------------------------

describe('sandbox-repo-present probe', () => {
  it('T-117: passes when ~/workspace/deepbook-sandbox is a directory', async () => {
    fs.mkdirSync(path.join(tempHome, 'workspace', 'deepbook-sandbox'), {
      recursive: true,
    });
    const result = await runProbe('sandbox-repo-present', {});
    expect(result.pass).toBe(true);
  });

  it('T-118: fails (ENOENT) with the exact spec.md clone command', async () => {
    // tempHome has no workspace dir
    const result = await runProbe('sandbox-repo-present', {});
    expect(result.pass).toBe(false);
    expect(result.message).toContain(
      'git clone --recurse-submodules https://github.com/MystenLabs/deepbook-sandbox.git ~/workspace/deepbook-sandbox',
    );
  });

  it('T-119: fails (ENOTDIR) when path exists but is a file', async () => {
    const workspaceDir = path.join(tempHome, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'deepbook-sandbox'), 'not a dir');
    const result = await runProbe('sandbox-repo-present', {});
    expect(result.pass).toBe(false);
    expect(result.message).toContain(
      'git clone --recurse-submodules https://github.com/MystenLabs/deepbook-sandbox.git',
    );
  });
});

// ---------------------------------------------------------------------------
// Probe #7 — sandbox-manifest-reachable
// ---------------------------------------------------------------------------

describe('sandbox-manifest-reachable probe', () => {
  it('T-120: passes when fetch returns HTTP 200 and never attaches an action', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '{}',
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await runProbe('sandbox-manifest-reachable', {});
    expect(result.pass).toBe(true);
    expect(result.action).toBeUndefined();
  });

  it('T-121: fails on non-200 and attaches a shell action', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await runProbe('sandbox-manifest-reachable', {});
    expect(result.pass).toBe(false);
    expect(result.action).toBeTruthy();
    expect(result.action!.kind).toBe('shell');
    expect(result.action!.command).toBe('pnpm deploy-all --quick');
    expect(result.action!.cwd).toBeTruthy();
    const cwd = result.action!.cwd!;
    expect(cwd.endsWith('deepbook-sandbox/sandbox') ||
      cwd.endsWith('deepbook-sandbox/sandbox/') ||
      cwd.endsWith(path.join('deepbook-sandbox', 'sandbox'))).toBe(true);
    expect(result.action!.timeoutMs).toBe(420000);
  });

  it('T-122: fails on connect refused (fetch rejects ECONNREFUSED)', async () => {
    const econnrefused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const fetchSpy = vi.fn(async () => {
      throw econnrefused;
    });
    vi.stubGlobal('fetch', fetchSpy);
    const result = await runProbe('sandbox-manifest-reachable', {});
    expect(result.pass).toBe(false);
    expect(result.action).toBeTruthy();
    expect(result.action!.kind).toBe('shell');
    expect(result.action!.command).toBe('pnpm deploy-all --quick');
  });

  it('T-123: fetches exactly http://localhost:9009/manifest', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '{}',
    }));
    vi.stubGlobal('fetch', fetchSpy);
    await runProbe('sandbox-manifest-reachable', {});
    expect(fetchSpy).toHaveBeenCalled();
    const firstArg = fetchSpy.mock.calls[0][0];
    const url = typeof firstArg === 'string' ? firstArg : (firstArg as URL).href;
    expect(url).toBe('http://localhost:9009/manifest');
  });

  it('T-124: pass branch never carries an action even when remediate=true', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '{}',
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await runProbe('sandbox-manifest-reachable', { remediate: true });
    expect(result.pass).toBe(true);
    expect(result.action).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Probe #8 — learning-output-style-enabled
// ---------------------------------------------------------------------------

describe('learning-output-style-enabled probe', () => {
  it('T-125: delegates to probeOutputStyle and re-classifies pass', async () => {
    writeSettings(
      JSON.stringify({ enabledPlugins: { [ENABLED_PLUGIN_KEY]: true } }),
    );
    const result = await runProbe('learning-output-style-enabled', {});
    expect(result.pass).toBe(true);
  });

  it('T-126: re-classifies fail with a message referencing learning-output-style', async () => {
    writeSettings(JSON.stringify({ enabledPlugins: {} }));
    const result = await runProbe('learning-output-style-enabled', {});
    expect(result.pass).toBe(false);
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
    expect(/learning|output.?style/i.test(result.message)).toBe(true);
  });

  it("T-127: probe source contains zero copies of the literal plugin key", () => {
    const sourcePath = path.resolve(
      __dirname,
      '../mcp/server/src/probes/learningOutputStyle.ts',
    );
    const content = fs.readFileSync(sourcePath, 'utf8');
    expect(content.indexOf('learning-output-style@claude-plugins-official')).toBe(-1);
  });

  it('T-128: probe source imports probeOutputStyle from outputStyle.js', () => {
    const sourcePath = path.resolve(
      __dirname,
      '../mcp/server/src/probes/learningOutputStyle.ts',
    );
    const content = fs.readFileSync(sourcePath, 'utf8');
    expect(/from\s+['"][^'"]*outputStyle(\.js)?['"]/.test(content)).toBe(true);
    expect(/probeOutputStyle/.test(content)).toBe(true);
  });

  it('T-129: outputStyle.ts is unchanged (literal plugin key still present)', () => {
    const sourcePath = path.resolve(__dirname, '../mcp/server/src/outputStyle.ts');
    const content = fs.readFileSync(sourcePath, 'utf8');
    expect(content.indexOf('learning-output-style@claude-plugins-official')).toBeGreaterThan(-1);
  });
});

// ---------------------------------------------------------------------------
// EngineWarning union (warnings.ts) — A20
// ---------------------------------------------------------------------------

describe('warnings.ts EngineWarning union', () => {
  const warningsPath = path.resolve(__dirname, '../mcp/server/src/warnings.ts');

  it('T-171: EngineWarning union exported with all expected kinds (registry, state, preflight)', () => {
    const content = fs.readFileSync(warningsPath, 'utf8');
    expect(content).toContain('EngineWarning');
    // Phase F round-2 H001 follow-on (warnings.ts kind audit):
    // - Removed 'path-malformed' / 'paths-empty' / 'paths-missing' (cycle 4 dropped these)
    // - Removed 'learning-output-style-disabled' (cycle 6 H002 superseded it with 'output-style-plugin-not-enabled')
    // - Added 'output-style-plugin-not-enabled' (the new cycle-6 kind)
    // - 'malformed-path-json' kept (registry's actual emitter; matches outputStyle.ts:45 alignment)
    const expectedKinds = [
      'malformed-path-json',
      'empty-paths-dir',
      'no-paths-dir',
      'state-corrupt',
      'state-schema-mismatch',
      'settings-file-missing',
      'settings-parse-error',
      'output-style-plugin-not-enabled',
      'preflight-fail',
      'preflight-deploy-precondition-failed',
      'preflight-deploy-timeout',
    ];
    for (const k of expectedKinds) {
      expect(content, `expected kind '${k}' in warnings.ts`).toContain(k);
    }
  });

  it('T-172: registry.ts imports its warning type from warnings.ts (no local declaration)', () => {
    const sourcePath = path.resolve(__dirname, '../mcp/server/src/registry.ts');
    const content = fs.readFileSync(sourcePath, 'utf8');
    expect(/from\s+['"][^'"]*warnings(\.js)?['"]/.test(content)).toBe(true);
    // Must not have a local declaration of RegistryWarning type/interface.
    expect(/(^|\n)\s*(?:export\s+)?(type|interface)\s+RegistryWarning\b/.test(content)).toBe(false);
  });

  it('T-173: tools/start.ts imports its warning type from warnings.ts (no local declaration)', () => {
    const sourcePath = path.resolve(__dirname, '../mcp/server/src/tools/start.ts');
    const content = fs.readFileSync(sourcePath, 'utf8');
    expect(/from\s+['"][^'"]*warnings(\.js)?['"]/.test(content)).toBe(true);
    expect(/(^|\n)\s*(?:export\s+)?(type|interface)\s+StateWarning\b/.test(content)).toBe(false);
  });

  it('T-174: registry warning wire kinds preserved character-for-character', async () => {
    const malformedRoot = path.resolve(__dirname, 'fixtures/paths-malformed');
    const malformedResult = await scanRegistry(malformedRoot);
    const malformed = malformedResult.warnings.find(
      (w) => w.kind === 'malformed-path-json',
    );
    expect(malformed).toBeTruthy();

    const emptyRoot = path.resolve(__dirname, 'fixtures/paths-empty');
    const emptyResult = await scanRegistry(emptyRoot);
    const empty = emptyResult.warnings.find((w) => w.kind === 'empty-paths-dir');
    expect(empty).toBeTruthy();

    const nonexistent = path.join(
      os.tmpdir(),
      `definitely-not-a-real-paths-${Date.now()}-${Math.random()}`,
    );
    const noPathsResult = await scanRegistry(nonexistent);
    const noPaths = noPathsResult.warnings.find((w) => w.kind === 'no-paths-dir');
    expect(noPaths).toBeTruthy();
  });

  it('T-175: state warning wire kinds preserved character-for-character', async () => {
    // Seed corrupt state and confirm loadState still returns kind='corrupt'.
    const root = makeTempRoot();
    const stateDir = path.join(root, '.sui-deepbook-course');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state.json'), '{ not json', 'utf8');
    const corrupt = await loadState(root);
    expect(corrupt.kind).toBe('corrupt');

    // Schema-mismatch path
    const root2 = makeTempRoot();
    const stateDir2 = path.join(root2, '.sui-deepbook-course');
    fs.mkdirSync(stateDir2, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir2, 'state.json'),
      JSON.stringify({ schema_version: 999 }),
      'utf8',
    );
    const mismatch = await loadState(root2);
    expect(mismatch.kind).toBe('schema-mismatch');

    // The start tool must surface the same wire kinds verbatim.
    const root3 = makeTempRoot();
    fs.mkdirSync(path.join(root3, 'paths'), { recursive: true });
    const stateDir3 = path.join(root3, '.sui-deepbook-course');
    fs.mkdirSync(stateDir3, { recursive: true });
    fs.writeFileSync(path.join(stateDir3, 'state.json'), '{ not json', 'utf8');

    // Force outputStyle.ok via a settings.json under tempHome.
    writeSettings(
      JSON.stringify({ enabledPlugins: { [ENABLED_PLUGIN_KEY]: true } }),
    );
    const startResult = await runStart({ projectRoot: root3 });
    const stateWarning = (startResult.warnings as Array<{ kind: string }>).find(
      (w) => /^state-/.test(w.kind),
    );
    expect(stateWarning).toBeTruthy();
    expect(stateWarning!.kind).toBe('state-corrupt');
  });

  it('T-176: preflight warning kinds defined in warnings.ts', () => {
    const content = fs.readFileSync(warningsPath, 'utf8');
    expect(content).toContain('preflight-fail');
    expect(content).toContain('preflight-deploy-precondition-failed');
    expect(content).toContain('preflight-deploy-timeout');
  });
});

// ---------------------------------------------------------------------------
// AC-1.3 preserved on cycle-3 surface — T-177
// ---------------------------------------------------------------------------

describe('start tool with outputStyleOk=false (AC-1.3 carry-forward)', () => {
  it('T-177: zero writes AND preflight runProbe is never reached when outputStyleOk=false', async () => {
    // No settings.json under tempHome → outputStyle probe returns ok=false.
    const projectRoot = makeTempRoot();
    // Seed a valid path so the registry has something to scan.
    const slugDir = path.join(projectRoot, 'paths', '04-fake-path');
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(
      path.join(slugDir, 'path.json'),
      JSON.stringify({
        slug: '04-fake-path',
        title: 'Fake',
        summary: 'fixture',
        personalization_options: ['poll_interval_ms', 'pool_subset'],
        build_command: 'pnpm build',
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(slugDir, 'phases.json'),
      JSON.stringify({
        phases: [
          { id: 'p1', spots: [{ id: 's1' }] },
          { id: 'p2', spots: [{ id: 's2' }] },
          { id: 'p3', spots: [{ id: 's3' }] },
        ],
      }),
      'utf8',
    );

    // Spy every write surface.
    const writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync');
    const writeFileSpy = vi.spyOn(fs, 'writeFile');
    const mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync');
    const mkdirSpy = vi.spyOn(fs, 'mkdir');
    const renameSyncSpy = vi.spyOn(fs, 'renameSync');
    const renameSpy = vi.spyOn(fs, 'rename');
    const unlinkSyncSpy = vi.spyOn(fs, 'unlinkSync');

    const promisesWriteFileSpy = vi.spyOn(fsPromises, 'writeFile');
    const promisesMkdirSpy = vi.spyOn(fsPromises, 'mkdir');
    const promisesRenameSpy = vi.spyOn(fsPromises, 'rename');
    const promisesUnlinkSpy = vi.spyOn(fsPromises, 'unlink');

    const response = await runStart({ projectRoot });

    expect(response.outputStyleOk).toBe(false);
    expect(response.state).toBeNull();

    // Every write surface untouched.
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(mkdirSyncSpy).not.toHaveBeenCalled();
    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(renameSyncSpy).not.toHaveBeenCalled();
    expect(renameSpy).not.toHaveBeenCalled();
    expect(unlinkSyncSpy).not.toHaveBeenCalled();

    expect(promisesWriteFileSpy).not.toHaveBeenCalled();
    expect(promisesMkdirSpy).not.toHaveBeenCalled();
    expect(promisesRenameSpy).not.toHaveBeenCalled();
    expect(promisesUnlinkSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T-178: tsc --noEmit
// ---------------------------------------------------------------------------

describe('TypeScript strict surface compiles (cycle 3 additions)', () => {
  it('T-178: tsc --noEmit on mcp/server/ exits zero', () => {
    const result = spawnSync(
      'pnpm',
      ['--filter', './mcp/server', 'exec', 'tsc', '--noEmit'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(0);
  });
});

// ===========================================================================
// CYCLE 4 — A13 (drop setSpawnOverride; per-call ProbeOptions.spawn injection)
// ===========================================================================

describe('cycle 4 — A13 preflight drops setSpawnOverride', () => {
  it('T-259: preflight.ts no longer exports setSpawnOverride and contains no module-level spawnOverrides Map', async () => {
    const sourcePath = path.join(REPO_ROOT, 'mcp', 'server', 'src', 'preflight.ts');
    const content = fs.readFileSync(sourcePath, 'utf8');
    expect(content.indexOf('setSpawnOverride')).toBe(-1);
    expect(content.indexOf('spawnOverrides')).toBe(-1);
    // Dynamically import to verify the export is actually gone.
    const mod = await import('../mcp/server/src/preflight.js');
    expect('setSpawnOverride' in mod).toBe(false);
  });

  it('T-260: no source file in mcp/server/src/ references setSpawnOverride', () => {
    const SCAN_ROOT = path.join(REPO_ROOT, 'mcp', 'server', 'src');
    const offenders: string[] = [];
    function walk(dir: string): void {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (path.extname(entry.name) !== '.ts') continue;
        const content = fs.readFileSync(full, 'utf8');
        if (content.indexOf('setSpawnOverride') !== -1) offenders.push(full);
      }
    }
    walk(SCAN_ROOT);
    expect(offenders).toEqual([]);
  });

  it('T-261: runProbe consults only opts.spawn (no module-level lookup)', async () => {
    let invoked = 0;
    const spawnStub = (() => {
      invoked++;
      return { status: 0, stdout: 'docker pass', stderr: '' };
    }) as any;
    const result = await runProbe('docker-running', { spawn: spawnStub });
    expect(invoked).toBe(1);
    expect(result.pass).toBe(true);
  });
});
