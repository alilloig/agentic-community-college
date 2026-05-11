// F-001: resolve where path content (paths/<slug>/) actually lives.
//
// Before F-001, every tool read paths from `<projectRoot>/paths/`. That meant
// the course only worked when the user happened to be sitting inside the
// sui-mcp-course repo — a regression masked by the dev workflow.
//
// Resolution order (first match wins):
//   1. <projectRoot>/paths/ if it exists AND contains at least one
//      subdirectory (dev override — power user or in-repo iteration).
//   2. <pluginRoot>/paths/ where pluginRoot is derived from
//      fs.realpathSync(process.argv[1]) walked up to a directory whose
//      `.claude-plugin/plugin.json` exists. This is the production case
//      when Claude Code spawns the bundled MCP server from
//      `~/.claude/plugins/cache/.../mcp/server/dist/index.js`.
//   3. Fallback to <projectRoot>/paths/ even when absent — the registry
//      surfaces a `no-paths-dir` warning in that case.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedPluginRoot: string | null | undefined;

/**
 * Compute the plugin install root from `process.argv[1]` and / or
 * `import.meta.url`. Memoized — argv doesn't change at runtime.
 *
 * Returns null when the resolution can't anchor on a `.claude-plugin/plugin.json`
 * (dev runs via tsx/vitest, repos without the manifest, etc.).
 */
export function derivePluginRoot(): string | null {
  if (cachedPluginRoot !== undefined) return cachedPluginRoot;
  cachedPluginRoot = computePluginRoot();
  return cachedPluginRoot;
}

/** Reset the memoized result. Test seam — production never calls this. */
export function _resetPluginRootCache(): void {
  cachedPluginRoot = undefined;
}

function computePluginRoot(): string | null {
  // Try argv[1] first — that's the entry script Claude Code spawns.
  const candidates: string[] = [];
  if (process.argv[1]) {
    try {
      candidates.push(fs.realpathSync(process.argv[1]));
    } catch {
      /* ignore */
    }
  }
  // Also try import.meta.url's resolved path. When running unbundled (tsx,
  // vitest), this points at the source `mcp/server/src/pathsRoot.ts`, which
  // anchors at the same plugin root. When running bundled, it matches argv[1]
  // and dedupes naturally below.
  try {
    candidates.push(fs.realpathSync(fileURLToPath(import.meta.url)));
  } catch {
    /* ignore */
  }

  for (const candidate of candidates) {
    const root = walkToManifest(candidate);
    if (root) return root;
  }
  return null;
}

function walkToManifest(start: string): string | null {
  let dir = path.dirname(start);
  // Walk up at most 8 levels — far enough for `mcp/server/dist/index.js`
  // and similar; cheap to bound.
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve where to look for path content. Always returns a path; callers
 * should still handle the registry's `no-paths-dir` warning when the chosen
 * root doesn't actually exist.
 */
export function resolvePathsRoot(projectRoot: string): string {
  const projectPaths = path.join(projectRoot, 'paths');
  if (hasPathSubdir(projectPaths)) {
    return projectPaths;
  }
  const pluginRoot = derivePluginRoot();
  if (pluginRoot) {
    return path.join(pluginRoot, 'paths');
  }
  return projectPaths;
}

/**
 * Resolve `paths/<slug>/` for a specific slug. Mirrors `resolvePathsRoot`
 * for callers that already know the slug they want — avoids the `path.join`
 * boilerplate at every call site.
 */
export function resolvePathContentRoot(projectRoot: string, slug: string): string {
  return path.join(resolvePathsRoot(projectRoot), slug);
}

function hasPathSubdir(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.some((e) => e.isDirectory());
  } catch {
    return false;
  }
}
