// dynamicProbes.ts — runtime that executes declarative course probes.
//
// Each course plugin declares its prerequisites under `accContent.probes`
// in `plugin.json`. `runDynamicProbe` takes a single decl + ProbeOptions and
// returns a ProbeResult — the same shape ACC's legacy hardcoded probes
// produced, so `runPreflightProbe.ts` can treat the merged registry
// uniformly.

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProbeResult, ProbeOptions, ShellAction, SpawnFn } from './preflight.js';
import type { CourseProbeDecl, ProbeRemediation } from './schemas/courseProbes.js';
import { readClaudeSettings } from './outputStyle.js';

const DEFAULT_HTTP_TIMEOUT_MS = 5000;
const DEFAULT_SHELL_TIMEOUT_MS = 10_000;
const DEFAULT_REMEDIATION_TIMEOUT_MS = 60_000;

/** Test seam — production callers leave it undefined and we fall back to
 * `globalThis.fetch`. */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; method?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface DynamicProbeOptions extends ProbeOptions {
  fetch?: FetchLike;
  /** Test seam for the home-dir expansion in `~/` prefixed paths. */
  homeDir?: string;
}

/**
 * Expand `~/` prefix to the user's home dir. Refuse relative paths (anything
 * not absolute and not `~`-prefixed) so probes don't drift based on the MCP
 * server's cwd.
 */
export function expandUserPath(p: string, homeDir?: string): { ok: true; abs: string } | { ok: false; reason: string } {
  if (p.length === 0) return { ok: false, reason: 'empty path' };
  const home = homeDir ?? os.homedir();
  if (p === '~') return { ok: true, abs: home };
  if (p.startsWith('~/')) return { ok: true, abs: path.join(home, p.slice(2)) };
  if (path.isAbsolute(p)) return { ok: true, abs: p };
  return { ok: false, reason: `path must be absolute or '~/'-prefixed (got '${p}')` };
}

function shellActionFromRemediation(r: ProbeRemediation, homeDir?: string): ShellAction {
  const expanded = r.cwd ? expandUserPath(r.cwd, homeDir) : undefined;
  const action: ShellAction = {
    kind: 'shell',
    command: r.command,
  };
  if (expanded?.ok) action.cwd = expanded.abs;
  else if (r.cwd) action.cwd = r.cwd;
  if (r.timeout_ms !== undefined) action.timeoutMs = r.timeout_ms;
  else action.timeoutMs = DEFAULT_REMEDIATION_TIMEOUT_MS;
  return action;
}

function defaultSpawn(): SpawnFn {
  return (cmd, args, opts) => {
    const r = nodeSpawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: opts?.timeout,
      env: opts?.env ?? process.env,
    });
    return {
      status: r.status,
      stdout: (r.stdout as string) ?? '',
      stderr: (r.stderr as string) ?? '',
    };
  };
}

async function probeFilesystem(
  decl: Extract<CourseProbeDecl, { kind: 'filesystem-exists' }>,
  opts: DynamicProbeOptions,
): Promise<ProbeResult> {
  const expanded = expandUserPath(decl.params.path, opts.homeDir);
  if (!expanded.ok) {
    return {
      pass: false,
      message: `${decl.message_fail} (invalid path: ${expanded.reason})`,
    };
  }
  if (fs.existsSync(expanded.abs)) {
    return { pass: true, message: decl.message_pass };
  }
  const result: ProbeResult = { pass: false, message: decl.message_fail };
  if (decl.remediation) result.action = shellActionFromRemediation(decl.remediation, opts.homeDir);
  return result;
}

async function probeHttpGet(
  decl: Extract<CourseProbeDecl, { kind: 'http-get' }>,
  opts: DynamicProbeOptions,
): Promise<ProbeResult> {
  const expectedStatus = decl.params.expected_status ?? 200;
  const timeoutMs = decl.params.timeout_ms ?? DEFAULT_HTTP_TIMEOUT_MS;
  const fetchFn: FetchLike = opts.fetch ?? ((input, init) =>
    globalThis.fetch(input, init) as unknown as ReturnType<FetchLike>);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(decl.params.url, { signal: controller.signal, method: 'GET' });
    clearTimeout(timer);
    if (response.status !== expectedStatus) {
      const result: ProbeResult = {
        pass: false,
        message: `${decl.message_fail} (HTTP ${response.status}, expected ${expectedStatus})`,
      };
      if (decl.remediation) result.action = shellActionFromRemediation(decl.remediation, opts.homeDir);
      return result;
    }
    if (decl.params.expected_body_regex) {
      const body = await response.text();
      const re = new RegExp(decl.params.expected_body_regex);
      if (!re.test(body)) {
        const result: ProbeResult = {
          pass: false,
          message: `${decl.message_fail} (body did not match ${decl.params.expected_body_regex})`,
        };
        if (decl.remediation) result.action = shellActionFromRemediation(decl.remediation, opts.homeDir);
        return result;
      }
    }
    return { pass: true, message: decl.message_pass };
  } catch (err) {
    clearTimeout(timer);
    const e = err as Error & { name?: string };
    const reason = e.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (e.message ?? String(err));
    const result: ProbeResult = {
      pass: false,
      message: `${decl.message_fail} (${reason})`,
    };
    if (decl.remediation) result.action = shellActionFromRemediation(decl.remediation, opts.homeDir);
    return result;
  }
}

async function probeShellExitZero(
  decl: Extract<CourseProbeDecl, { kind: 'shell-exit-zero' }>,
  opts: DynamicProbeOptions,
): Promise<ProbeResult> {
  const spawnFn = opts.spawn ?? defaultSpawn();
  const timeoutMs = decl.params.timeout_ms ?? DEFAULT_SHELL_TIMEOUT_MS;
  // Merge any caller-supplied env (e.g. `ACC_PATHS_*` from runPreflightProbe)
  // so a probe command reading `$ACC_PATHS_SANDBOX` sees the same value the
  // matching remediation does.
  const spawnOpts: { timeout: number; env?: NodeJS.ProcessEnv } = { timeout: timeoutMs };
  if (opts.env !== undefined) spawnOpts.env = { ...process.env, ...opts.env };
  try {
    const result = spawnFn(decl.params.command, decl.params.args ?? [], spawnOpts);
    if (result.status !== 0) {
      const r: ProbeResult = {
        pass: false,
        message: `${decl.message_fail} (exit ${result.status})`,
      };
      if (decl.remediation) r.action = shellActionFromRemediation(decl.remediation, opts.homeDir);
      return r;
    }
    if (decl.params.expected_stdout_regex) {
      const re = new RegExp(decl.params.expected_stdout_regex);
      if (!re.test(result.stdout)) {
        const r: ProbeResult = {
          pass: false,
          message: `${decl.message_fail} (stdout did not match ${decl.params.expected_stdout_regex})`,
        };
        if (decl.remediation) r.action = shellActionFromRemediation(decl.remediation, opts.homeDir);
        return r;
      }
    }
    return { pass: true, message: decl.message_pass };
  } catch (err) {
    const e = err as Error & { code?: string };
    const r: ProbeResult = {
      pass: false,
      message: `${decl.message_fail} (${e.code ?? e.message ?? String(err)})`,
    };
    if (decl.remediation) r.action = shellActionFromRemediation(decl.remediation, opts.homeDir);
    return r;
  }
}

async function probeClaudePluginEnabled(
  decl: Extract<CourseProbeDecl, { kind: 'claude-plugin-enabled' }>,
  opts: DynamicProbeOptions,
): Promise<ProbeResult> {
  const settings = readClaudeSettings(opts.homeDir);
  if (!settings.ok) {
    const detail =
      settings.kind === 'missing'
        ? `settings.json not found at ${settings.file}`
        : settings.kind === 'read-error'
          ? `settings.json could not be read: ${settings.detail}`
          : settings.kind === 'parse-error'
            ? `settings.json parse error: ${settings.detail}`
            : 'settings.json is not an object';
    return { pass: false, message: `${decl.message_fail} (${detail})` };
  }
  const enabled = settings.settings['enabledPlugins'];
  if (typeof enabled !== 'object' || enabled === null || Array.isArray(enabled)) {
    return { pass: false, message: `${decl.message_fail} (enabledPlugins missing or wrong shape)` };
  }
  if ((enabled as Record<string, unknown>)[decl.params.plugin_key] === true) {
    return { pass: true, message: decl.message_pass };
  }
  return { pass: false, message: decl.message_fail };
}

/**
 * Run a single declarative probe. Dispatches on `kind`. Returns the same
 * ProbeResult shape ACC's legacy probes produced so `runPreflightProbe.ts`
 * can treat declarative and legacy probes the same way.
 *
 * If `opts.remediate` is true and the result has a `.action`, the caller
 * (runPreflightProbe.ts) executes the remediation, then re-runs the probe.
 * This module does NOT execute remediations on its own — only the tool layer
 * does, after user confirmation.
 */
export async function runDynamicProbe(
  decl: CourseProbeDecl,
  opts: DynamicProbeOptions = {},
): Promise<ProbeResult> {
  switch (decl.kind) {
    case 'filesystem-exists':
      return probeFilesystem(decl, opts);
    case 'http-get':
      return probeHttpGet(decl, opts);
    case 'shell-exit-zero':
      return probeShellExitZero(decl, opts);
    case 'claude-plugin-enabled':
      return probeClaudePluginEnabled(decl, opts);
  }
}
