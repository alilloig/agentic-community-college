export interface VerificationCompile {
  mode: 'compile';
  command: string;
}

export interface VerificationTest {
  mode: 'test';
  command: string;
  expected_pass?: number;
}

export interface VerificationSimulate {
  mode: 'simulate';
  endpoint: string;
  expected_status: number;
}

export interface VerificationCustom {
  mode: 'custom';
  command: string;
  expected_stdout_regex: string;
}

export type VerificationSpec =
  | VerificationCompile
  | VerificationTest
  | VerificationSimulate
  | VerificationCustom;

export interface SpotRungs {
  hint_md: string;
  reference_md: string;
  auto_write_md: string;
}

export type SpotStyleKind = 'fill-in-blank' | 'prompted-agentic';

export interface FillInBlankStyle {
  /** Path-relative starter file (relative to the path root, e.g.
   * "starters/p1-spot-1/App.tsx"). Copied into the workspace by
   * prepareWorkspace; the `blank_range` lines are the regions the learner
   * fills. */
  starter_file: string;
  /** Line range (e.g. "39-58") inside the starter that the learner edits. */
  blank_range: string;
}

export interface PromptedAgenticStyle {
  /** Path-relative directory containing the ordered prompt sequence
   * (e.g. "prompts/p1-spot-1/"). Populated in PR 2; PR 1 reserves the field. */
  prompts_dir: string;
  /** Workspace-relative files the agentic flow is expected to produce. */
  expected_files: string[];
}

export interface SpotStyles {
  'fill-in-blank'?: FillInBlankStyle;
  'prompted-agentic'?: PromptedAgenticStyle;
}

export interface SpotData {
  id: string;
  title?: string;
  // Optional for backward-compat with stub spots (cycle-1/2/3 fixtures).
  // Full spots (any of target_file/target_range/prompt/verification present)
  // must have all four. Stub spots may omit all four.
  target_file?: string;
  target_range?: string;
  prompt?: string;
  verification?: VerificationSpec;
  rungs?: SpotRungs;
  doc_links?: string[];
  /** Optional per-spot exercise styles. Absent = legacy single-style behavior
   * (Style A with target_file as the starter). PR 1 only honors fill-in-blank. */
  styles?: SpotStyles;
}

export interface PhaseData {
  id: string;
  title?: string;
  explainer_md?: string;
  spots: SpotData[];
}

export interface PhasesData {
  phases: PhaseData[];
}

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Security: slug and path validation helpers
// ---------------------------------------------------------------------------

/**
 * Slug regex: must start with [a-z0-9], followed by zero or more [a-z0-9_-].
 * No slashes, no dots, no leading dash or underscore.
 */
const SLUG_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

function isValidSlug(s: string): boolean {
  return SLUG_REGEX.test(s);
}

/**
 * Validate that a relative file path is safe:
 * - Must not be absolute (no leading /)
 * - Must not contain any .. segment
 */
function isValidRelPath(p: string): boolean {
  if (p.startsWith('/') || p.startsWith('\\')) {
    return false;
  }
  // Normalize separators and split
  const segments = p.replace(/\\/g, '/').split('/');
  return !segments.includes('..');
}

// ---------------------------------------------------------------------------

function validateVerification(v: unknown, phaseId: string, spotId: string): ValidationResult<VerificationSpec> {
  if (typeof v !== 'object' || v === null) {
    return { ok: false, error: `Phase ${phaseId} spot ${spotId}: verification must be an object` };
  }
  const obj = v as Record<string, unknown>;
  const mode = obj['mode'];

  if (mode !== 'compile' && mode !== 'test' && mode !== 'simulate' && mode !== 'custom') {
    return {
      ok: false,
      error: `Phase ${phaseId} spot ${spotId}: verification.mode must be one of compile|test|simulate|custom`,
    };
  }

  if (mode === 'compile') {
    if (typeof obj['command'] !== 'string') {
      return { ok: false, error: `Phase ${phaseId} spot ${spotId}: compile verification requires a command string` };
    }
    return { ok: true, value: { mode: 'compile', command: obj['command'] as string } };
  }

  if (mode === 'test') {
    if (typeof obj['command'] !== 'string') {
      return { ok: false, error: `Phase ${phaseId} spot ${spotId}: test verification requires a command string` };
    }
    const result: VerificationTest = { mode: 'test', command: obj['command'] as string };
    if (typeof obj['expected_pass'] === 'number') {
      result.expected_pass = obj['expected_pass'] as number;
    }
    return { ok: true, value: result };
  }

  if (mode === 'simulate') {
    if (typeof obj['endpoint'] !== 'string') {
      return { ok: false, error: `Phase ${phaseId} spot ${spotId}: simulate verification requires an endpoint string` };
    }
    if (typeof obj['expected_status'] !== 'number') {
      return { ok: false, error: `Phase ${phaseId} spot ${spotId}: simulate verification requires expected_status number` };
    }
    return {
      ok: true,
      value: {
        mode: 'simulate',
        endpoint: obj['endpoint'] as string,
        expected_status: obj['expected_status'] as number,
      },
    };
  }

  // mode === 'custom'
  if (typeof obj['command'] !== 'string') {
    return { ok: false, error: `Phase ${phaseId} spot ${spotId}: custom verification requires a command string` };
  }
  if (typeof obj['expected_stdout_regex'] !== 'string') {
    return {
      ok: false,
      error: `Phase ${phaseId} spot ${spotId}: custom verification requires expected_stdout_regex string`,
    };
  }
  return {
    ok: true,
    value: {
      mode: 'custom',
      command: obj['command'] as string,
      expected_stdout_regex: obj['expected_stdout_regex'] as string,
    },
  };
}

export function validatePhases(v: unknown): ValidationResult<PhasesData> {
  if (typeof v !== 'object' || v === null) {
    return { ok: false, error: 'phases.json must be an object' };
  }
  const obj = v as Record<string, unknown>;

  if (!Array.isArray(obj['phases'])) {
    return { ok: false, error: 'Missing required field: phases (must be an array)' };
  }

  const phases = obj['phases'] as unknown[];
  if (phases.length === 0) {
    return { ok: false, error: 'phases array must have at least one phase' };
  }

  const validatedPhases: PhaseData[] = [];

  for (const phase of phases) {
    if (typeof phase !== 'object' || phase === null) {
      return { ok: false, error: 'Each phase must be an object' };
    }
    const p = phase as Record<string, unknown>;
    if (typeof p['id'] !== 'string') {
      return { ok: false, error: 'Each phase must have a string id' };
    }
    const phaseId = p['id'] as string;

    // Security: validate phase.id against slug regex
    if (!isValidSlug(phaseId)) {
      return {
        ok: false,
        error: `Phase id '${phaseId}' is invalid: must match /^[a-z0-9][a-z0-9_-]*$/ (no slashes, dots, or leading dash/underscore)`,
      };
    }

    if (!Array.isArray(p['spots'])) {
      return { ok: false, error: `Phase ${phaseId}: spots must be an array` };
    }
    if ((p['spots'] as unknown[]).length === 0) {
      return { ok: false, error: `Phase ${phaseId}: spots array must have at least one spot` };
    }

    const validatedSpots: SpotData[] = [];

    for (const spot of p['spots'] as unknown[]) {
      if (typeof spot !== 'object' || spot === null) {
        return { ok: false, error: `Phase ${phaseId}: each spot must be an object` };
      }
      const s = spot as Record<string, unknown>;
      if (typeof s['id'] !== 'string') {
        return { ok: false, error: `Phase ${phaseId}: each spot must have a string id` };
      }
      const spotId = s['id'] as string;

      // Security: validate spot.id against slug regex
      if (!isValidSlug(spotId)) {
        return {
          ok: false,
          error: `Phase ${phaseId} spot id '${spotId}' is invalid: must match /^[a-z0-9][a-z0-9_-]*$/ (no slashes, dots, or leading dash/underscore)`,
        };
      }

      // Determine if this is a "full" spot (any of the phase-1 fields present)
      // or a "stub" spot (only id/title). Full spots require all four fields.
      // Stub spots are backward-compat with cycle-1/2/3 fixtures (id + title only).
      const hasAnyNewField =
        s['target_file'] !== undefined ||
        s['target_range'] !== undefined ||
        s['prompt'] !== undefined ||
        s['verification'] !== undefined;

      const spotData: SpotData = { id: spotId };
      if (typeof s['title'] === 'string') spotData.title = s['title'] as string;

      if (hasAnyNewField) {
        // Full spot validation: all four required fields must be present
        if (typeof s['target_file'] !== 'string') {
          return { ok: false, error: `Phase ${phaseId} spot ${spotId}: target_file must be a string` };
        }

        // Security: validate target_file is a safe relative path (C021 fix at schema level)
        if (!isValidRelPath(s['target_file'] as string)) {
          return {
            ok: false,
            error: `Phase ${phaseId} spot ${spotId}: target_file '${s['target_file']}' is invalid: must be a relative path with no '..' segments and no leading '/'`,
          };
        }

        if (typeof s['target_range'] !== 'string') {
          return { ok: false, error: `Phase ${phaseId} spot ${spotId}: target_range must be a string` };
        }
        if (typeof s['prompt'] !== 'string') {
          return { ok: false, error: `Phase ${phaseId} spot ${spotId}: prompt must be a string` };
        }

        const verResult = validateVerification(s['verification'], phaseId, spotId);
        if (!verResult.ok) {
          return { ok: false, error: verResult.error };
        }

        spotData.target_file = s['target_file'] as string;
        spotData.target_range = s['target_range'] as string;
        spotData.prompt = s['prompt'] as string;
        spotData.verification = verResult.value;

        // Validate rungs if present
        if (s['rungs'] !== undefined) {
          if (typeof s['rungs'] !== 'object' || s['rungs'] === null) {
            return { ok: false, error: `Phase ${phaseId} spot ${spotId}: rungs must be an object` };
          }
          const r = s['rungs'] as Record<string, unknown>;
          if (typeof r['hint_md'] !== 'string') {
            return { ok: false, error: `Phase ${phaseId} spot ${spotId}: rungs.hint_md must be a string` };
          }
          if (typeof r['reference_md'] !== 'string') {
            return { ok: false, error: `Phase ${phaseId} spot ${spotId}: rungs.reference_md must be a string` };
          }
          if (typeof r['auto_write_md'] !== 'string') {
            return { ok: false, error: `Phase ${phaseId} spot ${spotId}: rungs.auto_write_md must be a string` };
          }

          // Security: validate rungs paths are safe relative paths (C012 fix at schema level)
          for (const [field, value] of [
            ['rungs.hint_md', r['hint_md']],
            ['rungs.reference_md', r['reference_md']],
            ['rungs.auto_write_md', r['auto_write_md']],
          ] as [string, string][]) {
            if (!isValidRelPath(value)) {
              return {
                ok: false,
                error: `Phase ${phaseId} spot ${spotId}: ${field} '${value}' is invalid: must be a relative path with no '..' segments and no leading '/'`,
              };
            }
          }

          spotData.rungs = {
            hint_md: r['hint_md'] as string,
            reference_md: r['reference_md'] as string,
            auto_write_md: r['auto_write_md'] as string,
          };
        }

        if (s['doc_links'] !== undefined) {
          if (!Array.isArray(s['doc_links'])) {
            return { ok: false, error: `Phase ${phaseId} spot ${spotId}: doc_links must be an array` };
          }
          spotData.doc_links = s['doc_links'] as string[];
        }

        if (s['styles'] !== undefined) {
          if (typeof s['styles'] !== 'object' || s['styles'] === null || Array.isArray(s['styles'])) {
            return { ok: false, error: `Phase ${phaseId} spot ${spotId}: styles must be an object` };
          }
          const styles = s['styles'] as Record<string, unknown>;
          const result: SpotStyles = {};

          if (styles['fill-in-blank'] !== undefined) {
            if (typeof styles['fill-in-blank'] !== 'object' || styles['fill-in-blank'] === null) {
              return { ok: false, error: `Phase ${phaseId} spot ${spotId}: styles['fill-in-blank'] must be an object` };
            }
            const fib = styles['fill-in-blank'] as Record<string, unknown>;
            if (typeof fib['starter_file'] !== 'string' || typeof fib['blank_range'] !== 'string') {
              return { ok: false, error: `Phase ${phaseId} spot ${spotId}: styles['fill-in-blank'] requires starter_file and blank_range as strings` };
            }
            if (!isValidRelPath(fib['starter_file'] as string)) {
              return {
                ok: false,
                error: `Phase ${phaseId} spot ${spotId}: styles['fill-in-blank'].starter_file '${fib['starter_file']}' must be a relative path with no '..' segments and no leading '/'`,
              };
            }
            result['fill-in-blank'] = {
              starter_file: fib['starter_file'] as string,
              blank_range: fib['blank_range'] as string,
            };
          }

          if (styles['prompted-agentic'] !== undefined) {
            if (typeof styles['prompted-agentic'] !== 'object' || styles['prompted-agentic'] === null) {
              return { ok: false, error: `Phase ${phaseId} spot ${spotId}: styles['prompted-agentic'] must be an object` };
            }
            const pa = styles['prompted-agentic'] as Record<string, unknown>;
            if (typeof pa['prompts_dir'] !== 'string') {
              return { ok: false, error: `Phase ${phaseId} spot ${spotId}: styles['prompted-agentic'].prompts_dir must be a string` };
            }
            if (!isValidRelPath(pa['prompts_dir'] as string)) {
              return {
                ok: false,
                error: `Phase ${phaseId} spot ${spotId}: styles['prompted-agentic'].prompts_dir '${pa['prompts_dir']}' must be a relative path with no '..' segments and no leading '/'`,
              };
            }
            if (!Array.isArray(pa['expected_files'])) {
              return { ok: false, error: `Phase ${phaseId} spot ${spotId}: styles['prompted-agentic'].expected_files must be an array` };
            }
            for (const ef of pa['expected_files'] as unknown[]) {
              if (typeof ef !== 'string' || !isValidRelPath(ef)) {
                return {
                  ok: false,
                  error: `Phase ${phaseId} spot ${spotId}: styles['prompted-agentic'].expected_files entries must be safe relative paths`,
                };
              }
            }
            result['prompted-agentic'] = {
              prompts_dir: pa['prompts_dir'] as string,
              expected_files: [...(pa['expected_files'] as string[])],
            };
          }

          spotData.styles = result;
        }
      }
      // else: stub spot — just id + title, no new fields required

      validatedSpots.push(spotData);
    }

    const phaseData: PhaseData = {
      id: phaseId,
      spots: validatedSpots,
    };
    if (typeof p['title'] === 'string') phaseData.title = p['title'] as string;
    if (typeof p['explainer_md'] === 'string') phaseData.explainer_md = p['explainer_md'] as string;

    validatedPhases.push(phaseData);
  }

  return {
    ok: true,
    value: { phases: validatedPhases },
  };
}
