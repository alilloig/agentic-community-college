// sections.ts — validator for `<lesson>/sections.json`.
//
// Replaces phases.ts in the new lesson model. A lesson ships an ordered list
// of sections; each section is a single prompt the conductor surfaces to the
// learner. The active Claude Code output style (`learning` vs `explanatory`)
// alone decides whether the implementing agent leaves TODOs or fills + narrates
// — the prompt body itself is the same. Each section carries a `key_moment`
// emphasis line so the learning-mode agent picks the right place to leave its
// contribution gap.

export type VerificationMode = 'compile' | 'test-suite';

export interface VerificationSpec {
  mode: VerificationMode;
  command: string;
  /** Workspace-relative cwd to run the verification in. Defaults to ".". */
  cwd?: string;
}

export interface SectionData {
  id: string;
  title: string;
  /** Lesson-relative path to the section body (markdown). */
  body_md: string;
  /** One-or-two-sentence emphasis steering learning-mode TODO placement. */
  key_moment: string;
  /** Workspace-relative files this section is expected to produce or touch. */
  expected_files: string[];
  /** Matches a `data-section-id` in artifact/template.html. */
  artifact_section_id: string;
  /** Optional per-section verification (most sections have none). */
  verification?: VerificationSpec;
}

export interface SectionsManifest {
  schema_version: 1;
  sections: SectionData[];
  /** Mandatory end-of-lesson gate. */
  final_verification: VerificationSpec;
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isLessonRelPath(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  const segments = p.replace(/\\/g, '/').split('/');
  return !segments.includes('..');
}

function isWorkspaceRelPath(p: string): boolean {
  // Same rules — kept under a separate name so the call sites self-document.
  return isLessonRelPath(p);
}

function validateVerification(
  raw: unknown,
  path: string,
): ValidationResult<VerificationSpec> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: `${path} must be an object` };
  }
  const v = raw as Record<string, unknown>;
  if (v['mode'] !== 'compile' && v['mode'] !== 'test-suite') {
    return {
      ok: false,
      error: `${path}.mode must be 'compile' or 'test-suite' (got ${JSON.stringify(v['mode'])})`,
    };
  }
  if (typeof v['command'] !== 'string' || (v['command'] as string).length === 0) {
    return { ok: false, error: `${path}.command must be a non-empty string` };
  }
  const spec: VerificationSpec = {
    mode: v['mode'] as VerificationMode,
    command: v['command'] as string,
  };
  if (v['cwd'] !== undefined) {
    if (typeof v['cwd'] !== 'string' || (v['cwd'] as string).length === 0) {
      return { ok: false, error: `${path}.cwd must be a non-empty string if present` };
    }
    if (!isLessonRelPath(v['cwd'] as string)) {
      return {
        ok: false,
        error: `${path}.cwd '${v['cwd']}' must be a relative path with no '..' segments and no leading '/'`,
      };
    }
    spec.cwd = v['cwd'] as string;
  }
  return { ok: true, value: spec };
}

export function validateSections(v: unknown): ValidationResult<SectionsManifest> {
  if (typeof v !== 'object' || v === null) {
    return { ok: false, error: 'sections.json must be an object' };
  }
  const obj = v as Record<string, unknown>;

  if (obj['schema_version'] !== 1) {
    return {
      ok: false,
      error: `sections.json schema_version must be 1 (got ${JSON.stringify(obj['schema_version'])})`,
    };
  }

  if (!Array.isArray(obj['sections']) || obj['sections'].length === 0) {
    return { ok: false, error: 'sections must be a non-empty array' };
  }

  const sections: SectionData[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < obj['sections'].length; i++) {
    const rawSection = obj['sections'][i];
    const where = `sections[${i}]`;
    if (typeof rawSection !== 'object' || rawSection === null) {
      return { ok: false, error: `${where} must be an object` };
    }
    const s = rawSection as Record<string, unknown>;

    if (typeof s['id'] !== 'string' || (s['id'] as string).length === 0) {
      return { ok: false, error: `${where}.id must be a non-empty string` };
    }
    if (seenIds.has(s['id'] as string)) {
      return { ok: false, error: `${where}.id '${s['id']}' is duplicated` };
    }
    seenIds.add(s['id'] as string);

    if (typeof s['title'] !== 'string' || (s['title'] as string).length === 0) {
      return { ok: false, error: `${where}.title must be a non-empty string` };
    }
    if (typeof s['body_md'] !== 'string' || (s['body_md'] as string).length === 0) {
      return { ok: false, error: `${where}.body_md must be a non-empty string` };
    }
    if (!isLessonRelPath(s['body_md'] as string)) {
      return {
        ok: false,
        error: `${where}.body_md '${s['body_md']}' must be a lesson-relative path`,
      };
    }
    if (typeof s['key_moment'] !== 'string' || (s['key_moment'] as string).length === 0) {
      return { ok: false, error: `${where}.key_moment must be a non-empty string` };
    }
    if (!Array.isArray(s['expected_files'])) {
      return { ok: false, error: `${where}.expected_files must be an array` };
    }
    const expectedFiles: string[] = [];
    for (const f of s['expected_files'] as unknown[]) {
      if (typeof f !== 'string' || f.length === 0) {
        return { ok: false, error: `${where}.expected_files entries must be non-empty strings` };
      }
      if (!isWorkspaceRelPath(f)) {
        return {
          ok: false,
          error: `${where}.expected_files entry '${f}' must be workspace-relative`,
        };
      }
      expectedFiles.push(f);
    }
    if (typeof s['artifact_section_id'] !== 'string' || (s['artifact_section_id'] as string).length === 0) {
      return { ok: false, error: `${where}.artifact_section_id must be a non-empty string` };
    }

    const section: SectionData = {
      id: s['id'] as string,
      title: s['title'] as string,
      body_md: s['body_md'] as string,
      key_moment: s['key_moment'] as string,
      expected_files: expectedFiles,
      artifact_section_id: s['artifact_section_id'] as string,
    };

    if (s['verification'] !== undefined) {
      const v = validateVerification(s['verification'], `${where}.verification`);
      if (!v.ok) return v;
      section.verification = v.value;
    }

    sections.push(section);
  }

  if (obj['final_verification'] === undefined) {
    return { ok: false, error: 'final_verification is required' };
  }
  const finalV = validateVerification(obj['final_verification'], 'final_verification');
  if (!finalV.ok) return finalV;

  return {
    ok: true,
    value: {
      schema_version: 1,
      sections,
      final_verification: finalV.value,
    },
  };
}
