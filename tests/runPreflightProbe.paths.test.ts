import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPreflightProbe } from '../mcp/server/src/tools/runPreflightProbe.js';

interface Fixture {
  homeDir: string;
  installedPluginsFile: string;
  pluginDir: string;
  envFileBackup: string | undefined;
}

function buildFixture(opts: {
  pluginKey: string;
  paths: Array<{ id: string; default: string }>;
  probes: Array<Record<string, unknown>>;
}): Fixture {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-pre-paths-'));
  const pluginsDir = path.join(homeDir, '.claude', 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  const pluginDir = path.join(pluginsDir, 'cache', opts.pluginKey.replace('@', '_'));
  fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify(
      {
        name: opts.pluginKey,
        accContent: {
          lessons: './lessons',
          paths: opts.paths,
          probes: opts.probes,
        },
      },
      null,
      2,
    ),
  );
  fs.mkdirSync(path.join(pluginDir, 'lessons'));

  const installedPluginsFile = path.join(pluginsDir, 'installed_plugins.json');
  fs.writeFileSync(
    installedPluginsFile,
    JSON.stringify(
      {
        version: 2,
        plugins: {
          [opts.pluginKey]: [
            {
              scope: 'user',
              installPath: pluginDir,
              version: '0.1.0',
              installedAt: '2026-05-19T00:00:00.000Z',
              lastUpdated: '2026-05-19T00:00:00.000Z',
            },
          ],
        },
      },
      null,
      2,
    ),
  );

  return {
    homeDir,
    installedPluginsFile,
    pluginDir,
    envFileBackup: process.env.ACC_INSTALLED_PLUGINS_FILE,
  };
}

function withConfig(homeDir: string, config: Record<string, unknown>): void {
  const dir = path.join(homeDir, '.acc');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

describe('runPreflightProbe — ${paths.<id>} substitution', () => {
  let fixture: Fixture;

  afterEach(() => {
    if (fixture?.envFileBackup === undefined) delete process.env.ACC_INSTALLED_PLUGINS_FILE;
    else process.env.ACC_INSTALLED_PLUGINS_FILE = fixture.envFileBackup;
    if (fixture) fs.rmSync(fixture.homeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete process.env.ACC_INSTALLED_PLUGINS_FILE;
  });

  it('resolves ${paths.x} in probe params using the default precedence', async () => {
    const probeTargetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-sandbox-'));
    try {
      fixture = buildFixture({
        pluginKey: 'paths-course@local',
        paths: [{ id: 'sandbox', default: path.basename(probeTargetDir) }],
        probes: [
          {
            id: 'has-sandbox',
            kind: 'filesystem-exists',
            message_pass: 'present',
            message_fail: 'missing',
            params: { path: '${paths.sandbox}' },
          },
        ],
      });
      process.env.ACC_INSTALLED_PLUGINS_FILE = fixture.installedPluginsFile;
      // workspace_root = the tmp parent so the resolved path lands on the
      // real sandbox dir we created above.
      withConfig(fixture.homeDir, {
        workspace_root: path.dirname(probeTargetDir),
        course_paths: {},
      });

      const result = await runPreflightProbe({
        probeId: 'has-sandbox',
        homeDir: fixture.homeDir,
        probeOpts: {
          'has-sandbox': { homeDir: fixture.homeDir },
        },
      });

      expect(result.pass).toBe(true);
      expect(result.ownerCourse).toBe('paths-course@local');
    } finally {
      fs.rmSync(probeTargetDir, { recursive: true, force: true });
    }
  });

  it('honors a per-course path override', async () => {
    const probeTargetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-override-'));
    try {
      fixture = buildFixture({
        pluginKey: 'paths-course@local',
        paths: [{ id: 'sandbox', default: 'deepbook-sandbox' }],
        probes: [
          {
            id: 'has-sandbox',
            kind: 'filesystem-exists',
            message_pass: 'present',
            message_fail: 'missing',
            params: { path: '${paths.sandbox}' },
          },
        ],
      });
      process.env.ACC_INSTALLED_PLUGINS_FILE = fixture.installedPluginsFile;
      withConfig(fixture.homeDir, {
        workspace_root: '~/workspace',
        course_paths: {
          'paths-course@local': { sandbox: probeTargetDir },
        },
      });

      const result = await runPreflightProbe({
        probeId: 'has-sandbox',
        homeDir: fixture.homeDir,
      });

      expect(result.pass).toBe(true);
    } finally {
      fs.rmSync(probeTargetDir, { recursive: true, force: true });
    }
  });

  it('passes ACC_PATHS_* into the remediation child process env', async () => {
    fixture = buildFixture({
      pluginKey: 'paths-course@local',
      paths: [{ id: 'sandbox', default: 'will-be-overridden' }],
      probes: [
        {
          id: 'creates-sandbox',
          kind: 'filesystem-exists',
          message_pass: 'present',
          message_fail: 'missing',
          // Reference an id, and use the env var inside remediation.
          params: { path: '${paths.sandbox}/markerfile' },
          remediation: {
            // The literal "${paths.sandbox}" was already substituted before
            // shell sees the command. We also rely on `$ACC_PATHS_SANDBOX`
            // surviving via env.
            kind: 'shell',
            command:
              'mkdir -p "$ACC_PATHS_SANDBOX" && touch "$ACC_PATHS_SANDBOX/markerfile"',
            timeout_ms: 5000,
          },
        },
      ],
    });
    const overrideDir = path.join(fixture.homeDir, 'override-target');
    process.env.ACC_INSTALLED_PLUGINS_FILE = fixture.installedPluginsFile;
    withConfig(fixture.homeDir, {
      workspace_root: '~/workspace',
      course_paths: { 'paths-course@local': { sandbox: overrideDir } },
    });

    const result = await runPreflightProbe({
      probeId: 'creates-sandbox',
      remediate: true,
      homeDir: fixture.homeDir,
      probeOpts: { 'creates-sandbox': { homeDir: fixture.homeDir } },
    });
    expect(result.pass).toBe(true);
    expect(fs.existsSync(path.join(overrideDir, 'markerfile'))).toBe(true);
  });

  it('returns a clean error when the probe id is unknown', async () => {
    fixture = buildFixture({
      pluginKey: 'paths-course@local',
      paths: [],
      probes: [],
    });
    process.env.ACC_INSTALLED_PLUGINS_FILE = fixture.installedPluginsFile;
    const r = await runPreflightProbe({ probeId: 'nope', homeDir: fixture.homeDir });
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/Unknown probe id/);
  });
});
