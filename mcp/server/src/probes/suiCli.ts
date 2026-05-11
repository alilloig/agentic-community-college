import { spawnSync } from 'node:child_process';
import type { ProbeResult, ProbeOptions } from '../preflight.js';

const MIN_VERSION = [1, 63, 2] as const;
const MAX_VERSION = [1, 64, 1] as const;

function parseVersion(versionStr: string): [number, number, number] | null {
  // Handles formats like "sui 1.63.2-abc\n" or "1.63.2"
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(versionStr);
  if (!match) {
    return null;
  }
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

function compareVersions(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

export async function probeSuiCliVersion(opts: ProbeOptions = {}): Promise<ProbeResult> {
  const spawnFn = opts.spawn ?? defaultSpawn;

  try {
    const result = spawnFn('sui', ['--version'], { timeout: 5000 });
    const output = ((result.stdout ?? '') + (result.stderr ?? '')).trim();
    const parsed = parseVersion(output);

    if (!parsed) {
      return {
        pass: false,
        message: `Could not parse Sui CLI version from: "${output}". Run: brew install sui`,
      };
    }

    const versionStr = parsed.join('.');
    const aboveMin = compareVersions(parsed, MIN_VERSION) >= 0;
    const belowMax = compareVersions(parsed, MAX_VERSION) <= 0;

    if (aboveMin && belowMax) {
      return { pass: true, message: `Sui CLI version ${versionStr} is in the supported range.` };
    }

    return {
      pass: false,
      message: `Sui CLI ${versionStr} is outside the supported range (1.63.2–1.64.1). Run: brew install sui`,
    };
  } catch (_err) {
    return {
      pass: false,
      message: 'Sui CLI is not available. Run: brew install sui',
    };
  }
}

function defaultSpawn(
  cmd: string,
  args: string[],
  opts?: { timeout?: number },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts?.timeout ?? 5000,
  });
  if (result.error) {
    throw result.error;
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
