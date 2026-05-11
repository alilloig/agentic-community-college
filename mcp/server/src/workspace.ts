// Lesson workspace lifecycle.
//
// Each path with a workspace block in path.json gets a course-managed
// workspace under ~/.sui-deepbook-course/workspaces/<slug>/. The workspace is:
//   - seeded with the path's host directory (package.json, vite.config.ts,
//     tsconfig*, index.html, src/main.tsx, etc.)
//   - populated with starter files declared in path.json workspace.files[]
//   - tagged with a .course-state.json metadata file that fingerprints the
//     host tarball; re-running prepareWorkspace with a matching fingerprint
//     no-ops, while a mismatch archives the old workspace and rebuilds.
//   - optionally bootstrapped with `pnpm install` (or whatever
//     workspace.host_install_command declares) on first creation.
//
// Tools resolve verifySpot's cwd, target_file_absolute, and rung-3 auto-write
// targets through this module; the workspace is the only filesystem location
// the lesson code edits.

import * as fsPromises from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { spawn as defaultSpawn, type SpawnOptions } from 'node:child_process';
import type { PathData } from './schemas/path.js';
import { validateWorkspaceMeta, WORKSPACE_META_SCHEMA_VERSION } from './schemas/workspace.js';
import type { WorkspaceMeta } from './schemas/workspace.js';
import { resolvePathContentRoot } from './pathsRoot.js';

export type { WorkspaceMeta };

const WORKSPACE_META_FILE = '.course-state.json';
const DEFAULT_INSTALL_TIMEOUT_MS = 600_000; // 10 minutes
const HOST_INSTALL_BACKOFF_MS = 250;

export interface WorkspaceOptions {
  /** Override for the workspace base directory. Defaults to
   * ~/.sui-deepbook-course/workspaces. Tests redirect this to a tmpdir. */
  basePath?: string;
  /** Override for the install command spawn. Tests stub this; production
   * leaves it undefined and we fall back to node:child_process.spawn. */
  spawn?: typeof defaultSpawn;
  /** Override for the path-content root used to resolve `host` and `starter`
   * paths. Defaults to <projectRoot>/paths/<slug>. Tests override this to
   * point at fixtures. */
  pathContentRoot?: string;
}

export interface PrepareWorkspaceResult {
  workspacePath: string;
  /** True when prepareWorkspace seeded a fresh workspace (or replaced a
   * stale one). False when an existing workspace's host_signature matched
   * and was reused. */
  created: boolean;
  /** Populated when an existing workspace was archived to make room for a
   * new one (host_signature mismatch). The archived path lives next to the
   * workspace as <workspace>.archive-<ts>/. */
  archivedTo?: string;
  /** Captured stdout/stderr lines from the install command, if any ran. */
  installLogs?: string[];
}

export class WorkspacePrepareError extends Error {
  constructor(
    public readonly kind:
      | 'host-missing'
      | 'starter-missing'
      | 'install-failed'
      | 'install-timeout'
      | 'install-spawn-failed'
      | 'meta-write-failed'
      | 'archive-failed'
      | 'invalid-config',
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WorkspacePrepareError';
  }
}

export function defaultWorkspaceBase(): string {
  return path.join(os.homedir(), '.sui-deepbook-course', 'workspaces');
}

export function getWorkspacePath(slug: string, opts: WorkspaceOptions = {}): string {
  const base = opts.basePath ?? defaultWorkspaceBase();
  return path.join(base, slug);
}

/**
 * Idempotent: if an existing workspace's .course-state.json matches the
 * current host tarball signature, reuse it. Otherwise archive and recreate.
 */
export async function prepareWorkspace(
  projectRoot: string,
  slug: string,
  pathData: PathData,
  opts: WorkspaceOptions = {},
): Promise<PrepareWorkspaceResult> {
  if (!pathData.workspace) {
    throw new WorkspacePrepareError(
      'invalid-config',
      `Path '${slug}' declares no workspace block; cannot prepare workspace.`,
    );
  }

  const workspacePath = getWorkspacePath(slug, opts);
  const pathContentRoot = opts.pathContentRoot ?? resolvePathContentRoot(projectRoot, slug);
  const hostDir = path.join(pathContentRoot, pathData.workspace.host);

  // 1. Compute the current host signature from the path's host directory.
  let hostSignature: string;
  try {
    hostSignature = await hashDirectoryTree(hostDir);
  } catch (err) {
    throw new WorkspacePrepareError(
      'host-missing',
      `Host directory missing or unreadable: ${hostDir}: ${(err as Error).message}`,
      err,
    );
  }

  // 2. If existing workspace metadata matches, reuse.
  const existingMeta = await tryLoadWorkspaceMeta(workspacePath);
  if (existingMeta && existingMeta.host_signature === hostSignature && existingMeta.path_slug === slug) {
    return { workspacePath, created: false };
  }

  // 3. Existing workspace differs (or is corrupt). Archive if it exists.
  let archivedTo: string | undefined;
  if (await pathExists(workspacePath)) {
    archivedTo = `${workspacePath}.archive-${Date.now()}`;
    try {
      await fsPromises.rename(workspacePath, archivedTo);
    } catch (err) {
      throw new WorkspacePrepareError(
        'archive-failed',
        `Failed to archive existing workspace at ${workspacePath}: ${(err as Error).message}`,
        err,
      );
    }
  }

  // 4. Mint a new workspace.
  await fsPromises.mkdir(workspacePath, { recursive: true });

  // 4a. Seed host tree.
  await copyDirectoryTree(hostDir, workspacePath);

  // 4b. Copy starter files into their declared workspace paths.
  const starterFiles: string[] = [];
  for (const file of pathData.workspace.files) {
    const starterAbs = path.join(pathContentRoot, file.starter);
    const targetAbs = path.join(workspacePath, file.path);
    if (!(await pathExists(starterAbs))) {
      throw new WorkspacePrepareError(
        'starter-missing',
        `Starter file missing: ${starterAbs}`,
      );
    }
    await fsPromises.mkdir(path.dirname(targetAbs), { recursive: true });
    await fsPromises.copyFile(starterAbs, targetAbs);
    starterFiles.push(file.path);
  }

  // 4c. Run host install command if declared.
  let installLogs: string[] | undefined;
  if (pathData.workspace.host_install_command) {
    installLogs = await runHostInstall(
      pathData.workspace.host_install_command,
      workspacePath,
      opts,
    );
  }

  // 4d. Write metadata atomically.
  const meta: WorkspaceMeta = {
    schema_version: WORKSPACE_META_SCHEMA_VERSION,
    path_slug: slug,
    created_at: new Date().toISOString(),
    starter_files: starterFiles,
    host_signature: hostSignature,
  };
  try {
    await saveWorkspaceMeta(workspacePath, meta);
  } catch (err) {
    throw new WorkspacePrepareError(
      'meta-write-failed',
      `Failed to write workspace metadata: ${(err as Error).message}`,
      err,
    );
  }

  const result: PrepareWorkspaceResult = { workspacePath, created: true };
  if (archivedTo !== undefined) result.archivedTo = archivedTo;
  if (installLogs !== undefined) result.installLogs = installLogs;
  return result;
}

/** Removes the workspace directory entirely and any archived siblings. */
export async function resetWorkspace(slug: string, opts: WorkspaceOptions = {}): Promise<void> {
  const workspacePath = getWorkspacePath(slug, opts);
  const parent = path.dirname(workspacePath);
  if (!(await pathExists(parent))) return;
  let entries: fs.Dirent[];
  try {
    entries = await fsPromises.readdir(parent, { withFileTypes: true });
  } catch {
    return;
  }
  const slugBasename = path.basename(workspacePath);
  for (const e of entries) {
    if (e.name === slugBasename || e.name.startsWith(`${slugBasename}.archive-`)) {
      await fsPromises.rm(path.join(parent, e.name), { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Metadata I/O — atomic, mirroring state.ts:saveState semantics.
// ---------------------------------------------------------------------------

export async function loadWorkspaceMeta(workspacePath: string): Promise<WorkspaceMeta | null> {
  return tryLoadWorkspaceMeta(workspacePath);
}

async function tryLoadWorkspaceMeta(workspacePath: string): Promise<WorkspaceMeta | null> {
  const metaPath = path.join(workspacePath, WORKSPACE_META_FILE);
  let raw: string;
  try {
    raw = await fsPromises.readFile(metaPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const validation = validateWorkspaceMeta(parsed);
  if (!validation.ok) return null;
  return validation.value;
}

export async function saveWorkspaceMeta(workspacePath: string, meta: WorkspaceMeta): Promise<void> {
  await fsPromises.mkdir(workspacePath, { recursive: true });
  const metaPath = path.join(workspacePath, WORKSPACE_META_FILE);
  const tmpPath = path.join(
    workspacePath,
    `.course-state.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  const bytes = JSON.stringify(meta, null, 2);
  await fsPromises.writeFile(tmpPath, bytes, { flag: 'wx', mode: 0o600 });
  const handle = await fsPromises.open(tmpPath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsPromises.rename(tmpPath, metaPath);
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsPromises.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDirectoryTree(src: string, dest: string): Promise<void> {
  await fsPromises.cp(src, dest, { recursive: true });
}

/**
 * Compute a deterministic sha256 fingerprint over the contents of a directory
 * tree. We hash relative paths + file bodies in sorted order so a rename or
 * content edit anywhere under `dir` produces a different signature.
 */
async function hashDirectoryTree(dir: string): Promise<string> {
  const entries = await collectFiles(dir, '');
  entries.sort();
  const hash = crypto.createHash('sha256');
  for (const rel of entries) {
    hash.update(rel);
    hash.update('\0');
    const buf = await fsPromises.readFile(path.join(dir, rel));
    hash.update(buf);
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function collectFiles(root: string, sub: string): Promise<string[]> {
  const here = path.join(root, sub);
  const entries = await fsPromises.readdir(here, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const rel = sub ? path.join(sub, e.name) : e.name;
    if (e.isDirectory()) {
      // Skip node_modules — the host tarball is config + thin source only.
      // Including it would bloat the signature and the seeded copy.
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.vitest-cache') {
        continue;
      }
      out.push(...(await collectFiles(root, rel)));
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Install command runner — bounded timeout, structured errors.
// ---------------------------------------------------------------------------

async function runHostInstall(
  command: string,
  cwd: string,
  opts: WorkspaceOptions,
): Promise<string[]> {
  const spawnFn = opts.spawn ?? defaultSpawn;
  const [bin, ...args] = command.split(/\s+/).filter((s) => s.length > 0);
  if (!bin) {
    throw new WorkspacePrepareError('invalid-config', `Empty host_install_command`);
  }

  const logs: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawnFn(bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    } as SpawnOptions);

    let resolved = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 5000);
    }, DEFAULT_INSTALL_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.length > 0) logs.push(line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.length > 0) logs.push(line);
      }
    });

    child.on('error', (err: Error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(
        new WorkspacePrepareError(
          'install-spawn-failed',
          `Failed to spawn '${command}' in ${cwd}: ${err.message}`,
          err,
        ),
      );
    });

    child.on('close', (code: number | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new WorkspacePrepareError(
            'install-timeout',
            `Host install '${command}' timed out after ${DEFAULT_INSTALL_TIMEOUT_MS}ms in ${cwd}`,
          ),
        );
        return;
      }
      if (code !== 0) {
        const tail = logs.slice(-20).join('\n');
        reject(
          new WorkspacePrepareError(
            'install-failed',
            `Host install '${command}' exited ${code} in ${cwd}. Last logs:\n${tail}`,
          ),
        );
        return;
      }
      // Tiny tail-flush window so any final stdout from a fast-exiting child
      // isn't dropped between 'close' and the resolve callback.
      setTimeout(() => resolve(), HOST_INSTALL_BACKOFF_MS);
    });
  });

  return logs;
}
