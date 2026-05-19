import { describe, expect, it } from 'vitest';
import {
  validateContentPaths,
  validateProbePathRefs,
  collectProbePathRefs,
  PATHS_REF_RE,
} from '../mcp/server/src/schemas/contentPaths.js';
import type { CourseProbeDecl } from '../mcp/server/src/schemas/courseProbes.js';

describe('validateContentPaths — per-decl', () => {
  it('accepts a minimal decl', () => {
    const r = validateContentPaths([{ id: 'sandbox', default: 'deepbook-sandbox' }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0].id).toBe('sandbox');
      expect(r.value[0].default).toBe('deepbook-sandbox');
    }
  });

  it('accepts a decl with description', () => {
    const r = validateContentPaths([
      { id: 'sandbox', default: 'sb', description: 'the deepbook sandbox checkout' },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value[0].description).toBe('the deepbook sandbox checkout');
  });

  it('rejects ids with uppercase / dot / space', () => {
    for (const bad of ['Sandbox', 'sand.box', 'sand box', 'sand/box', '']) {
      expect(validateContentPaths([{ id: bad, default: 'x' }]).ok).toBe(false);
    }
  });

  it('accepts ids with digits, underscores, hyphens', () => {
    for (const good of ['sandbox', 'sand-box', 'sand_box', 's1', 'sb-2025']) {
      const r = validateContentPaths([{ id: good, default: 'x' }]);
      expect(r.ok).toBe(true);
    }
  });

  it("rejects default values containing '/', '\\', '..', or starting with '~'", () => {
    for (const bad of ['nested/dir', 'win\\dir', '..', '../escape', '~/abs', '.']) {
      const r = validateContentPaths([{ id: 'sandbox', default: bad }]);
      expect(r.ok).toBe(false);
    }
  });

  it("rejects 'evil/../path' default", () => {
    const r = validateContentPaths([{ id: 'sandbox', default: 'evil/../path' }]);
    expect(r.ok).toBe(false);
  });

  it('rejects duplicate ids within the same course', () => {
    const r = validateContentPaths([
      { id: 'sandbox', default: 'a' },
      { id: 'sandbox', default: 'b' },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicated/);
  });

  it('rejects non-array input', () => {
    expect(validateContentPaths({}).ok).toBe(false);
    expect(validateContentPaths('paths').ok).toBe(false);
    expect(validateContentPaths(null).ok).toBe(false);
  });

  it('rejects non-string description', () => {
    const r = validateContentPaths([
      { id: 'sandbox', default: 'sb', description: 42 } as unknown as object,
    ]);
    expect(r.ok).toBe(false);
  });

  it('accepts an empty list', () => {
    const r = validateContentPaths([]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });
});

describe('collectProbePathRefs', () => {
  it('finds refs in filesystem-exists params.path', () => {
    const probe: CourseProbeDecl = {
      id: 'sandbox-here',
      kind: 'filesystem-exists',
      message_pass: 'ok',
      message_fail: 'no',
      params: { path: '${paths.sandbox}' },
    };
    const refs = collectProbePathRefs(probe);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ id: 'sandbox', location: 'params.path' });
  });

  it('finds refs in shell-exit-zero args[]', () => {
    const probe: CourseProbeDecl = {
      id: 'ls',
      kind: 'shell-exit-zero',
      message_pass: 'ok',
      message_fail: 'no',
      params: { command: 'ls', args: ['-la', '${paths.sandbox}'] },
    };
    const refs = collectProbePathRefs(probe);
    expect(refs.map((r) => r.location)).toEqual(['params.args[1]']);
  });

  it('finds refs in remediation command and cwd', () => {
    const probe: CourseProbeDecl = {
      id: 'has-sandbox',
      kind: 'filesystem-exists',
      message_pass: 'ok',
      message_fail: 'no',
      params: { path: '${paths.sandbox}' },
      remediation: {
        kind: 'shell',
        command: 'git clone https://example.com/repo "${paths.sandbox}"',
        cwd: '${paths.sandbox}',
      },
    };
    const refs = collectProbePathRefs(probe);
    expect(refs.map((r) => r.location).sort()).toEqual(
      ['params.path', 'remediation.command', 'remediation.cwd'].sort(),
    );
  });
});

describe('validateProbePathRefs — cross-reference', () => {
  function fsProbe(path: string): CourseProbeDecl {
    return {
      id: 'p',
      kind: 'filesystem-exists',
      message_pass: 'ok',
      message_fail: 'no',
      params: { path },
    };
  }

  it('passes when every reference is declared', () => {
    const r = validateProbePathRefs(new Set(['sandbox']), [fsProbe('${paths.sandbox}/sub')]);
    expect(r.ok).toBe(true);
  });

  it('fails on an undeclared reference', () => {
    const r = validateProbePathRefs(new Set(['sandbox']), [fsProbe('${paths.typo}')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/typo/);
  });

  it('fails when a remediation cwd references an unknown id', () => {
    const probe: CourseProbeDecl = {
      ...fsProbe('${paths.sandbox}'),
      remediation: { kind: 'shell', command: 'echo ok', cwd: '${paths.elsewhere}' },
    };
    const r = validateProbePathRefs(new Set(['sandbox']), [probe]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/remediation\.cwd/);
  });

  it('passes when probes have zero refs and paths is empty', () => {
    const probe: CourseProbeDecl = {
      id: 'p',
      kind: 'shell-exit-zero',
      message_pass: 'ok',
      message_fail: 'no',
      params: { command: 'docker', args: ['info'] },
    };
    const r = validateProbePathRefs(new Set(), [probe]);
    expect(r.ok).toBe(true);
  });
});

describe('PATHS_REF_RE', () => {
  it('matches the canonical token shape', () => {
    PATHS_REF_RE.lastIndex = 0;
    const m = '${paths.sandbox}/sub'.matchAll(PATHS_REF_RE);
    expect([...m].map((x) => x[1])).toEqual(['sandbox']);
  });
});
