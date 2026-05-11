import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverCourses } from '../mcp/server/src/pluginsRoot.js';

interface FixtureCourse {
  pluginKey: string;
  pluginManifest: Record<string, unknown>;
  lessonsSubdir?: string;
  createLessonsDir?: boolean;
}

interface Fixture {
  installedPluginsFile: string;
  pluginDirs: Record<string, string>; // pluginKey -> install dir
  rootDir: string;
}

function makeFixture(courses: FixtureCourse[]): Fixture {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-plugins-'));
  const pluginsDir = path.join(rootDir, '.claude', 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  const pluginsField: Record<string, unknown> = {};
  const pluginDirs: Record<string, string> = {};

  for (const c of courses) {
    const installDir = path.join(pluginsDir, 'cache', c.pluginKey.replace('@', '_'));
    fs.mkdirSync(path.join(installDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(installDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify(c.pluginManifest, null, 2),
    );
    pluginDirs[c.pluginKey] = installDir;

    if (c.createLessonsDir !== false && c.lessonsSubdir) {
      const lessonsAbs = path.join(installDir, c.lessonsSubdir);
      fs.mkdirSync(lessonsAbs, { recursive: true });
    }

    pluginsField[c.pluginKey] = [
      {
        scope: 'user',
        installPath: installDir,
        version: '1.0.0',
        installedAt: '2026-04-23T00:00:00.000Z',
        lastUpdated: '2026-04-23T00:00:00.000Z',
      },
    ];
  }

  const installedPluginsFile = path.join(pluginsDir, 'installed_plugins.json');
  fs.writeFileSync(
    installedPluginsFile,
    JSON.stringify({ version: 2, plugins: pluginsField }, null, 2),
  );

  return { installedPluginsFile, pluginDirs, rootDir };
}

function cleanup(f: Fixture | undefined) {
  if (f) fs.rmSync(f.rootDir, { recursive: true, force: true });
}

describe('pluginsRoot.discoverCourses', () => {
  let fixture: Fixture | undefined;

  afterEach(() => {
    cleanup(fixture);
    fixture = undefined;
  });

  it('finds plugins that declare accContent.lessons', () => {
    fixture = makeFixture([
      {
        pluginKey: 'acc-deepbook-course@local',
        pluginManifest: {
          name: 'acc-deepbook-course',
          version: '0.1.0',
          accContent: { lessons: './lessons' },
        },
        lessonsSubdir: 'lessons',
      },
    ]);

    const result = discoverCourses({ installedPluginsFile: fixture.installedPluginsFile });

    expect(result.warnings).toEqual([]);
    expect(result.courses).toHaveLength(1);
    expect(result.courses[0].name).toBe('acc-deepbook-course@local');
    expect(result.courses[0].dir).toBe(fixture.pluginDirs['acc-deepbook-course@local']);
    expect(result.courses[0].lessonsRoot).toBe(
      path.join(fixture.pluginDirs['acc-deepbook-course@local'], 'lessons'),
    );
  });

  it('skips plugins that do not declare accContent', () => {
    fixture = makeFixture([
      {
        pluginKey: 'random-plugin@whatever',
        pluginManifest: {
          name: 'random-plugin',
          version: '1.0.0',
          // no accContent
          commands: ['./commands/foo.md'],
        },
      },
    ]);

    const result = discoverCourses({ installedPluginsFile: fixture.installedPluginsFile });

    expect(result.courses).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('returns plugins sorted by name for deterministic output', () => {
    fixture = makeFixture([
      {
        pluginKey: 'zeta-course@local',
        pluginManifest: { name: 'zeta', accContent: { lessons: './lessons' } },
        lessonsSubdir: 'lessons',
      },
      {
        pluginKey: 'alpha-course@local',
        pluginManifest: { name: 'alpha', accContent: { lessons: './lessons' } },
        lessonsSubdir: 'lessons',
      },
    ]);

    const result = discoverCourses({ installedPluginsFile: fixture.installedPluginsFile });

    expect(result.courses.map((c) => c.name)).toEqual([
      'alpha-course@local',
      'zeta-course@local',
    ]);
  });

  it('warns when accContent.lessons is missing or wrong type', () => {
    fixture = makeFixture([
      {
        pluginKey: 'broken-course@local',
        pluginManifest: {
          name: 'broken',
          accContent: { lessons: 123 }, // wrong type
        },
      },
    ]);

    const result = discoverCourses({ installedPluginsFile: fixture.installedPluginsFile });

    expect(result.courses).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].kind).toBe('course-plugin-acc-content-invalid');
    expect(result.warnings[0].pluginKey).toBe('broken-course@local');
  });

  it('warns when accContent.lessons escapes the plugin install dir', () => {
    fixture = makeFixture([
      {
        pluginKey: 'escapy-course@local',
        pluginManifest: {
          name: 'escapy',
          accContent: { lessons: '../../etc' },
        },
      },
    ]);

    const result = discoverCourses({ installedPluginsFile: fixture.installedPluginsFile });

    expect(result.courses).toEqual([]);
    expect(result.warnings.some((w) => w.kind === 'course-plugin-acc-content-invalid')).toBe(true);
  });

  it('warns when accContent.lessons points at a non-existent directory', () => {
    fixture = makeFixture([
      {
        pluginKey: 'no-dir-course@local',
        pluginManifest: {
          name: 'no-dir',
          accContent: { lessons: './lessons' },
        },
        createLessonsDir: false,
        lessonsSubdir: 'lessons',
      },
    ]);

    const result = discoverCourses({ installedPluginsFile: fixture.installedPluginsFile });

    expect(result.courses).toEqual([]);
    expect(result.warnings.some((w) => w.kind === 'course-plugin-lessons-missing')).toBe(true);
  });

  it('returns a warning when installed_plugins.json is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-empty-'));
    try {
      const result = discoverCourses({
        installedPluginsFile: path.join(tmpDir, 'nope.json'),
      });
      expect(result.courses).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('installed-plugins-missing');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns a warning when installed_plugins.json is malformed JSON', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-bad-'));
    try {
      const filePath = path.join(tmpDir, 'installed_plugins.json');
      fs.writeFileSync(filePath, '{not valid json');
      const result = discoverCourses({ installedPluginsFile: filePath });
      expect(result.courses).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].kind).toBe('installed-plugins-malformed');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('honors the ACC_INSTALLED_PLUGINS_FILE env var', () => {
    fixture = makeFixture([
      {
        pluginKey: 'env-course@local',
        pluginManifest: { name: 'env', accContent: { lessons: './lessons' } },
        lessonsSubdir: 'lessons',
      },
    ]);

    const prev = process.env.ACC_INSTALLED_PLUGINS_FILE;
    process.env.ACC_INSTALLED_PLUGINS_FILE = fixture.installedPluginsFile;
    try {
      const result = discoverCourses(); // no options — should pick up env
      expect(result.courses).toHaveLength(1);
      expect(result.courses[0].name).toBe('env-course@local');
    } finally {
      if (prev === undefined) delete process.env.ACC_INSTALLED_PLUGINS_FILE;
      else process.env.ACC_INSTALLED_PLUGINS_FILE = prev;
    }
  });
});
