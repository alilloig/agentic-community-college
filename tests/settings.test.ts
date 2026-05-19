import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accConfigExists,
  configFilePath,
  defaultAccConfig,
  loadAccConfig,
  mergeAccConfig,
  saveAccConfig,
  AccConfigError,
} from '../mcp/server/src/settings.js';

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-settings-test-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('settings — default + paths', () => {
  it('configFilePath points at <home>/.acc/config.json', () => {
    expect(configFilePath('/tmp/h')).toBe('/tmp/h/.acc/config.json');
  });

  it('defaultAccConfig has workspace_root=~/workspace and empty course_paths', () => {
    const d = defaultAccConfig();
    expect(d.workspace_root).toBe('~/workspace');
    expect(d.course_paths).toEqual({});
  });
});

describe('settings — load missing/malformed', () => {
  it('returns defaults when no config file exists; does not write the file', async () => {
    const cfg = await loadAccConfig(tmpHome);
    expect(cfg.workspace_root).toBe('~/workspace');
    expect(cfg.course_paths).toEqual({});
    expect(await accConfigExists(tmpHome)).toBe(false);
  });

  it('throws AccConfigError on malformed JSON; does not auto-overwrite', async () => {
    const p = configFilePath(tmpHome);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not valid json');
    await expect(loadAccConfig(tmpHome)).rejects.toBeInstanceOf(AccConfigError);
    // Untouched
    expect(fs.readFileSync(p, 'utf8')).toBe('{not valid json');
  });

  it('throws AccConfigError on wrong shape (workspace_root is missing)', async () => {
    const p = configFilePath(tmpHome);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ course_paths: {} }));
    await expect(loadAccConfig(tmpHome)).rejects.toBeInstanceOf(AccConfigError);
  });

  it('throws AccConfigError when course_paths is an array', async () => {
    const p = configFilePath(tmpHome);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ workspace_root: '~/workspace', course_paths: [] }),
    );
    await expect(loadAccConfig(tmpHome)).rejects.toBeInstanceOf(AccConfigError);
  });
});

describe('settings — save + round-trip', () => {
  it('persists and reloads identically', async () => {
    await saveAccConfig(
      {
        workspace_root: '~/dev',
        course_paths: {
          'acc-deepbook-course@local': { sandbox: '~/dev/sb' },
        },
      },
      tmpHome,
    );
    expect(await accConfigExists(tmpHome)).toBe(true);

    const loaded = await loadAccConfig(tmpHome);
    expect(loaded.workspace_root).toBe('~/dev');
    expect(loaded.course_paths['acc-deepbook-course@local'].sandbox).toBe('~/dev/sb');
  });

  it('creates the ~/.acc/ directory if missing', async () => {
    expect(fs.existsSync(path.join(tmpHome, '.acc'))).toBe(false);
    await saveAccConfig(defaultAccConfig(), tmpHome);
    expect(fs.existsSync(path.join(tmpHome, '.acc'))).toBe(true);
  });

  it('writes with mode 0o600 (owner-only)', async () => {
    await saveAccConfig(defaultAccConfig(), tmpHome);
    const stats = fs.statSync(configFilePath(tmpHome));
    // Ignore the file-type bits; check that group/other have no perms.
    expect(stats.mode & 0o077).toBe(0);
  });
});

describe('settings — mergeAccConfig', () => {
  it('overwrites workspace_root and leaves course_paths intact', () => {
    const cur = {
      workspace_root: '~/old',
      course_paths: { 'a@1': { x: '/a' } },
    };
    const next = mergeAccConfig(cur, { workspace_root: '~/new' });
    expect(next.workspace_root).toBe('~/new');
    expect(next.course_paths['a@1'].x).toBe('/a');
  });

  it('deep-merges course_paths without nuking other entries', () => {
    const cur = {
      workspace_root: '~/w',
      course_paths: {
        'a@1': { x: '/a', y: '/y' },
        'b@1': { z: '/z' },
      },
    };
    const next = mergeAccConfig(cur, {
      course_paths: { 'a@1': { x: '/new-a' }, 'c@1': { q: '/q' } },
    });
    expect(next.course_paths['a@1']).toEqual({ x: '/new-a', y: '/y' });
    expect(next.course_paths['b@1']).toEqual({ z: '/z' });
    expect(next.course_paths['c@1']).toEqual({ q: '/q' });
  });

  it('throws on invalid patch shape', () => {
    const cur = defaultAccConfig();
    expect(() =>
      mergeAccConfig(cur, { workspace_root: '' }),
    ).toThrow(AccConfigError);
    // `null` is now valid (it's the delete sentinel); arrays must still
    // be rejected.
    expect(() =>
      mergeAccConfig(cur, {
        course_paths: { 'a@1': [] as unknown as Record<string, string> },
      }),
    ).toThrow(AccConfigError);
    expect(() =>
      mergeAccConfig(cur, {
        course_paths: { 'a@1': { x: '' } },
      }),
    ).toThrow(AccConfigError);
  });

  it("deletes a single id when its value is null", () => {
    const cur = {
      workspace_root: '~/w',
      course_paths: { 'a@1': { x: '/x', y: '/y' } },
    };
    const next = mergeAccConfig(cur, {
      course_paths: { 'a@1': { x: null } },
    });
    expect(next.course_paths['a@1']).toEqual({ y: '/y' });
  });

  it("drops the plugin block when its value is null", () => {
    const cur = {
      workspace_root: '~/w',
      course_paths: { 'a@1': { x: '/x' }, 'b@1': { y: '/y' } },
    };
    const next = mergeAccConfig(cur, {
      course_paths: { 'a@1': null },
    });
    expect(next.course_paths['a@1']).toBeUndefined();
    expect(next.course_paths['b@1']).toEqual({ y: '/y' });
  });

  it("drops an emptied plugin block after nulling every id", () => {
    const cur = { workspace_root: '~/w', course_paths: { 'a@1': { x: '/x' } } };
    const next = mergeAccConfig(cur, { course_paths: { 'a@1': { x: null } } });
    expect(next.course_paths['a@1']).toBeUndefined();
  });

  it("rejects '..' segments in workspace_root and overrides", () => {
    const cur = defaultAccConfig();
    expect(() =>
      mergeAccConfig(cur, { workspace_root: '~/dev/../etc' }),
    ).toThrow(AccConfigError);
    expect(() =>
      mergeAccConfig(cur, {
        course_paths: { 'a@1': { sandbox: 'evil/../path' } },
      }),
    ).toThrow(AccConfigError);
  });
});

describe('settings — load rejects malicious paths', () => {
  it("rejects loaded config with '..' in workspace_root", async () => {
    const p = configFilePath(tmpHome);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ workspace_root: '~/dev/../etc', course_paths: {} }),
    );
    await expect(loadAccConfig(tmpHome)).rejects.toBeInstanceOf(AccConfigError);
  });

  it("rejects loaded config with '..' in a course_paths value", async () => {
    const p = configFilePath(tmpHome);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({
        workspace_root: '~/dev',
        course_paths: { 'a@1': { sandbox: '../escape' } },
      }),
    );
    await expect(loadAccConfig(tmpHome)).rejects.toBeInstanceOf(AccConfigError);
  });
});
