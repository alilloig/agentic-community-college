import { describe, expect, it } from 'vitest';
import {
  validateCourseProbe,
  validateCourseProbes,
} from '../mcp/server/src/schemas/courseProbes.js';

function base(over: Record<string, unknown> = {}) {
  return {
    id: 'sample-probe',
    kind: 'shell-exit-zero',
    message_pass: 'ok',
    message_fail: 'not ok',
    params: { command: 'sample' },
    ...over,
  };
}

describe('validateCourseProbe — common fields', () => {
  it('accepts a minimal shell-exit-zero probe', () => {
    const r = validateCourseProbe(base(), 'probe');
    expect(r.ok).toBe(true);
  });

  it('rejects non-objects', () => {
    for (const bad of [null, 1, 'x', []]) {
      expect(validateCourseProbe(bad, 'probe').ok).toBe(false);
    }
  });

  it('rejects unknown kind', () => {
    const r = validateCourseProbe(base({ kind: 'magic' }), 'probe');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/kind/);
  });

  it('rejects missing message_pass / message_fail', () => {
    expect(validateCourseProbe(base({ message_pass: '' }), 'probe').ok).toBe(false);
    expect(validateCourseProbe(base({ message_fail: undefined }), 'probe').ok).toBe(false);
  });
});

describe('validateCourseProbe — filesystem-exists', () => {
  it('accepts a valid path', () => {
    const r = validateCourseProbe(
      {
        id: 'fs',
        kind: 'filesystem-exists',
        message_pass: 'found',
        message_fail: 'missing',
        params: { path: '~/workspace/something' },
      },
      'probe',
    );
    expect(r.ok).toBe(true);
  });

  it('rejects when params.path is missing', () => {
    const r = validateCourseProbe(
      {
        id: 'fs',
        kind: 'filesystem-exists',
        message_pass: 'a',
        message_fail: 'b',
        params: {},
      },
      'probe',
    );
    expect(r.ok).toBe(false);
  });
});

describe('validateCourseProbe — http-get', () => {
  it('accepts a minimal http-get probe', () => {
    const r = validateCourseProbe(
      {
        id: 'http',
        kind: 'http-get',
        message_pass: 'up',
        message_fail: 'down',
        params: { url: 'http://localhost:9009/manifest' },
      },
      'probe',
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'http-get') {
      expect(r.value.params.expected_status).toBeUndefined();
    }
  });

  it('rejects bad expected_body_regex', () => {
    const r = validateCourseProbe(
      {
        id: 'http',
        kind: 'http-get',
        message_pass: 'a',
        message_fail: 'b',
        params: { url: 'http://x', expected_body_regex: '(unclosed' },
      },
      'probe',
    );
    expect(r.ok).toBe(false);
  });

  it('rejects non-positive timeout_ms', () => {
    const r = validateCourseProbe(
      {
        id: 'http',
        kind: 'http-get',
        message_pass: 'a',
        message_fail: 'b',
        params: { url: 'http://x', timeout_ms: 0 },
      },
      'probe',
    );
    expect(r.ok).toBe(false);
  });
});

describe('validateCourseProbe — shell-exit-zero', () => {
  it('accepts command + args + regex', () => {
    const r = validateCourseProbe(
      {
        id: 'sh',
        kind: 'shell-exit-zero',
        message_pass: 'a',
        message_fail: 'b',
        params: {
          command: 'node',
          args: ['--version'],
          expected_stdout_regex: '^v\\d+',
        },
      },
      'probe',
    );
    expect(r.ok).toBe(true);
  });

  it('rejects non-string args entry', () => {
    const r = validateCourseProbe(
      {
        id: 'sh',
        kind: 'shell-exit-zero',
        message_pass: 'a',
        message_fail: 'b',
        params: { command: 'node', args: ['--version', 42] },
      },
      'probe',
    );
    expect(r.ok).toBe(false);
  });
});

describe('validateCourseProbe — claude-plugin-enabled', () => {
  it('accepts a plugin key', () => {
    const r = validateCourseProbe(
      {
        id: 'plug',
        kind: 'claude-plugin-enabled',
        message_pass: 'a',
        message_fail: 'b',
        params: { plugin_key: 'sui-pilot@claude-plugins-official' },
      },
      'probe',
    );
    expect(r.ok).toBe(true);
  });

  it('rejects missing plugin_key', () => {
    const r = validateCourseProbe(
      {
        id: 'plug',
        kind: 'claude-plugin-enabled',
        message_pass: 'a',
        message_fail: 'b',
        params: {},
      },
      'probe',
    );
    expect(r.ok).toBe(false);
  });
});

describe('validateCourseProbe — remediation', () => {
  it('accepts a shell remediation', () => {
    const r = validateCourseProbe(
      {
        ...base(),
        remediation: { kind: 'shell', command: 'echo ok', cwd: '~/workspace', timeout_ms: 30000 },
      },
      'probe',
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.remediation?.cwd).toBe('~/workspace');
  });

  it('rejects remediation.kind other than shell', () => {
    const r = validateCourseProbe(
      { ...base(), remediation: { kind: 'mcp-tool', command: 'x' } },
      'probe',
    );
    expect(r.ok).toBe(false);
  });
});

describe('validateCourseProbes — list-level', () => {
  it('accepts an empty list', () => {
    const r = validateCourseProbes([]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('rejects non-array input', () => {
    expect(validateCourseProbes({}).ok).toBe(false);
  });

  it('rejects duplicate ids within the same course', () => {
    const r = validateCourseProbes([base(), base()]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicated/);
  });

  it('forwards per-probe validation errors', () => {
    const r = validateCourseProbes([base({ kind: 'nope' })]);
    expect(r.ok).toBe(false);
  });
});
