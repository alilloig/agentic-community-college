import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  prepareWorkspace,
  PATH_ENV_FILE,
  type WorkspaceOptions,
} from '../mcp/server/src/workspace.js';
import type { LessonData } from '../mcp/server/src/schemas/lesson.js';

interface SeedResult {
  basePath: string;
  lessonDir: string;
  hostDir: string;
}

function seedFixture(): SeedResult {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-ws-paths-base-'));
  const lessonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-ws-paths-lesson-'));
  const hostDir = path.join(lessonDir, 'host');
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(path.join(hostDir, 'package.json'), '{"name":"host"}');
  return { basePath, lessonDir, hostDir };
}

function lessonWith(installCmd?: string): LessonData {
  const lesson: LessonData = {
    slug: 'paths-lesson',
    title: 'paths-lesson',
    summary: 's',
    personalization_options: [],
    build_command: 'echo build',
    workspace: { files: [], host: 'host' },
  };
  if (installCmd !== undefined) {
    lesson.workspace = { ...lesson.workspace!, host_install_command: installCmd };
  }
  return lesson;
}

let seeds: SeedResult[];

beforeEach(() => {
  seeds = [];
});

afterEach(() => {
  for (const s of seeds) {
    fs.rmSync(s.basePath, { recursive: true, force: true });
    fs.rmSync(s.lessonDir, { recursive: true, force: true });
  }
});

describe('prepareWorkspace — pathEnv injection', () => {
  it('writes .env.acc-paths with the resolved bag', async () => {
    const seed = seedFixture();
    seeds.push(seed);

    const result = await prepareWorkspace(
      'paths-lesson',
      seed.lessonDir,
      lessonWith(),
      {
        basePath: seed.basePath,
        pathEnv: { ACC_PATHS_SANDBOX: '/abs/sb', VITE_ACC_PATHS_SANDBOX: '/abs/sb' },
      },
    );

    const envFile = path.join(result.workspacePath, PATH_ENV_FILE);
    expect(fs.existsSync(envFile)).toBe(true);
    const body = fs.readFileSync(envFile, 'utf8');
    expect(body).toMatch(/ACC_PATHS_SANDBOX="\/abs\/sb"/);
    expect(body).toMatch(/VITE_ACC_PATHS_SANDBOX="\/abs\/sb"/);
  });

  it('omits .env.acc-paths when pathEnv is absent or empty', async () => {
    const seed = seedFixture();
    seeds.push(seed);
    const result = await prepareWorkspace('paths-lesson', seed.lessonDir, lessonWith(), {
      basePath: seed.basePath,
    });
    const envFile = path.join(result.workspacePath, PATH_ENV_FILE);
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it('unlinks a stale .env.acc-paths when reused with an empty pathEnv', async () => {
    const seed = seedFixture();
    seeds.push(seed);

    // First prep with paths declared.
    const first = await prepareWorkspace('paths-lesson', seed.lessonDir, lessonWith(), {
      basePath: seed.basePath,
      pathEnv: { ACC_PATHS_SANDBOX: '/abs/sb' },
    });
    expect(fs.existsSync(path.join(first.workspacePath, '.env.acc-paths'))).toBe(true);

    // Second prep — course removed its paths block (empty pathEnv).
    const second = await prepareWorkspace('paths-lesson', seed.lessonDir, lessonWith(), {
      basePath: seed.basePath,
      pathEnv: {},
    });
    expect(second.created).toBe(false);
    expect(fs.existsSync(path.join(second.workspacePath, '.env.acc-paths'))).toBe(false);
  });

  it('re-writes .env.acc-paths even when reusing an existing workspace', async () => {
    const seed = seedFixture();
    seeds.push(seed);

    // First prep: write env A.
    const first = await prepareWorkspace('paths-lesson', seed.lessonDir, lessonWith(), {
      basePath: seed.basePath,
      pathEnv: { ACC_PATHS_SANDBOX: '/first' },
    });
    expect(first.created).toBe(true);

    // Second prep with same lesson: should reuse the workspace but rewrite env.
    const second = await prepareWorkspace('paths-lesson', seed.lessonDir, lessonWith(), {
      basePath: seed.basePath,
      pathEnv: { ACC_PATHS_SANDBOX: '/second' },
    });
    expect(second.created).toBe(false);
    const body = fs.readFileSync(path.join(second.workspacePath, PATH_ENV_FILE), 'utf8');
    expect(body).toMatch(/\/second/);
    expect(body).not.toMatch(/\/first/);
  });

  it('merges pathEnv into the host_install_command spawn env', async () => {
    const seed = seedFixture();
    seeds.push(seed);

    let observedEnv: NodeJS.ProcessEnv | undefined;
    const stubSpawn: WorkspaceOptions['spawn'] = ((
      _bin: string,
      _args: readonly string[],
      options: { env?: NodeJS.ProcessEnv },
    ) => {
      observedEnv = options.env;
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (sig: NodeJS.Signals) => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => child.emit('close', 0));
      return child as unknown as ReturnType<NonNullable<WorkspaceOptions['spawn']>>;
    }) as unknown as WorkspaceOptions['spawn'];

    await prepareWorkspace('paths-lesson', seed.lessonDir, lessonWith('pnpm install'), {
      basePath: seed.basePath,
      pathEnv: { ACC_PATHS_SANDBOX: '/abs/sb' },
      spawn: stubSpawn,
    });

    expect(observedEnv).toBeDefined();
    expect(observedEnv!.ACC_PATHS_SANDBOX).toBe('/abs/sb');
    // Sanity: still inherits PATH from the parent.
    expect(typeof observedEnv!.PATH).toBe('string');
  });
});
