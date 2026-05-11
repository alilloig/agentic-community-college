import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runDynamicProbe,
  expandUserPath,
  type FetchLike,
} from '../mcp/server/src/dynamicProbes.js';
import type { CourseProbeDecl } from '../mcp/server/src/schemas/courseProbes.js';

describe('expandUserPath', () => {
  it('resolves bare ~ to homedir', () => {
    const r = expandUserPath('~', '/Users/test');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.abs).toBe('/Users/test');
  });

  it('resolves ~/foo to homedir/foo', () => {
    const r = expandUserPath('~/foo/bar', '/Users/test');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.abs).toBe('/Users/test/foo/bar');
  });

  it('accepts absolute paths', () => {
    const r = expandUserPath('/etc/hosts', '/Users/test');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.abs).toBe('/etc/hosts');
  });

  it('rejects relative paths', () => {
    const r = expandUserPath('relative/path', '/Users/test');
    expect(r.ok).toBe(false);
  });

  it('rejects empty path', () => {
    const r = expandUserPath('', '/Users/test');
    expect(r.ok).toBe(false);
  });
});

describe('runDynamicProbe — filesystem-exists', () => {
  it('passes when the path exists', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-probe-'));
    try {
      const decl: CourseProbeDecl = {
        id: 'fs',
        kind: 'filesystem-exists',
        message_pass: 'ok',
        message_fail: 'missing',
        params: { path: tmp },
      };
      const r = await runDynamicProbe(decl);
      expect(r.pass).toBe(true);
      expect(r.message).toBe('ok');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('fails when the path does not exist; surfaces remediation', async () => {
    const decl: CourseProbeDecl = {
      id: 'fs',
      kind: 'filesystem-exists',
      message_pass: 'ok',
      message_fail: 'missing',
      params: { path: '/very/unlikely/to/exist/acc-probe-test' },
      remediation: { kind: 'shell', command: 'mkdir -p /tmp/acc-test', timeout_ms: 5000 },
    };
    const r = await runDynamicProbe(decl);
    expect(r.pass).toBe(false);
    expect(r.action?.command).toBe('mkdir -p /tmp/acc-test');
  });
});

describe('runDynamicProbe — http-get', () => {
  function makeFetch(
    status: number,
    body = '',
  ): FetchLike {
    return async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    });
  }

  it('passes on expected status', async () => {
    const decl: CourseProbeDecl = {
      id: 'http',
      kind: 'http-get',
      message_pass: 'alive',
      message_fail: 'down',
      params: { url: 'http://example.test/', expected_status: 200 },
    };
    const r = await runDynamicProbe(decl, { fetch: makeFetch(200) });
    expect(r.pass).toBe(true);
  });

  it('fails on wrong status', async () => {
    const decl: CourseProbeDecl = {
      id: 'http',
      kind: 'http-get',
      message_pass: 'alive',
      message_fail: 'down',
      params: { url: 'http://example.test/', expected_status: 200 },
    };
    const r = await runDynamicProbe(decl, { fetch: makeFetch(503) });
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/HTTP 503/);
  });

  it('checks expected_body_regex when supplied', async () => {
    const decl: CourseProbeDecl = {
      id: 'http',
      kind: 'http-get',
      message_pass: 'has-marker',
      message_fail: 'missing-marker',
      params: { url: 'http://example.test/', expected_body_regex: 'GOOD' },
    };
    expect((await runDynamicProbe(decl, { fetch: makeFetch(200, 'is GOOD') })).pass).toBe(true);
    expect((await runDynamicProbe(decl, { fetch: makeFetch(200, 'is bad') })).pass).toBe(false);
  });

  it('fails on fetch error with the configured remediation', async () => {
    const decl: CourseProbeDecl = {
      id: 'http',
      kind: 'http-get',
      message_pass: 'alive',
      message_fail: 'down',
      params: { url: 'http://example.test/' },
      remediation: { kind: 'shell', command: 'pnpm deploy-all --quick' },
    };
    const throwingFetch: FetchLike = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const r = await runDynamicProbe(decl, { fetch: throwingFetch });
    expect(r.pass).toBe(false);
    expect(r.action?.command).toBe('pnpm deploy-all --quick');
  });
});

describe('runDynamicProbe — shell-exit-zero', () => {
  it('passes when spawn returns status 0', async () => {
    const decl: CourseProbeDecl = {
      id: 'sh',
      kind: 'shell-exit-zero',
      message_pass: 'installed',
      message_fail: 'missing',
      params: { command: 'fake-binary' },
    };
    const r = await runDynamicProbe(decl, {
      spawn: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    expect(r.pass).toBe(true);
  });

  it('fails on non-zero exit', async () => {
    const decl: CourseProbeDecl = {
      id: 'sh',
      kind: 'shell-exit-zero',
      message_pass: 'a',
      message_fail: 'b',
      params: { command: 'fake' },
    };
    const r = await runDynamicProbe(decl, {
      spawn: () => ({ status: 127, stdout: '', stderr: 'not found' }),
    });
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/exit 127/);
  });

  it('enforces expected_stdout_regex', async () => {
    const decl: CourseProbeDecl = {
      id: 'sh',
      kind: 'shell-exit-zero',
      message_pass: 'a',
      message_fail: 'b',
      params: { command: 'node', expected_stdout_regex: '^v\\d+' },
    };
    expect(
      (await runDynamicProbe(decl, {
        spawn: () => ({ status: 0, stdout: 'v20.10.0', stderr: '' }),
      })).pass,
    ).toBe(true);
    expect(
      (await runDynamicProbe(decl, {
        spawn: () => ({ status: 0, stdout: 'old', stderr: '' }),
      })).pass,
    ).toBe(false);
  });
});

describe('runDynamicProbe — claude-plugin-enabled', () => {
  it('passes when the plugin is true in settings.json', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-settings-'));
    try {
      const claudeDir = path.join(home, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, 'settings.json'),
        JSON.stringify({ enabledPlugins: { 'sui-pilot@x': true } }),
      );
      const decl: CourseProbeDecl = {
        id: 'plug',
        kind: 'claude-plugin-enabled',
        message_pass: 'enabled',
        message_fail: 'disabled',
        params: { plugin_key: 'sui-pilot@x' },
      };
      const r = await runDynamicProbe(decl, { homeDir: home });
      expect(r.pass).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('fails when the plugin is missing/false', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-settings-'));
    try {
      const claudeDir = path.join(home, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, 'settings.json'),
        JSON.stringify({ enabledPlugins: {} }),
      );
      const decl: CourseProbeDecl = {
        id: 'plug',
        kind: 'claude-plugin-enabled',
        message_pass: 'enabled',
        message_fail: 'disabled',
        params: { plugin_key: 'sui-pilot@x' },
      };
      const r = await runDynamicProbe(decl, { homeDir: home });
      expect(r.pass).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('fails when settings.json is missing', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-empty-home-'));
    try {
      const decl: CourseProbeDecl = {
        id: 'plug',
        kind: 'claude-plugin-enabled',
        message_pass: 'enabled',
        message_fail: 'disabled',
        params: { plugin_key: 'whatever' },
      };
      const r = await runDynamicProbe(decl, { homeDir: home });
      expect(r.pass).toBe(false);
      expect(r.message).toMatch(/settings\.json not found/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
