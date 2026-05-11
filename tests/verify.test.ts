import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Modules under test — none of these exist yet at red phase.
import {
  runVerification,
  VerificationModeUnsupportedError,
  parseCommand,
} from '../mcp/server/src/verify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// SpawnFn shape mirrors mcp/server/src/preflight.ts:SpawnFn — sync return.
type SpawnFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
) => { status: number | null; stdout: string; stderr: string };

describe('runVerification — compile mode (A8)', () => {
  it('T-216: spawns the spot\'s command with cwd=projectRoot and returns { pass: true } on exit 0', async () => {
    const spawnSpy = vi.fn<Parameters<SpawnFn>, ReturnType<SpawnFn>>(() => ({
      status: 0,
      stdout: 'built',
      stderr: '',
    }));

    const result: any = await runVerification(
      { mode: 'compile', command: 'pnpm build' },
      '/tmp/proj-fixture',
      { spawn: spawnSpy as unknown as SpawnFn },
    );

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const call = spawnSpy.mock.calls[0];
    expect(call[0]).toBe('pnpm');
    expect(call[1][0]).toBe('build');
    const opts = call[2] ?? {};
    expect(opts.cwd).toBe('/tmp/proj-fixture');

    expect(result.pass).toBe(true);
    expect(typeof result.output).toBe('string');
    expect(result.output).toContain('built');
  });

  it('T-217: returns { pass: false } on non-zero exit and surfaces stdout+stderr', async () => {
    const spawnSpy = vi.fn<Parameters<SpawnFn>, ReturnType<SpawnFn>>(() => ({
      status: 1,
      stdout: 'X',
      stderr: 'syntax error',
    }));
    const result: any = await runVerification(
      { mode: 'compile', command: 'pnpm build' },
      '/tmp/proj',
      { spawn: spawnSpy as unknown as SpawnFn },
    );
    expect(result.pass).toBe(false);
    const out = String(result.output ?? '');
    expect(out).toContain('X');
    expect(out).toContain('syntax error');
  });

  it('T-218: spawn-rejection (ENOENT) surfaces as pass:false with the error message in output (no throw)', async () => {
    const enoent = Object.assign(new Error('ENOENT: pnpm not found'), { code: 'ENOENT' });
    const spawnSpy: SpawnFn = () => {
      throw enoent;
    };
    let caught: unknown;
    let result: any;
    try {
      result = await runVerification(
        { mode: 'compile', command: 'pnpm build' },
        '/tmp/proj',
        { spawn: spawnSpy },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeUndefined();
    expect(result.pass).toBe(false);
    const out = String(result.output ?? '');
    expect(/ENOENT|pnpm/.test(out)).toBe(true);
  });

  it("T-219: splits 'pnpm build' into cmd='pnpm', args=['build']", async () => {
    const spawnSpy = vi.fn<Parameters<SpawnFn>, ReturnType<SpawnFn>>(() => ({
      status: 0,
      stdout: '',
      stderr: '',
    }));
    await runVerification(
      { mode: 'compile', command: 'pnpm build' },
      '/tmp/proj',
      { spawn: spawnSpy as unknown as SpawnFn },
    );
    expect(spawnSpy.mock.calls[0][0]).toBe('pnpm');
    expect(spawnSpy.mock.calls[0][1]).toEqual(['build']);
  });
});

describe('runVerification — unsupported modes (A8)', () => {
  it('T-220: test mode throws VerificationModeUnsupportedError', async () => {
    let caught: unknown;
    try {
      await runVerification({ mode: 'test', command: 'pnpm test' } as any, '/tmp/proj');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VerificationModeUnsupportedError);
    const err = caught as Error & { mode?: string };
    expect(err.mode === 'test' || /test/i.test(err.message ?? '')).toBe(true);
  });

  it('T-221: simulate mode throws VerificationModeUnsupportedError', async () => {
    let caught: unknown;
    try {
      await runVerification(
        { mode: 'simulate', endpoint: 'http://x/manifest', expected_status: 200 } as any,
        '/tmp/proj',
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VerificationModeUnsupportedError);
    expect(/simulate/i.test((caught as Error).message ?? '')).toBe(true);
  });

  it('T-222: custom mode throws VerificationModeUnsupportedError', async () => {
    let caught: unknown;
    try {
      await runVerification(
        { mode: 'custom', command: 'echo x', expected_stdout_regex: '^x' } as any,
        '/tmp/proj',
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VerificationModeUnsupportedError);
    expect(/custom/i.test((caught as Error).message ?? '')).toBe(true);
  });
});

describe('verify.ts source-level guards (A8)', () => {
  it('T-223: contains exactly one spawn-invoking branch (the compile adapter)', () => {
    const sourcePath = path.join(REPO_ROOT, 'mcp', 'server', 'src', 'verify.ts');
    const content = fs.readFileSync(sourcePath, 'utf8');
    // Count occurrences of opts.spawn(...) / spawn(...) call expressions —
    // matching the per-call injection seam used by the probe pattern. We
    // tolerate `: SpawnFn` type annotations by counting call-expression-shaped
    // occurrences only (an open paren after the identifier).
    const callRe = /(?:opts\.)?\bspawn\b\s*\(/g;
    const matches = content.match(callRe) ?? [];
    expect(matches.length).toBeLessThanOrEqual(1);
  });
});

describe('VerificationModeUnsupportedError shape (A8)', () => {
  it('T-289: carries a structured mode field', async () => {
    let caught: unknown;
    try {
      await runVerification(
        { mode: 'simulate', endpoint: 'http://x', expected_status: 200 } as any,
        '/tmp/proj',
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VerificationModeUnsupportedError);
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { mode?: string };
    expect(err.mode === 'simulate' || /simulate/i.test(err.message ?? '')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseCommand — A14 (cycle-4 L001 carry-forward)
// ---------------------------------------------------------------------------

describe('parseCommand — shell-style parser (A14)', () => {
  it("T-074: parseCommand('pnpm build') returns cmd:'pnpm', args:['build']", () => {
    const r = parseCommand('pnpm build');
    expect(r.cmd).toBe('pnpm');
    expect(r.args).toEqual(['build']);
  });

  it("T-075: parseCommand('pnpm run build') returns cmd:'pnpm', args:['run','build']", () => {
    const r = parseCommand('pnpm run build');
    expect(r.cmd).toBe('pnpm');
    expect(r.args).toEqual(['run', 'build']);
  });

  it("T-076: parseCommand('pnpm \"build with spaces\" -x') keeps the quoted segment as a single arg", () => {
    const r = parseCommand('pnpm "build with spaces" -x');
    expect(r.cmd).toBe('pnpm');
    expect(r.args).toEqual(['build with spaces', '-x']);
  });

  it("T-077: parseCommand collapses runs of whitespace ('   pnpm   build   ') → cmd:'pnpm', args:['build']", () => {
    const r = parseCommand('   pnpm   build   ');
    expect(r.cmd).toBe('pnpm');
    expect(r.args).toEqual(['build']);
  });

  it("T-078: parseCommand('') throws an Error", () => {
    // Sanity guard: parseCommand must actually be the exported helper.
    // Otherwise this test would pass vacuously when parseCommand is undefined
    // and the TypeError("not a function") satisfies the Error subclass check.
    expect(typeof parseCommand).toBe('function');
    let caught: unknown;
    try {
      parseCommand('');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    // Must NOT be a "not a function" TypeError — the helper has to exist.
    expect((caught as Error).message ?? '').not.toMatch(/is not a function/i);
    expect(typeof (caught as Error).message).toBe('string');
    expect((caught as Error).message.length).toBeGreaterThan(0);
  });

  it("T-079: parseCommand('   ') throws an Error", () => {
    expect(typeof parseCommand).toBe('function');
    let caught: unknown;
    try {
      parseCommand('   ');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message ?? '').not.toMatch(/is not a function/i);
  });

  it("T-080: verify.ts source contains zero literal command.split(' ') occurrences", () => {
    const sourcePath = path.join(REPO_ROOT, 'mcp', 'server', 'src', 'verify.ts');
    const content = fs.readFileSync(sourcePath, 'utf8');
    expect(/command\.split\(\s*['"] ['"]\s*\)/.test(content)).toBe(false);
  });

  it("T-081: compile adapter consumes parseCommand output (spawn receives quoted arg)", async () => {
    type SF = (
      cmd: string,
      args: string[],
      opts?: { cwd?: string; timeout?: number },
    ) => { status: number | null; stdout: string; stderr: string };
    const spy = vi.fn<Parameters<SF>, ReturnType<SF>>(() => ({
      status: 0,
      stdout: '',
      stderr: '',
    }));
    await runVerification(
      { mode: 'compile', command: 'pnpm "build dir" -x' },
      '/tmp/proj',
      { spawn: spy as unknown as SF },
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('pnpm');
    expect(spy.mock.calls[0][1]).toEqual(['build dir', '-x']);
  });
});
