// contentPaths.ts — validator for `accContent.paths` declarations.
//
// Each course plugin may declare a list of named filesystem paths students
// can override via `~/.acc/config.json`. Probe `params`, `remediation.command`,
// and `remediation.cwd` can reference these paths with `${paths.<id>}` —
// substitution happens before the probe runner sees the params, never via
// the personalization `{{ ... }}` channel (AC-6.3 invariant preserved).
//
// Style mirrors `courseProbes.ts` / `lesson.ts`: hand-written validators,
// `{ ok, value | error }` envelope, no zod.

import type { CourseProbeDecl } from './courseProbes.js';

export interface ContentPathDecl {
  /** Stable id used in `${paths.<id>}` references. Lowercase alphanum + `_`/`-`. */
  id: string;
  /** Single-segment default appended under `workspace_root`. No separators or `..`. */
  default: string;
  /** Optional human-readable description for surface-area UIs (settings, errors). */
  description?: string;
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ID_RE = /^[a-z0-9_-]+$/;

/** Builds a fresh `/g` regex that matches a literal `${paths.<id>}` token.
 * Each caller gets its own RegExp instance so `lastIndex` state can't leak
 * between concurrent substitutions or test re-runs. The character class
 * matches the same charset declarations allow; unknown ids are rejected by
 * the cross-reference step regardless of how they look. */
export function pathsRefRegex(): RegExp {
  return /\$\{paths\.([a-z0-9_-]+)\}/g;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function validateContentPath(raw: unknown, where: string): ValidationResult<ContentPathDecl> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `${where} must be an object` };
  }
  const p = raw as Record<string, unknown>;

  if (!isNonEmptyString(p['id'])) {
    return { ok: false, error: `${where}.id must be a non-empty string` };
  }
  if (!ID_RE.test(p['id'])) {
    return {
      ok: false,
      error: `${where}.id '${p['id']}' must match ${ID_RE} (lowercase letters, digits, '_' and '-')`,
    };
  }

  if (!isNonEmptyString(p['default'])) {
    return { ok: false, error: `${where}.default must be a non-empty string` };
  }
  const def = p['default'];
  if (def.startsWith('~')) {
    return {
      ok: false,
      error: `${where}.default '${def}' must not start with '~' — defaults are relative to workspace_root`,
    };
  }
  if (def.includes('/') || def.includes('\\')) {
    return {
      ok: false,
      error: `${where}.default '${def}' must be a single path segment (no '/' or '\\')`,
    };
  }
  if (def === '.' || def === '..') {
    return { ok: false, error: `${where}.default '${def}' is not a valid directory name` };
  }

  const out: ContentPathDecl = { id: p['id'], default: def };
  if (p['description'] !== undefined) {
    if (typeof p['description'] !== 'string') {
      return { ok: false, error: `${where}.description must be a string if present` };
    }
    out.description = p['description'];
  }
  return { ok: true, value: out };
}

/** Mirror the env-var-name normalization `pathResolver.envVarsFor` applies so
 * collisions are caught at manifest load instead of at run time. */
function envKeyFor(id: string): string {
  return id.replace(/-/g, '_').toUpperCase();
}

export function validateContentPaths(raw: unknown): ValidationResult<ContentPathDecl[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'accContent.paths must be an array' };
  }
  const seenIds = new Set<string>();
  const seenEnvKeys = new Map<string, string>();
  const out: ContentPathDecl[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = validateContentPath(raw[i], `accContent.paths[${i}]`);
    if (!v.ok) return v;
    if (seenIds.has(v.value.id)) {
      return {
        ok: false,
        error: `accContent.paths[${i}].id '${v.value.id}' is duplicated within the same course`,
      };
    }
    const envKey = envKeyFor(v.value.id);
    const collidingId = seenEnvKeys.get(envKey);
    if (collidingId !== undefined) {
      return {
        ok: false,
        error: `accContent.paths[${i}].id '${v.value.id}' collides with '${collidingId}' on env-var name 'ACC_PATHS_${envKey}' (both '-' and '_' normalize to '_' in env names — pick one canonical character)`,
      };
    }
    seenIds.add(v.value.id);
    seenEnvKeys.set(envKey, v.value.id);
    out.push(v.value);
  }
  return { ok: true, value: out };
}

/**
 * Collect every `${paths.<id>}` reference embedded in a probe's params and
 * remediation fields. Walks recursively so any string leaf (including args
 * arrays) is scanned. Returns one entry per occurrence with a dotted location
 * suitable for diagnostics.
 */
export function collectProbePathRefs(
  probe: CourseProbeDecl,
): Array<{ id: string; token: string; location: string }> {
  const refs: Array<{ id: string; token: string; location: string }> = [];

  const visit = (value: unknown, location: string): void => {
    if (typeof value === 'string') {
      const matches = value.matchAll(pathsRefRegex());
      for (const m of matches) {
        refs.push({ id: m[1] as string, token: m[0], location });
      }
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        visit(value[i], `${location}[${i}]`);
      }
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        visit(v, `${location}.${k}`);
      }
    }
  };

  visit(probe.params, 'params');
  if (probe.remediation) {
    visit(probe.remediation.command, 'remediation.command');
    if (probe.remediation.cwd !== undefined) {
      visit(probe.remediation.cwd, 'remediation.cwd');
    }
  }
  return refs;
}

/**
 * Cross-reference: every `${paths.<id>}` referenced by a probe must match a
 * `paths[i].id` declared in the same manifest. Caller passes the declared id
 * set so this stays a pure function (testable without a discovery pass).
 */
export function validateProbePathRefs(
  declaredIds: ReadonlySet<string>,
  probes: readonly CourseProbeDecl[],
): ValidationResult<true> {
  for (const probe of probes) {
    for (const ref of collectProbePathRefs(probe)) {
      if (!declaredIds.has(ref.id)) {
        const declared = declaredIds.size === 0
          ? '(none)'
          : [...declaredIds].sort().join(', ');
        return {
          ok: false,
          error: `probe '${probe.id}' at ${ref.location} references ${ref.token} but accContent.paths declares no '${ref.id}' (declared: ${declared})`,
        };
      }
    }
  }
  return { ok: true, value: true };
}
