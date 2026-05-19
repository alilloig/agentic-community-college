import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  resolveCoursePaths,
  substitutePathRefs,
  envVarsFor,
  envFileContents,
  PathRefError,
} from '../mcp/server/src/pathResolver.js';
import type { AccConfig } from '../mcp/server/src/settings.js';

const HOME = '/Users/test';

function cfg(overrides: Partial<AccConfig> = {}): AccConfig {
  return {
    workspace_root: '~/workspace',
    course_paths: {},
    ...overrides,
  };
}

describe('resolveCoursePaths — precedence chain', () => {
  it('derives default from workspace_root + manifest default when no override exists', () => {
    const r = resolveCoursePaths(
      'acc-deepbook-course@local',
      [{ id: 'sandbox', default: 'deepbook-sandbox' }],
      cfg(),
      HOME,
    );
    expect(r.sandbox).toBe(path.join(HOME, 'workspace', 'deepbook-sandbox'));
  });

  it('honors a user-level override per plugin/id', () => {
    const r = resolveCoursePaths(
      'acc-deepbook-course@local',
      [{ id: 'sandbox', default: 'deepbook-sandbox' }],
      cfg({
        course_paths: { 'acc-deepbook-course@local': { sandbox: '~/custom/sb' } },
      }),
      HOME,
    );
    expect(r.sandbox).toBe(path.join(HOME, 'custom', 'sb'));
  });

  it('ignores overrides for a different plugin', () => {
    const r = resolveCoursePaths(
      'walrus-course@local',
      [{ id: 'sandbox', default: 'walrus-sb' }],
      cfg({
        course_paths: { 'acc-deepbook-course@local': { sandbox: '~/custom/sb' } },
      }),
      HOME,
    );
    expect(r.sandbox).toBe(path.join(HOME, 'workspace', 'walrus-sb'));
  });

  it('expands a `~/` workspace_root', () => {
    const r = resolveCoursePaths(
      'c@x',
      [{ id: 'sb', default: 'd' }],
      cfg({ workspace_root: '~/dev' }),
      HOME,
    );
    expect(r.sb).toBe(path.join(HOME, 'dev', 'd'));
  });

  it('handles an absolute workspace_root', () => {
    const r = resolveCoursePaths(
      'c@x',
      [{ id: 'sb', default: 'd' }],
      cfg({ workspace_root: '/srv/dev' }),
      HOME,
    );
    expect(r.sb).toBe('/srv/dev/d');
  });

  it('returns an empty map when manifest declares no paths', () => {
    const r = resolveCoursePaths('c@x', [], cfg(), HOME);
    expect(r).toEqual({});
  });

  it('anchors a bare-relative override under workspace_root (not process.cwd)', () => {
    // Regression for the high-severity reviewer finding: `expandHome`
    // returns non-tilde inputs unchanged; without an explicit anchor,
    // path.resolve would fall back to process.cwd(). The fix resolves
    // overrides under workspace_root just like `default` values.
    const r = resolveCoursePaths(
      'c@x',
      [{ id: 'sandbox', default: 'd' }],
      cfg({
        workspace_root: '~/dev',
        course_paths: { 'c@x': { sandbox: 'custom-sb' } },
      }),
      HOME,
    );
    expect(r.sandbox).toBe(path.join(HOME, 'dev', 'custom-sb'));
  });

  it('keeps absolute overrides absolute regardless of workspace_root', () => {
    const r = resolveCoursePaths(
      'c@x',
      [{ id: 'sb', default: 'd' }],
      cfg({
        workspace_root: '~/dev',
        course_paths: { 'c@x': { sb: '/srv/abs' } },
      }),
      HOME,
    );
    expect(r.sb).toBe('/srv/abs');
  });
});

describe('substitutePathRefs', () => {
  it('substitutes inside flat strings', () => {
    const out = substitutePathRefs('${paths.sandbox}/sub', { sandbox: '/abs' });
    expect(out).toBe('/abs/sub');
  });

  it('walks nested objects without mutating the input', () => {
    const input = {
      command: 'echo ${paths.sandbox}',
      args: ['cd', '${paths.sandbox}/sub'],
      nested: { cwd: '${paths.sandbox}' },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = substitutePathRefs(input, { sandbox: '/abs' });
    expect(out).toEqual({
      command: 'echo /abs',
      args: ['cd', '/abs/sub'],
      nested: { cwd: '/abs' },
    });
    expect(input).toEqual(snapshot);
  });

  it('throws PathRefError on unknown ids', () => {
    expect(() => substitutePathRefs('${paths.typo}', { sandbox: '/abs' })).toThrow(
      PathRefError,
    );
  });

  it('handles multiple references in one string', () => {
    const out = substitutePathRefs(
      'cp ${paths.sandbox}/a ${paths.sandbox}/b',
      { sandbox: '/abs' },
    );
    expect(out).toBe('cp /abs/a /abs/b');
  });

  it('leaves strings without refs unchanged', () => {
    expect(substitutePathRefs('docker info', { sandbox: '/abs' })).toBe('docker info');
  });

  it('preserves non-string leaves (numbers, booleans, null)', () => {
    const out = substitutePathRefs(
      { timeout: 5000, enabled: true, missing: null, path: '${paths.sandbox}' },
      { sandbox: '/abs' },
    );
    expect(out).toEqual({ timeout: 5000, enabled: true, missing: null, path: '/abs' });
  });
});

describe('envVarsFor', () => {
  it('mirrors each id to ACC_PATHS_* and VITE_ACC_PATHS_*', () => {
    const env = envVarsFor({ sandbox: '/abs' });
    expect(env.ACC_PATHS_SANDBOX).toBe('/abs');
    expect(env.VITE_ACC_PATHS_SANDBOX).toBe('/abs');
  });

  it('upper-cases ids and rewrites - to _', () => {
    const env = envVarsFor({ 'sand-box-2': '/abs' });
    expect(env.ACC_PATHS_SAND_BOX_2).toBe('/abs');
    expect(env.VITE_ACC_PATHS_SAND_BOX_2).toBe('/abs');
  });

  it('returns an empty bag for an empty input', () => {
    expect(envVarsFor({})).toEqual({});
  });
});

describe('envFileContents', () => {
  it('emits KEY="value" lines with a trailing newline', () => {
    const out = envFileContents({ ACC_PATHS_SANDBOX: '/abs' });
    expect(out).toBe('ACC_PATHS_SANDBOX="/abs"\n');
  });

  it('escapes embedded double quotes and backslashes', () => {
    const out = envFileContents({ K: 'has "quotes" and \\back' });
    expect(out).toBe('K="has \\"quotes\\" and \\\\back"\n');
  });

  it('returns empty string for empty env', () => {
    expect(envFileContents({})).toBe('');
  });
});
