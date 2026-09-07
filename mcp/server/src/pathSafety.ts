import * as path from 'node:path';

export class PathTraversalError extends Error {
  constructor(public attempted: string, public root: string) {
    super(`Path traversal blocked: ${attempted} escapes ${root}`);
    this.name = 'PathTraversalError';
  }
}

/**
 * Resolve `untrusted` relative to `root` and assert the result is contained
 * within `root` (i.e., not a parent directory, not an absolute escape).
 *
 * Throws PathTraversalError if:
 *   - `untrusted` is absolute (path.join would still accept it and discard root)
 *   - the resolved path escapes root via `..` segments
 *
 * Returns the fully-resolved absolute path on success.
 */
export function containedPath(root: string, untrusted: string): string {
  const absRoot = path.resolve(root);
  const resolved = path.resolve(absRoot, untrusted);
  // Must be the root itself or a path strictly within it.
  if (resolved !== absRoot && !resolved.startsWith(absRoot + path.sep)) {
    throw new PathTraversalError(untrusted, absRoot);
  }
  return resolved;
}

/**
 * The one relative-path rule every manifest field obeys: non-empty, no
 * leading slash, no `..` segment. Shared by the lesson and chapters
 * validators so both formats accept exactly the same paths.
 */
export function isSafeRelPath(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  const segments = p.replace(/\\/g, '/').split('/');
  return !segments.includes('..');
}

/** Identifiers that become file or directory names: `[A-Za-z0-9._-]`, no leading dot. */
export function isFilenameSafeId(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s);
}
