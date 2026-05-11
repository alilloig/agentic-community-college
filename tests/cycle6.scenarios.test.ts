// Cycle 6 — scenarios.json E-008 preconditions + cycle-e2e-pass.sh skip-with-reason (AC-2.5)
// T-313: E-008's preconditions array must include the Sui CLI 1.63.2-1.64.1 range string
//        (en-dash or hyphen accepted; both numeric anchors required) and must keep the
//        existing four preconditions, totaling 5.
// T-314: scripts/cycle-e2e-pass.sh exists, is executable, and emits a skip-with-reason
//        for E-008 when the host's `sui --version` is out of supported range, without
//        spawning `pnpm deploy-all`.
import { describe, it, expect } from 'vitest';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCENARIOS_JSON = path.join(REPO_ROOT, '.forge', 'e2e', 'scenarios.json');
const E2E_PASS_SCRIPT = path.join(REPO_ROOT, 'scripts', 'cycle-e2e-pass.sh');

interface Scenario {
  id: string;
  name: string;
  preconditions: string[];
  steps?: string[];
}

describe('AC-2.5: scenarios.json E-008 preconditions list contains Sui CLI 1.63.2-1.64.1 range (T-313)', () => {
  it('T-313: scenarios.json E-008 preconditions list contains the Sui CLI 1.63.2-1.64.1 range', () => {
    const raw = fs.readFileSync(SCENARIOS_JSON, 'utf8');
    const scenarios: Scenario[] = JSON.parse(raw);

    const e008 = scenarios.find((s) => s.id === 'E-008');
    expect(e008, 'E-008 scenario must exist').toBeDefined();
    expect(Array.isArray(e008!.preconditions)).toBe(true);

    // Look for a precondition string that mentions Sui CLI AND both version anchors.
    // Allow either en-dash (–, U+2013) or ASCII hyphen between the two anchors —
    // we check each numeric anchor independently so the test is not brittle to
    // unicode normalization.
    const matching = e008!.preconditions.find(
      (s) =>
        /Sui\s+CLI/i.test(s) &&
        s.indexOf('1.63.2') !== -1 &&
        s.indexOf('1.64.1') !== -1,
    );
    expect(
      matching,
      `expected E-008 preconditions to include a 'Sui CLI 1.63.2-1.64.1' string; got: ${JSON.stringify(
        e008!.preconditions,
      )}`,
    ).toBeDefined();

    // The other four preconditions remain (addition, not replacement).
    const dockerPre = e008!.preconditions.find((s) => /Docker Desktop/i.test(s));
    const learningPre = e008!.preconditions.find((s) =>
      /learning-output-style/i.test(s),
    );
    const sandboxPre = e008!.preconditions.find((s) =>
      /deepbook-sandbox/i.test(s),
    );
    const notDeployedPre = e008!.preconditions.find((s) =>
      /NOT currently deployed/i.test(s),
    );
    expect(dockerPre).toBeDefined();
    expect(learningPre).toBeDefined();
    expect(sandboxPre).toBeDefined();
    expect(notDeployedPre).toBeDefined();

    // Total length must be 5 (four existing + one added).
    expect(e008!.preconditions.length).toBe(5);
  });
});

describe('AC-2.5: cycle-e2e-pass.sh emits skip-with-reason for E-008 (T-314)', () => {
  it('T-314: cycle-e2e-pass.sh emits skip-with-reason for E-008 when host sui-cli is out of supported range', () => {
    // Script must exist and be executable.
    expect(fs.existsSync(E2E_PASS_SCRIPT), `missing: ${E2E_PASS_SCRIPT}`).toBe(true);
    const stat = fs.statSync(E2E_PASS_SCRIPT);
    // mode bits 0o111 — at least one of u/g/o has +x.
    expect(
      (stat.mode & 0o111) !== 0,
      `not executable: ${E2E_PASS_SCRIPT} (mode=${stat.mode.toString(8)})`,
    ).toBe(true);

    // Build a temp PATH with a fake `sui` shim that prints an out-of-range version.
    const tempBin = fs.mkdtempSync(path.join(os.tmpdir(), 'sui-course-c6-shim-'));
    try {
      const suiShim = path.join(tempBin, 'sui');
      // The shim is a minimal bash script that prints "sui 1.69.2-abc" on stdout
      // and exits 0 — out of the 1.63.2-1.64.1 range.
      fs.writeFileSync(
        suiShim,
        '#!/bin/bash\necho "sui 1.69.2-abc"\nexit 0\n',
        { mode: 0o755 },
      );

      // Spawn the script with PATH prepended. Pass 'E-008' as a positional
      // argument in case the script supports scenario filtering; if it does
      // not, the assertion still holds because we inspect output for E-008
      // skip lines specifically.
      const result = spawnSync(
        'bash',
        [E2E_PASS_SCRIPT, 'E-008'],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            PATH: `${tempBin}:${process.env.PATH ?? ''}`,
          },
          encoding: 'utf8',
          timeout: 30000,
        },
      );

      // Phase F round-2 fast-follow: skip exit code is now 77 (autotools
      // convention) so CI can distinguish skip from pass. 0 (legacy) and 77
      // are both treated as "not a failure" here for forward/back compat.
      expect(
        result.status === 0 || result.status === 77,
        `script exited unexpected status ${result.status}; stdout=${result.stdout}; stderr=${result.stderr}`,
      ).toBe(true);

      const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

      // E-008 must be named, with a skip indicator, and must reference 'sui'
      // (case-insensitive — the reason names the probe).
      expect(combined.indexOf('E-008'), combined).toBeGreaterThan(-1);
      expect(/skip(ped)?|SKIP/i.test(combined), combined).toBe(true);
      expect(/sui/i.test(combined), combined).toBe(true);

      // No real deploy was spawned.
      expect(combined.indexOf('pnpm deploy-all'), combined).toBe(-1);
    } finally {
      try {
        fs.rmSync(tempBin, { recursive: true, force: true });
      } catch {
        /* swallow */
      }
    }
  });
});
