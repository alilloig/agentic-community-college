import type { ProbeResult, ProbeOptions } from '../preflight.js';

export async function probeNodeVersion(_opts: ProbeOptions = {}): Promise<ProbeResult> {
  const version = process.version; // e.g. 'v20.10.0'
  const match = /^v?(\d+)/.exec(version);
  const major = match ? parseInt(match[1], 10) : 0;

  if (major >= 18) {
    return { pass: true, message: `Node.js ${version} meets the minimum requirement (>= 18).` };
  }

  return {
    pass: false,
    message: `Node.js ${version} is below the minimum required version (18). Please upgrade Node.js.`,
  };
}
