// chapters.ts — validator for `<lesson>/chapters.json` (ACC v0.3).
//
// A lesson ships an ordered list of chapters. Each chapter is defined by the
// set of test cases it makes pass: the conductor implements the chapter's
// `expected_files` until `verification` is green, then explains the code with
// one HTML artifact centered on `key_idea`. `final_verification` is the
// end-to-end gate that runs once after the last chapter.
//
// Path safety: `brief_md` is lesson-relative; `expected_files`, `tests` and
// `verification.cwd` are workspace-relative. All reject leading slashes and
// `..` segments.

export type VerificationMode = 'compile' | 'test-suite';

export interface VerificationSpec {
  mode: VerificationMode;
  command: string;
  /** Workspace-relative cwd to run the verification in. Defaults to ".". */
  cwd?: string;
}

export interface ChapterData {
  id: string;
  title: string;
  /** Lesson-relative path to the chapter brief (markdown). */
  brief_md: string;
  /** The one concept the chapter artifact must center on. */
  key_idea: string;
  /** Workspace-relative files this chapter produces or touches. */
  expected_files: string[];
  /** Workspace-relative test files that define this chapter. May be empty
   * for compile-only chapters. */
  tests: string[];
  /** Mandatory per-chapter gate. */
  verification: VerificationSpec;
}

export interface ChaptersManifest {
  schema_version: 2;
  chapters: ChapterData[];
  /** Mandatory end-of-lesson (e2e) gate. */
  final_verification: VerificationSpec;
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isRelPath(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  const segments = p.replace(/\\/g, '/').split('/');
  return !segments.includes('..');
}

export function validateVerification(
  raw: unknown,
  where: string,
): ValidationResult<VerificationSpec> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: `${where} must be an object` };
  }
  const v = raw as Record<string, unknown>;
  if (v['mode'] !== 'compile' && v['mode'] !== 'test-suite') {
    return {
      ok: false,
      error: `${where}.mode must be 'compile' or 'test-suite' (got ${JSON.stringify(v['mode'])})`,
    };
  }
  if (typeof v['command'] !== 'string' || (v['command'] as string).length === 0) {
    return { ok: false, error: `${where}.command must be a non-empty string` };
  }
  const spec: VerificationSpec = {
    mode: v['mode'] as VerificationMode,
    command: v['command'] as string,
  };
  if (v['cwd'] !== undefined) {
    if (typeof v['cwd'] !== 'string' || (v['cwd'] as string).length === 0) {
      return { ok: false, error: `${where}.cwd must be a non-empty string if present` };
    }
    if (!isRelPath(v['cwd'] as string)) {
      return {
        ok: false,
        error: `${where}.cwd '${v['cwd']}' must be a relative path with no '..' segments and no leading '/'`,
      };
    }
    spec.cwd = v['cwd'] as string;
  }
  return { ok: true, value: spec };
}

function validateRelPathList(
  raw: unknown,
  where: string,
): ValidationResult<string[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, error: `${where} must be an array` };
  }
  const out: string[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'string' || entry.length === 0) {
      return { ok: false, error: `${where} entries must be non-empty strings` };
    }
    if (!isRelPath(entry)) {
      return {
        ok: false,
        error: `${where} entry '${entry}' must be a relative path with no '..' segments and no leading '/'`,
      };
    }
    out.push(entry);
  }
  return { ok: true, value: out };
}

export function validateChapters(v: unknown): ValidationResult<ChaptersManifest> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { ok: false, error: 'chapters.json must be an object' };
  }
  const obj = v as Record<string, unknown>;

  if (obj['schema_version'] !== 2) {
    return {
      ok: false,
      error: `chapters.json schema_version must be 2 (got ${JSON.stringify(obj['schema_version'])})`,
    };
  }

  if (!Array.isArray(obj['chapters']) || obj['chapters'].length === 0) {
    return { ok: false, error: 'chapters must be a non-empty array' };
  }

  const chapters: ChapterData[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < obj['chapters'].length; i++) {
    const raw = obj['chapters'][i];
    const where = `chapters[${i}]`;
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: `${where} must be an object` };
    }
    const c = raw as Record<string, unknown>;

    if (typeof c['id'] !== 'string' || (c['id'] as string).length === 0) {
      return { ok: false, error: `${where}.id must be a non-empty string` };
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(c['id'] as string)) {
      return {
        ok: false,
        error: `${where}.id '${c['id']}' must be filename-safe ([A-Za-z0-9._-], no leading dot)`,
      };
    }
    if (seenIds.has(c['id'] as string)) {
      return { ok: false, error: `${where}.id '${c['id']}' is duplicated` };
    }
    seenIds.add(c['id'] as string);

    if (typeof c['title'] !== 'string' || (c['title'] as string).length === 0) {
      return { ok: false, error: `${where}.title must be a non-empty string` };
    }
    if (typeof c['brief_md'] !== 'string' || (c['brief_md'] as string).length === 0) {
      return { ok: false, error: `${where}.brief_md must be a non-empty string` };
    }
    if (!isRelPath(c['brief_md'] as string)) {
      return {
        ok: false,
        error: `${where}.brief_md '${c['brief_md']}' must be a lesson-relative path`,
      };
    }
    if (typeof c['key_idea'] !== 'string' || (c['key_idea'] as string).length === 0) {
      return { ok: false, error: `${where}.key_idea must be a non-empty string` };
    }

    const expected = validateRelPathList(c['expected_files'], `${where}.expected_files`);
    if (!expected.ok) return expected;

    const tests = validateRelPathList(c['tests'] ?? [], `${where}.tests`);
    if (!tests.ok) return tests;

    if (c['verification'] === undefined) {
      return { ok: false, error: `${where}.verification is required` };
    }
    const verification = validateVerification(c['verification'], `${where}.verification`);
    if (!verification.ok) return verification;

    chapters.push({
      id: c['id'] as string,
      title: c['title'] as string,
      brief_md: c['brief_md'] as string,
      key_idea: c['key_idea'] as string,
      expected_files: expected.value,
      tests: tests.value,
      verification: verification.value,
    });
  }

  if (obj['final_verification'] === undefined) {
    return { ok: false, error: 'final_verification is required' };
  }
  const finalV = validateVerification(obj['final_verification'], 'final_verification');
  if (!finalV.ok) return finalV;

  return {
    ok: true,
    value: {
      schema_version: 2,
      chapters,
      final_verification: finalV.value,
    },
  };
}
