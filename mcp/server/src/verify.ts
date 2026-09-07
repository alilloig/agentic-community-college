import { spawnSync as nodeSpawnSync } from 'node:child_process';
import * as path from 'node:path';
import type { ResolvedVerification } from './progress.js';

export interface VerificationResult {
  pass: boolean;
  output?: string;
}

// SpawnFn signature: includes cwd + timeout.
export type VerifySpawnFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
) => { status: number | null; stdout: string; stderr: string };

export interface VerifyOptions {
  spawn?: VerifySpawnFn;
  /** Wall-clock bound for the verification subprocess. */
  timeoutMs?: number;
}

/** `spawnSync` blocks the MCP server, so every verification gets a bound. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 600_000;

export class VerificationModeUnsupportedError extends Error {
  public readonly mode: string;
  constructor(mode: string) {
    super(`Verification mode '${mode}' is not supported`);
    this.name = 'VerificationModeUnsupportedError';
    this.mode = mode;
  }
}

/**
 * Parse a shell-style command string into a { cmd, args } pair.
 * Handles double-quoted segments (strips quotes, preserves internal spaces).
 * Does NOT handle backslash escapes or single-quoted args. The command runs
 * without a shell, so operators (`&&`, `|`, redirects) are never interpreted;
 * `schemas/chapters.ts` rejects them at validation time.
 */
export function parseCommand(cmd: string): { cmd: string; args: string[] } {
  const tokens: string[] = [];
  let i = 0;
  const s = cmd;

  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;

    if (s[i] === '"') {
      i++;
      let token = '';
      while (i < s.length && s[i] !== '"') {
        token += s[i];
        i++;
      }
      if (i < s.length) i++;
      tokens.push(token);
    } else {
      let token = '';
      while (i < s.length && !/\s/.test(s[i])) {
        token += s[i];
        i++;
      }
      tokens.push(token);
    }
  }

  if (tokens.length === 0) {
    throw new Error(`parseCommand: empty or whitespace-only command string`);
  }

  const [command, ...rest] = tokens;
  return { cmd: command, args: rest };
}

/**
 * Run a resolved verification spec against the workspace.
 *
 * Supported modes: `compile` (any build/typecheck command — pass on exit 0)
 * and `test-suite` (vitest / playwright / similar — pass on exit 0). Test
 * stubbing flows through `VerifyOptions.spawn`. Throws on an unparseable
 * command (an authoring error, not a learner failure).
 */
export async function runVerification(
  adapter: ResolvedVerification,
  cwd: string,
  opts?: VerifyOptions,
): Promise<VerificationResult> {
  if (adapter.mode === 'compile' || adapter.mode === 'test-suite') {
    const { cmd, args } = parseCommand(adapter.command);
    const resolvedCwd = path.resolve(cwd, adapter.cwd);
    const timeout = opts?.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;

    const spawnFn: VerifySpawnFn = opts?.spawn ?? ((c, a, o) => {
      const syncResult = nodeSpawnSync(c, a, {
        encoding: 'utf8',
        cwd: o?.cwd,
        timeout: o?.timeout,
      });
      if (syncResult.error) {
        // ENOENT (binary missing), ETIMEDOUT, EACCES: spawnSync reports these
        // on `error` with empty streams. Put the reason where the learner
        // reads it.
        return {
          status: null,
          stdout: (syncResult.stdout as string) ?? '',
          stderr: `spawn failed: ${(syncResult.error as Error).message}`,
        };
      }
      return {
        status: syncResult.status,
        stdout: (syncResult.stdout as string) ?? '',
        stderr: (syncResult.stderr as string) ?? '',
      };
    });

    try {
      const result = spawnFn(cmd, args, { cwd: resolvedCwd, timeout });
      const output = (result.stdout ?? '') + (result.stderr ?? '');
      return {
        pass: result.status === 0,
        output,
      };
    } catch (err) {
      const e = err as Error & { code?: string };
      return {
        pass: false,
        output: e.code ?? e.message ?? String(err),
      };
    }
  }

  const _exhaustive: never = adapter.mode;
  throw new VerificationModeUnsupportedError(String(_exhaustive));
}
