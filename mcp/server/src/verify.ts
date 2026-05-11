import { spawnSync as nodeSpawnSync } from 'node:child_process';
import type { VerificationSpec } from './schemas/phases.js';

export type { VerificationSpec };

export interface VerificationResult {
  pass: boolean;
  output?: string;
}

// SpawnFn for verification includes cwd (unlike preflight's SpawnFn which only has timeout).
export type VerifySpawnFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
) => { status: number | null; stdout: string; stderr: string };

export interface VerifyOptions {
  spawn?: VerifySpawnFn;
}

/**
 * Error thrown when a verification mode is not yet supported in cycle 4.
 * Cycle 5+ will replace the stub bodies for test/simulate/custom.
 */
export class VerificationModeUnsupportedError extends Error {
  public readonly mode: string;
  constructor(mode: string) {
    super(`Verification mode '${mode}' is not yet supported in cycle 4`);
    this.name = 'VerificationModeUnsupportedError';
    this.mode = mode;
  }
}

/**
 * Parse a shell-style command string into a { cmd, args } pair.
 * Handles double-quoted segments (strips quotes, preserves internal spaces).
 * Collapses runs of whitespace between tokens.
 * Does NOT handle backslash escapes or single-quoted args.
 * Throws if the input is empty or whitespace-only.
 *
 * Examples:
 *   'pnpm build'            → { cmd: 'pnpm', args: ['build'] }
 *   'pnpm run build'        → { cmd: 'pnpm', args: ['run', 'build'] }
 *   'pnpm "build dir" -x'   → { cmd: 'pnpm', args: ['build dir', '-x'] }
 *   '   pnpm   build   '    → { cmd: 'pnpm', args: ['build'] }
 */
export function parseCommand(cmd: string): { cmd: string; args: string[] } {
  const tokens: string[] = [];
  let i = 0;
  const s = cmd;

  while (i < s.length) {
    // Skip whitespace
    while (i < s.length && /\s/.test(s[i])) {
      i++;
    }
    if (i >= s.length) break;

    // Start of a token
    if (s[i] === '"') {
      // Double-quoted segment
      i++; // skip opening quote
      let token = '';
      while (i < s.length && s[i] !== '"') {
        token += s[i];
        i++;
      }
      if (i < s.length) {
        i++; // skip closing quote
      }
      tokens.push(token);
    } else {
      // Unquoted token — read until whitespace
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
 * Run verification against the student's working tree.
 * Only the compile adapter is implemented in cycle 4.
 * test/simulate/custom throw VerificationModeUnsupportedError.
 *
 * NOTE (cycle-4 H001 remediation): there is intentionally NO module-level
 * mutable test override seam exported from this file. Cycle 4 A13 retired the
 * equivalent pattern from preflight.ts; cycle-4 review (R1-001 / R2-001 /
 * R3-003 / R4-001 / R5-002 / R6-001 — 6/6 reviewers) caught the same
 * anti-pattern being re-introduced under a different name here. Test stubbing
 * is now done at the *harness* boundary: the harness intercepts
 * `callTool('verifySpot', ...)` and returns a pre-installed stub envelope
 * without calling into production code. The harness is consumed only by
 * tests, so the test seam lives in test infrastructure rather than on the
 * production import surface.
 */
export async function runVerification(
  adapter: VerificationSpec,
  projectRoot: string,
  opts?: VerifyOptions,
): Promise<VerificationResult> {
  if (adapter.mode === 'compile') {
    const { cmd, args } = parseCommand(adapter.command);

    const spawnFn: VerifySpawnFn = opts?.spawn ?? ((c, a, o) => {
      const syncResult = nodeSpawnSync(c, a, {
        encoding: 'utf8',
        cwd: o?.cwd,
        timeout: o?.timeout,
      });
      return {
        status: syncResult.status,
        stdout: (syncResult.stdout as string) ?? '',
        stderr: (syncResult.stderr as string) ?? '',
      };
    });

    try {
      const result = spawnFn(cmd, args, { cwd: projectRoot });
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

  if (adapter.mode === 'test') {
    throw new VerificationModeUnsupportedError('test');
  }

  if (adapter.mode === 'simulate') {
    throw new VerificationModeUnsupportedError('simulate');
  }

  if (adapter.mode === 'custom') {
    throw new VerificationModeUnsupportedError('custom');
  }

  // TypeScript exhaustiveness — unreachable
  const _exhaustive: never = adapter;
  throw new Error(`Unknown verification mode: ${JSON.stringify(_exhaustive)}`);
}
