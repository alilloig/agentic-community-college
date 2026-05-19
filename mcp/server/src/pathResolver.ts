// pathResolver.ts — resolves declared `accContent.paths` to absolute paths
// per the two-tier precedence chain, substitutes `${paths.<id>}` references
// in probe params + remediation fields, and builds the env-var bag injected
// into spawned children.
//
// Precedence:
//   1. user override:   config.course_paths[plugin][id]
//   2. derived default: ${workspace_root}/${manifest.paths[id].default}
//
// AC-6.3 invariant: this module is the ONLY path-substitution channel. It is
// independent of `personalization.substitutePromptOnly`, which still owns
// `{{ ... }}` substitution in section bodies. Never mix the two.

import * as os from 'node:os';
import * as path from 'node:path';
import type { ContentPathDecl } from './schemas/contentPaths.js';
import { PATHS_REF_RE } from './schemas/contentPaths.js';
import type { AccConfig } from './settings.js';

/** Resolved id → absolute path map. */
export type ResolvedPaths = Record<string, string>;

export class PathRefError extends Error {
  constructor(
    public readonly token: string,
    public readonly id: string,
    message: string,
  ) {
    super(message);
    this.name = 'PathRefError';
  }
}

function expandHome(p: string, homeDir: string): string {
  if (p === '~') return homeDir;
  if (p.startsWith('~/')) return path.join(homeDir, p.slice(2));
  return p;
}

/**
 * Resolve every declared path id to an absolute filesystem path. Applies
 * the precedence chain documented above. Returns an empty object when the
 * manifest declares zero paths — callers may then short-circuit substitution.
 *
 * Does NOT touch the filesystem: an override pointing at a non-existent dir
 * is returned as-is. The whole point of `${paths.sandbox}` is to feed
 * probes/remediations that may then create the missing directory.
 */
export function resolveCoursePaths(
  pluginName: string,
  manifestPaths: readonly ContentPathDecl[],
  config: AccConfig,
  homeDir: string = os.homedir(),
): ResolvedPaths {
  const workspaceRoot = expandHome(config.workspace_root, homeDir);
  const overrides = config.course_paths[pluginName] ?? {};
  const out: ResolvedPaths = {};
  for (const decl of manifestPaths) {
    const override = overrides[decl.id];
    if (typeof override === 'string' && override.length > 0) {
      out[decl.id] = path.resolve(expandHome(override, homeDir));
    } else {
      out[decl.id] = path.resolve(workspaceRoot, decl.default);
    }
  }
  return out;
}

/**
 * Recursively walk a value, replacing every `${paths.<id>}` token inside any
 * string leaf with its resolved absolute path. Objects/arrays are rebuilt so
 * the input is not mutated. Unknown ids throw `PathRefError` — schema
 * validation should have caught this at manifest load, so a throw here means
 * either a bug or a stale registry.
 */
export function substitutePathRefs<T>(value: T, paths: ResolvedPaths): T {
  return walk(value, paths) as T;
}

function walk(v: unknown, paths: ResolvedPaths): unknown {
  if (typeof v === 'string') return substituteString(v, paths);
  if (Array.isArray(v)) return v.map((item) => walk(item, paths));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = walk(val, paths);
    }
    return out;
  }
  return v;
}

function substituteString(s: string, paths: ResolvedPaths): string {
  // Reset lastIndex defensively in case the caller holds the regex elsewhere.
  PATHS_REF_RE.lastIndex = 0;
  return s.replace(PATHS_REF_RE, (token, id: string) => {
    if (Object.prototype.hasOwnProperty.call(paths, id)) {
      return paths[id] as string;
    }
    const declared = Object.keys(paths).sort().join(', ') || '(none declared)';
    throw new PathRefError(
      token,
      id,
      `Unresolved path reference ${token}: id '${id}' is not declared on this manifest (declared: ${declared}).`,
    );
  });
}

/**
 * Convert a resolved-paths map into the env-var bag injected into spawned
 * children. Each id produces TWO entries — the raw name and a `VITE_`-prefixed
 * mirror so a Vite-built reference app gets the value at build time without
 * the course author having to know about the prefix.
 *
 * Ids are upper-cased and `-` is replaced with `_` so a declared
 * <code>foo-bar</code> becomes <code>ACC_PATHS_FOO_BAR</code>.
 */
export function envVarsFor(paths: ResolvedPaths): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [id, abs] of Object.entries(paths)) {
    const upper = id.replace(/-/g, '_').toUpperCase();
    env[`ACC_PATHS_${upper}`] = abs;
    env[`VITE_ACC_PATHS_${upper}`] = abs;
  }
  return env;
}

/**
 * Serialize the env bag as a dotenv-style file body. Used by `prepareWorkspace`
 * to drop a `.env.acc-paths` next to the seeded reference app so a course's
 * dev script can `source` it without taking a dependency on ACC itself.
 *
 * Values are wrapped in double-quotes and any embedded `"` is escaped so paths
 * with spaces (rare on dev boxes, but legal on macOS) survive a literal
 * source-then-use round trip.
 */
export function envFileContents(envBag: Record<string, string>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(envBag)) {
    const escaped = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push(`${k}="${escaped}"`);
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}
