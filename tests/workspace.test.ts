// F-005: workspace lifecycle tests
//
// Verifies prepareWorkspace's contract end-to-end with a hermetic basePath
// (mkdtemp under os.tmpdir) and a stubbed install command. Covers happy
// path, idempotent reuse, host-signature change → archive, missing
// host/starter, and the metadata atomic-write semantics.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  prepareWorkspace,
  resetWorkspace,
  loadWorkspaceMeta,
  WorkspacePrepareError,
  defaultWorkspaceBase,
} from '../mcp/server/src/workspace.js';
import type { PathData } from '../mcp/server/src/schemas/path.js';
import { WORKSPACE_META_SCHEMA_VERSION } from '../mcp/server/src/schemas/workspace.js';

let tempDirs: string[];

beforeEach(() => {
  tempDirs = [];
});

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  }
});

function makeTempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

function makeNoopSpawn(): any {
  return ((_cmd: string, _args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: (sig?: NodeJS.Signals) => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit('close', 0));
    return child;
  }) as any;
}

function makeFailingSpawn(exitCode: number): any {
  return ((_cmd: string, _args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: (sig?: NodeJS.Signals) => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('install boom'));
      child.emit('close', exitCode);
    });
    return child;
  }) as any;
}

/** Seed a path-content directory with a host dir + starter file. */
function seedPathContent(opts: {
  hostFiles?: Record<string, string>;
  starters?: Record<string, string>;
  description?: string;
}): { contentRoot: string } {
  const root = makeTempDir('workspace-test-content-');
  const hostDir = path.join(root, 'hosts', 'demo');
  fs.mkdirSync(hostDir, { recursive: true });

  const hostFiles = opts.hostFiles ?? {
    'package.json': JSON.stringify({ name: 'demo-host', private: true, type: 'module' }),
    'index.html': '<!doctype html><html></html>\n',
  };
  for (const [rel, content] of Object.entries(hostFiles)) {
    const abs = path.join(hostDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  const starters = opts.starters ?? {
    'starters/demo/App.tsx': '// starter content\n',
  };
  for (const [rel, content] of Object.entries(starters)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  return { contentRoot: root };
}

function makePathData(extra?: Partial<PathData>): PathData {
  return {
    slug: 'demo',
    title: 'Demo',
    summary: 'Demo path for tests',
    personalization_options: [],
    build_command: 'pnpm build',
    workspace: {
      host: 'hosts/demo',
      host_install_command: 'pnpm install',
      verification_cwd: '.',
      files: [{ path: 'src/App.tsx', starter: 'starters/demo/App.tsx' }],
    },
    ...extra,
  };
}

describe('prepareWorkspace — happy path', () => {
  it('creates the workspace dir, copies host + starter, writes metadata', async () => {
    const { contentRoot } = seedPathContent({});
    const basePath = makeTempDir('workspace-base-');
    const projectRoot = makeTempDir('workspace-proj-');
    const pathData = makePathData();

    const result = await prepareWorkspace(projectRoot, 'demo', pathData, {
      basePath,
      pathContentRoot: contentRoot,
      spawn: makeNoopSpawn(),
    });

    expect(result.created).toBe(true);
    expect(result.workspacePath).toBe(path.join(basePath, 'demo'));

    // Host files copied.
    expect(fs.existsSync(path.join(result.workspacePath, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspacePath, 'index.html'))).toBe(true);

    // Starter copied to declared workspace path.
    const appTsx = path.join(result.workspacePath, 'src', 'App.tsx');
    expect(fs.existsSync(appTsx)).toBe(true);
    expect(fs.readFileSync(appTsx, 'utf8')).toContain('starter content');

    // Metadata file present and valid.
    const meta = await loadWorkspaceMeta(result.workspacePath);
    expect(meta).toBeTruthy();
    expect(meta!.path_slug).toBe('demo');
    expect(meta!.starter_files).toContain('src/App.tsx');
    expect(meta!.host_signature.length).toBeGreaterThan(20);
    expect(meta!.schema_version).toBe(WORKSPACE_META_SCHEMA_VERSION);
  });
});

describe('prepareWorkspace — idempotent re-call', () => {
  it('returns created=false when host signature matches existing meta', async () => {
    const { contentRoot } = seedPathContent({});
    const basePath = makeTempDir('workspace-base-');
    const projectRoot = makeTempDir('workspace-proj-');
    const pathData = makePathData();

    const first = await prepareWorkspace(projectRoot, 'demo', pathData, {
      basePath,
      pathContentRoot: contentRoot,
      spawn: makeNoopSpawn(),
    });
    expect(first.created).toBe(true);

    // Mutate the workspace file the way a learner would — should NOT be
    // overwritten on re-prepare with matching signature.
    const learnerEdit = '// learner edit\n';
    fs.writeFileSync(path.join(first.workspacePath, 'src', 'App.tsx'), learnerEdit, 'utf8');

    const second = await prepareWorkspace(projectRoot, 'demo', pathData, {
      basePath,
      pathContentRoot: contentRoot,
      spawn: makeNoopSpawn(),
    });

    expect(second.created).toBe(false);
    expect(second.archivedTo).toBeUndefined();
    expect(fs.readFileSync(path.join(first.workspacePath, 'src', 'App.tsx'), 'utf8')).toBe(
      learnerEdit,
    );
  });
});

describe('prepareWorkspace — host signature change', () => {
  it('archives the previous workspace and recreates when host content changes', async () => {
    const { contentRoot } = seedPathContent({});
    const basePath = makeTempDir('workspace-base-');
    const projectRoot = makeTempDir('workspace-proj-');
    const pathData = makePathData();

    const first = await prepareWorkspace(projectRoot, 'demo', pathData, {
      basePath,
      pathContentRoot: contentRoot,
      spawn: makeNoopSpawn(),
    });
    expect(first.created).toBe(true);

    // Mutate the host (e.g. dependency bump) — signature changes.
    fs.writeFileSync(
      path.join(contentRoot, 'hosts', 'demo', 'package.json'),
      JSON.stringify({ name: 'demo-host', private: true, type: 'module', version: '0.0.1' }),
      'utf8',
    );

    const second = await prepareWorkspace(projectRoot, 'demo', pathData, {
      basePath,
      pathContentRoot: contentRoot,
      spawn: makeNoopSpawn(),
    });

    expect(second.created).toBe(true);
    expect(second.archivedTo).toBeTruthy();
    expect(fs.existsSync(second.archivedTo!)).toBe(true);
    // Archive sibling lives under the same base path.
    expect(path.dirname(second.archivedTo!)).toBe(basePath);
  });
});

describe('prepareWorkspace — error paths', () => {
  it('rejects with host-missing when the host directory does not exist', async () => {
    const contentRoot = makeTempDir('workspace-bad-');
    const basePath = makeTempDir('workspace-base-');
    const projectRoot = makeTempDir('workspace-proj-');
    const pathData = makePathData();

    await expect(
      prepareWorkspace(projectRoot, 'demo', pathData, {
        basePath,
        pathContentRoot: contentRoot,
        spawn: makeNoopSpawn(),
      }),
    ).rejects.toThrow(WorkspacePrepareError);
  });

  it('rejects with starter-missing when a declared starter file is absent', async () => {
    const { contentRoot } = seedPathContent({
      starters: { 'starters/something-else.tsx': '// not what is declared\n' },
    });
    const basePath = makeTempDir('workspace-base-');
    const projectRoot = makeTempDir('workspace-proj-');
    const pathData = makePathData();

    let err: unknown;
    try {
      await prepareWorkspace(projectRoot, 'demo', pathData, {
        basePath,
        pathContentRoot: contentRoot,
        spawn: makeNoopSpawn(),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WorkspacePrepareError);
    expect((err as WorkspacePrepareError).kind).toBe('starter-missing');
  });

  it('rejects with install-failed when the install command exits non-zero', async () => {
    const { contentRoot } = seedPathContent({});
    const basePath = makeTempDir('workspace-base-');
    const projectRoot = makeTempDir('workspace-proj-');
    const pathData = makePathData();

    let err: unknown;
    try {
      await prepareWorkspace(projectRoot, 'demo', pathData, {
        basePath,
        pathContentRoot: contentRoot,
        spawn: makeFailingSpawn(7),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WorkspacePrepareError);
    expect((err as WorkspacePrepareError).kind).toBe('install-failed');
  });

  it('rejects with invalid-config when path declares no workspace block', async () => {
    const projectRoot = makeTempDir('workspace-proj-');
    const pathData: PathData = {
      slug: 'no-ws',
      title: 'No Workspace',
      summary: 'no workspace declared',
      personalization_options: [],
      build_command: 'true',
    };

    let err: unknown;
    try {
      await prepareWorkspace(projectRoot, 'no-ws', pathData);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WorkspacePrepareError);
    expect((err as WorkspacePrepareError).kind).toBe('invalid-config');
  });
});

describe('prepareWorkspace — host_install_command optional', () => {
  it('skips install when host_install_command is undefined', async () => {
    const { contentRoot } = seedPathContent({});
    const basePath = makeTempDir('workspace-base-');
    const projectRoot = makeTempDir('workspace-proj-');
    const pathData = makePathData();
    delete pathData.workspace!.host_install_command;

    let spawnCalls = 0;
    const trackingSpawn = ((_cmd: string, _args: string[]) => {
      spawnCalls++;
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => child.emit('close', 0));
      return child;
    }) as any;

    const result = await prepareWorkspace(projectRoot, 'demo', pathData, {
      basePath,
      pathContentRoot: contentRoot,
      spawn: trackingSpawn,
    });
    expect(result.created).toBe(true);
    expect(spawnCalls).toBe(0);
  });
});

describe('saveWorkspaceMeta — atomic write', () => {
  it('writes via tmp + rename and refuses overwrite without the rename step', async () => {
    const { contentRoot } = seedPathContent({});
    const basePath = makeTempDir('workspace-base-');
    const projectRoot = makeTempDir('workspace-proj-');
    const pathData = makePathData();

    const result = await prepareWorkspace(projectRoot, 'demo', pathData, {
      basePath,
      pathContentRoot: contentRoot,
      spawn: makeNoopSpawn(),
    });

    const metaPath = path.join(result.workspacePath, '.course-state.json');
    const stat = fs.statSync(metaPath);
    expect(stat.isFile()).toBe(true);
    // mode 0o600 guarantee
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('resetWorkspace', () => {
  it('removes the workspace directory and any archived siblings', async () => {
    const { contentRoot } = seedPathContent({});
    const basePath = makeTempDir('workspace-base-');
    const projectRoot = makeTempDir('workspace-proj-');
    const pathData = makePathData();

    await prepareWorkspace(projectRoot, 'demo', pathData, {
      basePath,
      pathContentRoot: contentRoot,
      spawn: makeNoopSpawn(),
    });

    // Force a host change to produce an archive sibling.
    fs.writeFileSync(
      path.join(contentRoot, 'hosts', 'demo', 'index.html'),
      '<!doctype html><html><body>changed</body></html>\n',
      'utf8',
    );
    await prepareWorkspace(projectRoot, 'demo', pathData, {
      basePath,
      pathContentRoot: contentRoot,
      spawn: makeNoopSpawn(),
    });

    const before = fs.readdirSync(basePath);
    expect(before.some((n) => n === 'demo')).toBe(true);
    expect(before.some((n) => n.startsWith('demo.archive-'))).toBe(true);

    await resetWorkspace('demo', { basePath });

    const after = fs.readdirSync(basePath);
    expect(after.some((n) => n === 'demo')).toBe(false);
    expect(after.some((n) => n.startsWith('demo.archive-'))).toBe(false);
  });

  it('is a no-op when the workspace base does not exist', async () => {
    await expect(
      resetWorkspace('demo', { basePath: '/nonexistent/path/does/not/exist' }),
    ).resolves.toBeUndefined();
  });
});

describe('defaultWorkspaceBase', () => {
  it('returns ~/.sui-deepbook-course/workspaces under the user home', () => {
    const base = defaultWorkspaceBase();
    expect(base).toContain('.sui-deepbook-course');
    expect(base).toContain('workspaces');
    expect(base.startsWith(os.homedir())).toBe(true);
  });
});

describe('loadWorkspaceMeta — corrupt file handling', () => {
  it('returns null when the meta file has invalid JSON', async () => {
    const wsRoot = makeTempDir('workspace-corrupt-');
    await fsPromises.writeFile(
      path.join(wsRoot, '.course-state.json'),
      'not json {{{',
      'utf8',
    );
    const meta = await loadWorkspaceMeta(wsRoot);
    expect(meta).toBeNull();
  });

  it('returns null when the meta fails schema validation', async () => {
    const wsRoot = makeTempDir('workspace-bad-shape-');
    await fsPromises.writeFile(
      path.join(wsRoot, '.course-state.json'),
      JSON.stringify({ unrelated: 'object' }),
      'utf8',
    );
    const meta = await loadWorkspaceMeta(wsRoot);
    expect(meta).toBeNull();
  });

  it('returns null when the meta file is absent', async () => {
    const wsRoot = makeTempDir('workspace-absent-meta-');
    const meta = await loadWorkspaceMeta(wsRoot);
    expect(meta).toBeNull();
  });
});
