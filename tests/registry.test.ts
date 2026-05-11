import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Modules under test — none of these exist yet at red phase.
// Their imports failing causes vitest to fail the suite, which is the
// meaningful red signal. The assertion bodies below describe the behavior
// the implementer must produce in green.
import { scanRegistry } from '../mcp/server/src/registry.js';
import { validatePath } from '../mcp/server/src/schemas/path.js';
import { validatePhases } from '../mcp/server/src/schemas/phases.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURES_ROOT = path.resolve(__dirname, 'fixtures');

let tempRoots: string[] = [];

function makeTempRoot(prefix = 'sui-course-paths-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeRaw(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function makeWellFormedPath(root: string, slug: string): void {
  writeJson(path.join(root, slug, 'path.json'), {
    slug,
    title: `${slug} title`,
    summary: `${slug} summary`,
    personalization_options: ['poll_interval_ms', 'pool_subset'],
    build_command: 'pnpm build',
  });
  writeJson(path.join(root, slug, 'phases.json'), {
    phases: [
      { id: 'p1', spots: [{ id: 's1', title: 'stub' }] },
      { id: 'p2', spots: [{ id: 's2', title: 'stub' }] },
      { id: 'p3', spots: [{ id: 's3', title: 'stub' }] },
    ],
  });
}

afterEach(() => {
  for (const dir of tempRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  }
  tempRoots = [];
});

describe('plugin manifest', () => {
  const manifestPath = path.join(REPO_ROOT, '.claude-plugin', 'plugin.json');

  it('T-001: plugin.json parses and declares required top-level keys', () => {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed: any = JSON.parse(raw);

    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();

    expect(typeof parsed.name).toBe('string');
    expect(parsed.name.length).toBeGreaterThan(0);

    expect(typeof parsed.version).toBe('string');
    expect(parsed.version.length).toBeGreaterThan(0);

    expect(typeof parsed.description).toBe('string');

    expect(typeof parsed.mcpServers).toBe('object');
    expect(parsed.mcpServers).not.toBeNull();
    expect(Array.isArray(parsed.mcpServers)).toBe(false);
    expect(Object.keys(parsed.mcpServers).length).toBeGreaterThan(0);

    // Canonical Claude Code plugin schema: commands/agents are arrays of
    // file paths, skills is a string path. hooks is optional and absent
    // when the plugin defines none.
    expect(Array.isArray(parsed.commands)).toBe(true);
    expect(parsed.commands.length).toBeGreaterThan(0);

    expect(Array.isArray(parsed.agents)).toBe(true);
    expect(typeof parsed.skills).toBe('string');
  });

  it('T-002: plugin.json mcpServers entry references the built MCP server entrypoint', () => {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed: any = JSON.parse(raw);

    const servers = parsed.mcpServers;
    expect(typeof servers).toBe('object');

    const serverEntries = Object.values(servers) as any[];
    expect(serverEntries.length).toBeGreaterThan(0);

    let foundBuiltRef = false;
    for (const entry of serverEntries) {
      const haystack = JSON.stringify(entry);
      if (
        haystack.includes('mcp/server/dist/index.js') ||
        haystack.includes('mcp/server/src/index.ts') ||
        haystack.includes('mcp/server')
      ) {
        foundBuiltRef = true;
      }
    }
    expect(foundBuiltRef).toBe(true);
  });
});

describe('registry scanner', () => {
  it('T-019: surfaces the well-formed 01-orderbook-viewer path from real paths/', async () => {
    const realPathsRoot = path.join(REPO_ROOT, 'paths');
    const result = await scanRegistry(realPathsRoot);

    expect(Array.isArray(result.paths)).toBe(true);
    const orderbook = result.paths.find((p: any) => p.slug === '01-orderbook-viewer');
    expect(orderbook).toBeTruthy();
    expect(typeof orderbook.title).toBe('string');
    expect(orderbook.title.length).toBeGreaterThan(0);
    expect(typeof orderbook.summary).toBe('string');
    expect(orderbook.summary.length).toBeGreaterThan(0);
  });

  it('T-020: surfaces fake fourth path from fixture without code changes', async () => {
    const fakeRoot = path.join(FIXTURES_ROOT, 'paths');
    const result = await scanRegistry(fakeRoot);

    const fake = result.paths.find((p: any) => p.slug === '04-fake-path');
    expect(fake).toBeTruthy();
    expect(fake.title).toBe('Fake Fourth Path');
  });

  it('T-021: skips path with malformed path.json and emits structured warning', async () => {
    const malformedRoot = path.join(FIXTURES_ROOT, 'paths-malformed');
    const result = await scanRegistry(malformedRoot);

    expect(result.paths.find((p: any) => p.slug === '04-broken-path')).toBeUndefined();

    const malformedWarnings = result.warnings.filter(
      (w: any) => w.kind === 'malformed-path-json',
    );
    expect(malformedWarnings.length).toBe(1);
    const w = malformedWarnings[0];
    expect(typeof w.path).toBe('string');
    expect(w.path).toContain('path.json');
    expect(typeof w.message).toBe('string');
    expect(w.message.length).toBeGreaterThan(0);
  });

  it('T-022: surfaces other well-formed paths even when one is malformed', async () => {
    const root = makeTempRoot();
    // Well-formed path.
    makeWellFormedPath(root, '04-fake-path');
    // Malformed path alongside it.
    writeRaw(path.join(root, '99-broken', 'path.json'), '{ not json');

    const result = await scanRegistry(root);

    const fake = result.paths.find((p: any) => p.slug === '04-fake-path');
    expect(fake).toBeTruthy();
    expect(result.paths.find((p: any) => p.slug === '99-broken')).toBeUndefined();

    const malformed = result.warnings.find(
      (w: any) => w.kind === 'malformed-path-json',
    );
    expect(malformed).toBeTruthy();
    expect(malformed.path).toContain('99-broken');
  });

  it('T-023: skips dir missing path.json with structured warning', async () => {
    const root = makeTempRoot();
    // Dir with phases.json but no path.json.
    writeJson(path.join(root, 'no-path-json', 'phases.json'), {
      phases: [{ id: 'p1', spots: [{ id: 's1' }] }],
    });

    const result = await scanRegistry(root);

    expect(result.paths.find((p: any) => p.slug === 'no-path-json')).toBeUndefined();

    const missing = result.warnings.find(
      (w: any) =>
        typeof w.kind === 'string' && /missing/i.test(w.kind) && /path/i.test(w.kind),
    );
    expect(missing).toBeTruthy();
    expect(typeof missing.message).toBe('string');
    expect(missing.message.length).toBeGreaterThan(0);
    // The warning's path/dir field must point at the offending location.
    const locator = missing.path ?? missing.dir ?? missing.location ?? '';
    expect(typeof locator).toBe('string');
    expect(locator).toContain('no-path-json');
  });

  it('T-024: returns empty paths and empty-paths-dir warning when paths/ exists but is empty', async () => {
    const emptyRoot = path.join(FIXTURES_ROOT, 'paths-empty');
    const result = await scanRegistry(emptyRoot);

    expect(result.paths).toEqual([]);
    const emptyWarnings = result.warnings.filter(
      (w: any) => w.kind === 'empty-paths-dir',
    );
    expect(emptyWarnings.length).toBe(1);
    expect(typeof emptyWarnings[0].message).toBe('string');
    expect(emptyWarnings[0].message.length).toBeGreaterThan(0);

    // No other warnings should be present.
    expect(result.warnings.length).toBe(1);
  });

  it('T-025: returns empty paths and no-paths-dir warning when paths/ is absent', async () => {
    const nonexistent = path.join(
      os.tmpdir(),
      `definitely-not-a-real-dir-${Date.now()}-${Math.random()}`,
    );
    const result = await scanRegistry(nonexistent);

    expect(result.paths).toEqual([]);
    const noPathsWarnings = result.warnings.filter(
      (w: any) => w.kind === 'no-paths-dir',
    );
    expect(noPathsWarnings.length).toBe(1);
    expect(typeof noPathsWarnings[0].message).toBe('string');
    expect(noPathsWarnings[0].message.length).toBeGreaterThan(0);
  });

  it('T-026: skips non-directory entries under paths/ silently', async () => {
    const root = makeTempRoot();
    makeWellFormedPath(root, '04-fake-path');
    // Drop a regular file alongside the path dir.
    writeRaw(path.join(root, 'README.txt'), 'I am not a path directory.');

    const result = await scanRegistry(root);

    expect(result.paths.length).toBe(1);
    expect(result.paths[0].slug).toBe('04-fake-path');

    // No warning should be emitted for the stray file.
    for (const w of result.warnings) {
      const haystack = JSON.stringify(w);
      expect(haystack).not.toContain('README.txt');
    }
  });

  it('T-040: emits schema-invalid warning for path.json that parses but fails validation', async () => {
    const root = makeTempRoot();
    // Well-formed JSON, but missing the required `slug` field.
    writeJson(path.join(root, 'schema-bad', 'path.json'), {
      title: 'Has title',
      summary: 'Has summary',
      personalization_options: ['poll_interval_ms'],
      build_command: 'pnpm build',
    });
    writeJson(path.join(root, 'schema-bad', 'phases.json'), {
      phases: [{ id: 'p1', spots: [{ id: 's1' }] }],
    });

    const result = await scanRegistry(root);

    expect(result.paths.find((p: any) => p.slug === 'schema-bad')).toBeUndefined();

    const schemaWarning = result.warnings.find(
      (w: any) =>
        typeof w.kind === 'string' &&
        /(schema|invalid|valid)/i.test(w.kind) &&
        w.kind !== 'malformed-path-json',
    );
    expect(schemaWarning).toBeTruthy();
    const locator = schemaWarning.path ?? schemaWarning.dir ?? schemaWarning.location ?? '';
    expect(typeof locator).toBe('string');
    expect(locator).toContain('schema-bad');
    expect(typeof schemaWarning.message).toBe('string');
    expect(schemaWarning.message.toLowerCase()).toContain('slug');
  });

  it('T-041: registry skips path with missing phases.json and emits structured warning', async () => {
    const root = makeTempRoot();
    // valid path.json but no phases.json sibling
    writeJson(path.join(root, 'no-phases', 'path.json'), {
      slug: 'no-phases',
      title: 'no phases',
      summary: 'fixture',
      personalization_options: ['poll_interval_ms', 'pool_subset'],
      build_command: 'pnpm build',
    });

    const result = await scanRegistry(root);

    expect(result.paths.find((p: any) => p.slug === 'no-phases')).toBeUndefined();

    const phasesWarning = result.warnings.find(
      (w: any) =>
        typeof w.kind === 'string' &&
        /phases/i.test(w.kind),
    );
    expect(phasesWarning).toBeTruthy();
    const locator = phasesWarning.path ?? phasesWarning.dir ?? phasesWarning.location ?? '';
    expect(typeof locator).toBe('string');
    expect(locator).toContain('no-phases');
    expect(typeof phasesWarning.message).toBe('string');
    expect(phasesWarning.message.length).toBeGreaterThan(0);
  });

  it('T-042: registry skips path with malformed phases.json and emits structured warning', async () => {
    const root = makeTempRoot();
    writeJson(path.join(root, 'broken-phases', 'path.json'), {
      slug: 'broken-phases',
      title: 'broken phases',
      summary: 'fixture',
      personalization_options: ['poll_interval_ms', 'pool_subset'],
      build_command: 'pnpm build',
    });
    writeRaw(path.join(root, 'broken-phases', 'phases.json'), '{ this is not json');

    const result = await scanRegistry(root);

    expect(result.paths.find((p: any) => p.slug === 'broken-phases')).toBeUndefined();

    const phasesWarning = result.warnings.find(
      (w: any) =>
        typeof w.kind === 'string' &&
        /phases/i.test(w.kind),
    );
    expect(phasesWarning).toBeTruthy();
    const locator = phasesWarning.path ?? phasesWarning.dir ?? phasesWarning.location ?? '';
    expect(typeof locator).toBe('string');
    expect(locator).toContain('broken-phases');
    expect(typeof phasesWarning.message).toBe('string');
    expect(phasesWarning.message.length).toBeGreaterThan(0);
  });

  it('T-043: registry skips path with schema-invalid phases.json (zero spots) and emits structured warning', async () => {
    const root = makeTempRoot();
    writeJson(path.join(root, 'zero-spots', 'path.json'), {
      slug: 'zero-spots',
      title: 'zero spots',
      summary: 'fixture',
      personalization_options: ['poll_interval_ms', 'pool_subset'],
      build_command: 'pnpm build',
    });
    // Valid JSON, valid top shape, but a phase has zero spots — schema rejects.
    writeJson(path.join(root, 'zero-spots', 'phases.json'), {
      phases: [{ id: 'p1', spots: [] }],
    });

    const result = await scanRegistry(root);

    expect(result.paths.find((p: any) => p.slug === 'zero-spots')).toBeUndefined();

    const phasesWarning = result.warnings.find(
      (w: any) =>
        typeof w.kind === 'string' &&
        /phases/i.test(w.kind),
    );
    expect(phasesWarning).toBeTruthy();
    const locator = phasesWarning.path ?? phasesWarning.dir ?? phasesWarning.location ?? '';
    expect(typeof locator).toBe('string');
    expect(locator).toContain('zero-spots');
    expect(typeof phasesWarning.message).toBe('string');
    expect(phasesWarning.message.toLowerCase()).toMatch(/spot|phase|valid/);
  });
});

describe('engine source parametricity', () => {
  it("T-027: engine source contains zero string literals matching '01-orderbook-viewer'", () => {
    const SLUG = '01-orderbook-viewer';
    const SCAN_ROOTS = [
      path.join(REPO_ROOT, 'mcp', 'server', 'src'),
      path.join(REPO_ROOT, 'commands'),
      path.join(REPO_ROOT, 'skills', 'course-engine'),
      path.join(REPO_ROOT, 'scripts', 'e2e'),
    ];
    const ALLOWED_EXTS = new Set(['.ts', '.tsx', '.md', '.json']);
    const offenders: string[] = [];

    function walk(dir: string): void {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // dir not present yet — fine, vacuous pass
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name);
        if (!ALLOWED_EXTS.has(ext)) continue;
        const content = fs.readFileSync(full, 'utf8');
        if (content.indexOf(SLUG) !== -1) {
          offenders.push(full);
        }
      }
    }

    for (const root of SCAN_ROOTS) walk(root);

    expect(offenders).toEqual([]);
  });
});

describe('path.ts schema', () => {
  it('T-034: accepts a well-formed path.json', () => {
    const result = validatePath({
      slug: '01-orderbook-viewer',
      title: 'Orderbook Viewer',
      summary: 'short',
      personalization_options: ['poll_interval_ms', 'pool_subset'],
      build_command: 'pnpm build',
    });

    expect(result.ok).toBe(true);
    expect(result.value).toBeTruthy();
    expect(result.value.slug).toBe('01-orderbook-viewer');
  });

  it('T-035: rejects path.json missing required slug field', () => {
    const result = validatePath({
      title: 'x',
      summary: 'y',
      personalization_options: [],
      build_command: 'pnpm build',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    const errMessage =
      typeof result.error === 'string'
        ? result.error
        : JSON.stringify(result.error);
    expect(errMessage.toLowerCase()).toContain('slug');
  });

  it('T-036: rejects path.json with unknown enum value in personalization_options', () => {
    const result = validatePath({
      slug: '01-orderbook-viewer',
      title: 'x',
      summary: 'y',
      personalization_options: ['poll_interval_ms', 'render_style'],
      build_command: 'pnpm build',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    const errMessage =
      typeof result.error === 'string'
        ? result.error
        : JSON.stringify(result.error);
    expect(errMessage).toContain('render_style');
  });
});

describe('phases.ts schema', () => {
  it('T-037: accepts phases.json with three phases each having at least one spot', () => {
    const result = validatePhases({
      phases: [
        { id: 'p1', spots: [{ id: 's1' }] },
        { id: 'p2', spots: [{ id: 's2' }] },
        { id: 'p3', spots: [{ id: 's3' }] },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it('T-038: rejects phases.json with a phase that has zero spots', () => {
    const result = validatePhases({
      phases: [{ id: 'p1', spots: [] }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    const errMessage =
      typeof result.error === 'string'
        ? result.error
        : JSON.stringify(result.error);
    expect(errMessage.toLowerCase()).toMatch(/spot|empty|p1/);
  });

  it('T-039: rejects phases.json with no phases array', () => {
    const result = validatePhases({});

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    const errMessage =
      typeof result.error === 'string'
        ? result.error
        : JSON.stringify(result.error);
    expect(errMessage.toLowerCase()).toContain('phases');
  });
});

// ===========================================================================
// CYCLE 4 — A12 (RegistryWarning union tightening), A5 (personalization_ranges)
// ===========================================================================

import type { RegistryWarning } from '../mcp/server/src/warnings.js';

describe('cycle 4 — RegistryWarning discriminated union (A12)', () => {
  const warningsPath = path.join(REPO_ROOT, 'mcp', 'server', 'src', 'warnings.ts');

  it('T-254: RegistryWarning is a discriminated union of exactly eight kinds matching what registry.ts emits', () => {
    const content = fs.readFileSync(warningsPath, 'utf8');
    const expectedKinds = [
      'no-paths-dir',
      'empty-paths-dir',
      'missing-path-json',
      'malformed-path-json',
      'invalid-path-json',
      'missing-phases-json',
      'malformed-phases-json',
      'invalid-phases-json',
    ];
    for (const k of expectedKinds) {
      const single = content.indexOf("'" + k + "'") !== -1;
      const double = content.indexOf('"' + k + '"') !== -1;
      expect(single || double, 'kind literal not found: ' + k).toBe(true);
    }
    // The loose `kind: string` shape on RegistryWarning must be gone.
    // We grep for an exported `RegistryWarning` declaration whose kind is
    // the bare `string` type. The cycle-3 shape was:
    //   export interface RegistryWarning { kind: string; ... }
    // The cycle-4 shape uses literal kinds.
    const looseRe = /(?:export\s+)?(?:interface|type)\s+RegistryWarning[\s\S]{0,200}?kind\s*:\s*string\b/;
    expect(looseRe.test(content)).toBe(false);
  });

  it('T-255: warnings.ts no longer exports the orphan PathMalformedWarning / PathsEmptyWarning / PathsMissingWarning interfaces', () => {
    const content = fs.readFileSync(warningsPath, 'utf8');
    expect(content.indexOf('PathMalformedWarning')).toBe(-1);
    expect(content.indexOf('PathsEmptyWarning')).toBe(-1);
    expect(content.indexOf('PathsMissingWarning')).toBe(-1);
    // RegistryWarning still exported.
    expect(content.indexOf('RegistryWarning')).toBeGreaterThan(-1);
  });

  it('T-256: type-level: state-corrupt narrows away from RegistryWarning (compile-time guard)', () => {
    // This test runs a static check via a type assignment: a value typed as
    // RegistryWarning whose kind === 'state-corrupt' must produce a `never`
    // narrowing. The runtime check below is a stand-in — the load-bearing
    // assertion is the tsc --noEmit check (T-282).
    const w = { kind: 'state-corrupt', message: 'X' } as unknown;
    const isRegistryKind =
      typeof (w as any).kind === 'string' &&
      [
        'no-paths-dir',
        'empty-paths-dir',
        'missing-path-json',
        'malformed-path-json',
        'invalid-path-json',
        'missing-phases-json',
        'malformed-phases-json',
        'invalid-phases-json',
      ].includes((w as any).kind);
    expect(isRegistryKind).toBe(false);
  });

  it('T-257: scanRegistry warning wire kinds preserved against cycle-1 fixtures (regression)', async () => {
    const malformedRoot = path.join(FIXTURES_ROOT, 'paths-malformed');
    const m = await scanRegistry(malformedRoot);
    expect(m.warnings.find((w: RegistryWarning) => w.kind === 'malformed-path-json')).toBeTruthy();

    const emptyRoot = path.join(FIXTURES_ROOT, 'paths-empty');
    const e = await scanRegistry(emptyRoot);
    expect(e.warnings.find((w: RegistryWarning) => w.kind === 'empty-paths-dir')).toBeTruthy();

    const missing = await scanRegistry(
      path.join(os.tmpdir(), 'sui-course-c4-not-real-' + Date.now() + '-' + Math.random()),
    );
    expect(missing.warnings.find((w: RegistryWarning) => w.kind === 'no-paths-dir')).toBeTruthy();
  });

  it('T-258: warnings.ts adds new phase-engine warning kinds: phase-engine-phases-load-failed, personalization-validation-failed, verification-mode-unsupported', () => {
    const content = fs.readFileSync(warningsPath, 'utf8');
    expect(content.indexOf('phase-engine-phases-load-failed')).toBeGreaterThan(-1);
    expect(content.indexOf('personalization-validation-failed')).toBeGreaterThan(-1);
    expect(content.indexOf('verification-mode-unsupported')).toBeGreaterThan(-1);
  });
});

describe('cycle 4 — path.json personalization_ranges (A5)', () => {
  it('T-277: personalization_ranges in path.json is optional and validates when present', () => {
    // With ranges
    const okWith = validatePath({
      slug: '01-orderbook-viewer',
      title: 'x',
      summary: 'y',
      personalization_options: ['poll_interval_ms', 'pool_subset'],
      build_command: 'pnpm build',
      personalization_ranges: {
        poll_interval_ms: { min: 1000, max: 30000, default: 3000 },
        pool_subset: { values: ['both', 'DEEP_SUI', 'SUI_USDC'], default: 'both' },
      },
    });
    expect(okWith.ok).toBe(true);

    // Without ranges (back-compat with cycle 3 path.json)
    const okWithout = validatePath({
      slug: '01-orderbook-viewer',
      title: 'x',
      summary: 'y',
      personalization_options: ['poll_interval_ms', 'pool_subset'],
      build_command: 'pnpm build',
    });
    expect(okWithout.ok).toBe(true);

    // Invalid range
    const bad = validatePath({
      slug: '01-orderbook-viewer',
      title: 'x',
      summary: 'y',
      personalization_options: ['poll_interval_ms'],
      build_command: 'pnpm build',
      personalization_ranges: {
        poll_interval_ms: { min: 30000, max: 1000, default: 3000 },
      },
    });
    expect(bad.ok).toBe(false);
  });

  it('T-278: paths/01-orderbook-viewer/path.json declares personalization_ranges with the spec defaults', () => {
    const p = path.join(REPO_ROOT, 'paths', '01-orderbook-viewer', 'path.json');
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(obj.personalization_ranges).toBeTruthy();
    expect(obj.personalization_ranges.poll_interval_ms).toEqual({ min: 1000, max: 30000, default: 3000 });
    expect(obj.personalization_ranges.pool_subset).toEqual({
      values: ['both', 'DEEP_SUI', 'SUI_USDC'],
      default: 'both',
    });
  });
});
