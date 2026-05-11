// courseProbes.ts — declarative probe schema for course plugins.
//
// ACC ships zero domain probes; every prerequisite check is declared by the
// course plugin under `accContent.probes` in its `plugin.json`. This file is
// the validator + types for those declarations. The runtime that *executes*
// them lives in `dynamicProbes.ts`.
//
// Four kinds are supported. Anything weirder degrades into `shell-exit-zero`
// with a regex on stdout.

export type CourseProbeKind =
  | 'filesystem-exists'
  | 'http-get'
  | 'shell-exit-zero'
  | 'claude-plugin-enabled';

export interface ProbeRemediation {
  /** Only `shell` is supported today; a future kind could be `mcp-tool`. */
  kind: 'shell';
  command: string;
  /** Optional working directory. Supports `~/` prefix for the user's home. */
  cwd?: string;
  /** Defaults to 60s if absent. */
  timeout_ms?: number;
}

interface CourseProbeBase {
  id: string;
  message_pass: string;
  message_fail: string;
  remediation?: ProbeRemediation;
}

export interface FilesystemExistsProbe extends CourseProbeBase {
  kind: 'filesystem-exists';
  params: {
    /** Path to check. Supports `~/` for home; otherwise must be absolute. */
    path: string;
  };
}

export interface HttpGetProbe extends CourseProbeBase {
  kind: 'http-get';
  params: {
    url: string;
    /** Default 200. */
    expected_status?: number;
    /** Default 5000. */
    timeout_ms?: number;
    /** Optional substring or regex (anchored as written) the body must match. */
    expected_body_regex?: string;
  };
}

export interface ShellExitZeroProbe extends CourseProbeBase {
  kind: 'shell-exit-zero';
  params: {
    command: string;
    args?: string[];
    /** Default 10000. */
    timeout_ms?: number;
    /** Optional regex the stdout must match for the probe to count as passed. */
    expected_stdout_regex?: string;
  };
}

export interface ClaudePluginEnabledProbe extends CourseProbeBase {
  kind: 'claude-plugin-enabled';
  params: {
    /** Plugin key as it appears under `enabledPlugins` in `~/.claude/settings.json`. */
    plugin_key: string;
  };
}

export type CourseProbeDecl =
  | FilesystemExistsProbe
  | HttpGetProbe
  | ShellExitZeroProbe
  | ClaudePluginEnabledProbe;

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const KNOWN_KINDS: ReadonlySet<CourseProbeKind> = new Set([
  'filesystem-exists',
  'http-get',
  'shell-exit-zero',
  'claude-plugin-enabled',
]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function validateRemediation(raw: unknown, where: string): ValidationResult<ProbeRemediation> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: `${where} must be an object` };
  }
  const r = raw as Record<string, unknown>;
  if (r['kind'] !== 'shell') {
    return { ok: false, error: `${where}.kind must be 'shell' (got ${JSON.stringify(r['kind'])})` };
  }
  if (!isNonEmptyString(r['command'])) {
    return { ok: false, error: `${where}.command must be a non-empty string` };
  }
  const out: ProbeRemediation = { kind: 'shell', command: r['command'] };
  if (r['cwd'] !== undefined) {
    if (!isNonEmptyString(r['cwd'])) {
      return { ok: false, error: `${where}.cwd must be a non-empty string if present` };
    }
    out.cwd = r['cwd'];
  }
  if (r['timeout_ms'] !== undefined) {
    if (!isPositiveInt(r['timeout_ms'])) {
      return { ok: false, error: `${where}.timeout_ms must be a positive integer if present` };
    }
    out.timeout_ms = r['timeout_ms'];
  }
  return { ok: true, value: out };
}

export function validateCourseProbe(raw: unknown, where: string): ValidationResult<CourseProbeDecl> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `${where} must be an object` };
  }
  const p = raw as Record<string, unknown>;

  if (!isNonEmptyString(p['id'])) {
    return { ok: false, error: `${where}.id must be a non-empty string` };
  }
  const id = p['id'];

  const kind = p['kind'];
  if (typeof kind !== 'string' || !KNOWN_KINDS.has(kind as CourseProbeKind)) {
    return {
      ok: false,
      error: `${where}.kind must be one of: ${[...KNOWN_KINDS].join(', ')} (got ${JSON.stringify(kind)})`,
    };
  }

  if (!isNonEmptyString(p['message_pass'])) {
    return { ok: false, error: `${where}.message_pass must be a non-empty string` };
  }
  if (!isNonEmptyString(p['message_fail'])) {
    return { ok: false, error: `${where}.message_fail must be a non-empty string` };
  }

  if (typeof p['params'] !== 'object' || p['params'] === null) {
    return { ok: false, error: `${where}.params must be an object` };
  }
  const params = p['params'] as Record<string, unknown>;

  let remediation: ProbeRemediation | undefined;
  if (p['remediation'] !== undefined) {
    const r = validateRemediation(p['remediation'], `${where}.remediation`);
    if (!r.ok) return r;
    remediation = r.value;
  }

  // Kind-specific param validation. Build the union member fully so the
  // returned `value` type-narrows correctly.
  switch (kind as CourseProbeKind) {
    case 'filesystem-exists': {
      if (!isNonEmptyString(params['path'])) {
        return { ok: false, error: `${where}.params.path must be a non-empty string` };
      }
      const probe: FilesystemExistsProbe = {
        id,
        kind: 'filesystem-exists',
        message_pass: p['message_pass'] as string,
        message_fail: p['message_fail'] as string,
        params: { path: params['path'] as string },
      };
      if (remediation) probe.remediation = remediation;
      return { ok: true, value: probe };
    }
    case 'http-get': {
      if (!isNonEmptyString(params['url'])) {
        return { ok: false, error: `${where}.params.url must be a non-empty string` };
      }
      const probeParams: HttpGetProbe['params'] = { url: params['url'] as string };
      if (params['expected_status'] !== undefined) {
        if (!isPositiveInt(params['expected_status'])) {
          return {
            ok: false,
            error: `${where}.params.expected_status must be a positive integer if present`,
          };
        }
        probeParams.expected_status = params['expected_status'] as number;
      }
      if (params['timeout_ms'] !== undefined) {
        if (!isPositiveInt(params['timeout_ms'])) {
          return {
            ok: false,
            error: `${where}.params.timeout_ms must be a positive integer if present`,
          };
        }
        probeParams.timeout_ms = params['timeout_ms'] as number;
      }
      if (params['expected_body_regex'] !== undefined) {
        if (!isNonEmptyString(params['expected_body_regex'])) {
          return {
            ok: false,
            error: `${where}.params.expected_body_regex must be a non-empty string if present`,
          };
        }
        // Compile-test the regex.
        try {
          new RegExp(params['expected_body_regex'] as string);
        } catch (err) {
          return {
            ok: false,
            error: `${where}.params.expected_body_regex is not a valid RegExp: ${(err as Error).message}`,
          };
        }
        probeParams.expected_body_regex = params['expected_body_regex'] as string;
      }
      const probe: HttpGetProbe = {
        id,
        kind: 'http-get',
        message_pass: p['message_pass'] as string,
        message_fail: p['message_fail'] as string,
        params: probeParams,
      };
      if (remediation) probe.remediation = remediation;
      return { ok: true, value: probe };
    }
    case 'shell-exit-zero': {
      if (!isNonEmptyString(params['command'])) {
        return { ok: false, error: `${where}.params.command must be a non-empty string` };
      }
      const probeParams: ShellExitZeroProbe['params'] = { command: params['command'] as string };
      if (params['args'] !== undefined) {
        if (!Array.isArray(params['args'])) {
          return { ok: false, error: `${where}.params.args must be an array if present` };
        }
        for (const a of params['args'] as unknown[]) {
          if (typeof a !== 'string') {
            return { ok: false, error: `${where}.params.args entries must be strings` };
          }
        }
        probeParams.args = params['args'] as string[];
      }
      if (params['timeout_ms'] !== undefined) {
        if (!isPositiveInt(params['timeout_ms'])) {
          return {
            ok: false,
            error: `${where}.params.timeout_ms must be a positive integer if present`,
          };
        }
        probeParams.timeout_ms = params['timeout_ms'] as number;
      }
      if (params['expected_stdout_regex'] !== undefined) {
        if (!isNonEmptyString(params['expected_stdout_regex'])) {
          return {
            ok: false,
            error: `${where}.params.expected_stdout_regex must be a non-empty string if present`,
          };
        }
        try {
          new RegExp(params['expected_stdout_regex'] as string);
        } catch (err) {
          return {
            ok: false,
            error: `${where}.params.expected_stdout_regex is not a valid RegExp: ${(err as Error).message}`,
          };
        }
        probeParams.expected_stdout_regex = params['expected_stdout_regex'] as string;
      }
      const probe: ShellExitZeroProbe = {
        id,
        kind: 'shell-exit-zero',
        message_pass: p['message_pass'] as string,
        message_fail: p['message_fail'] as string,
        params: probeParams,
      };
      if (remediation) probe.remediation = remediation;
      return { ok: true, value: probe };
    }
    case 'claude-plugin-enabled': {
      if (!isNonEmptyString(params['plugin_key'])) {
        return { ok: false, error: `${where}.params.plugin_key must be a non-empty string` };
      }
      const probe: ClaudePluginEnabledProbe = {
        id,
        kind: 'claude-plugin-enabled',
        message_pass: p['message_pass'] as string,
        message_fail: p['message_fail'] as string,
        params: { plugin_key: params['plugin_key'] as string },
      };
      if (remediation) probe.remediation = remediation;
      return { ok: true, value: probe };
    }
  }
}

export function validateCourseProbes(raw: unknown): ValidationResult<CourseProbeDecl[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'accContent.probes must be an array' };
  }
  const seen = new Set<string>();
  const probes: CourseProbeDecl[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = validateCourseProbe(raw[i], `accContent.probes[${i}]`);
    if (!v.ok) return v;
    if (seen.has(v.value.id)) {
      return {
        ok: false,
        error: `accContent.probes[${i}].id '${v.value.id}' is duplicated within the same course`,
      };
    }
    seen.add(v.value.id);
    probes.push(v.value);
  }
  return { ok: true, value: probes };
}
