// F-004 — buildTmuxOpenCommand unit tests.

import { describe, expect, it } from 'vitest';
import {
  buildTmuxOpenCommand,
  startLineFromRange,
} from '../mcp/server/src/editorOpen.js';

describe('buildTmuxOpenCommand — environment gates', () => {
  it('returns null when TMUX is unset', () => {
    const cmd = buildTmuxOpenCommand({
      filePath: '/tmp/foo/App.tsx',
      line: 39,
      env: { EDITOR: 'nvim' },
    });
    expect(cmd).toBeNull();
  });

  it('returns null when EDITOR is unset', () => {
    const cmd = buildTmuxOpenCommand({
      filePath: '/tmp/foo/App.tsx',
      line: 39,
      env: { TMUX: '/private/tmp/tmux-501/default,1234,0' },
    });
    expect(cmd).toBeNull();
  });

  it('returns null for an unrecognized editor', () => {
    const cmd = buildTmuxOpenCommand({
      filePath: '/tmp/foo/App.tsx',
      line: 39,
      env: { TMUX: 'x', EDITOR: 'butterfly' },
    });
    expect(cmd).toBeNull();
  });
});

describe('buildTmuxOpenCommand — known editors', () => {
  const env = { TMUX: '/tmp/tmux-501/default,1234,0' };

  it('emits +<line> file pattern for nvim', () => {
    const cmd = buildTmuxOpenCommand({
      filePath: '/tmp/foo/App.tsx',
      line: 39,
      env: { ...env, EDITOR: 'nvim' },
    });
    expect(cmd).toBe(
      "tmux split-window -h 'nvim +39 '\\''/tmp/foo/App.tsx'\\'''",
    );
  });

  it('emits +<line> file pattern for vim', () => {
    const cmd = buildTmuxOpenCommand({
      filePath: '/tmp/foo/App.tsx',
      line: 12,
      env: { ...env, EDITOR: 'vim' },
    });
    expect(cmd).toContain('vim +12');
    expect(cmd).toContain('App.tsx');
  });

  it('emits -g file:line pattern for code', () => {
    const cmd = buildTmuxOpenCommand({
      filePath: '/tmp/foo/App.tsx',
      line: 100,
      env: { ...env, EDITOR: 'code' },
    });
    expect(cmd).toContain("code -g '\\''/tmp/foo/App.tsx:100'\\''");
  });

  it('emits +<line> file pattern for emacs', () => {
    const cmd = buildTmuxOpenCommand({
      filePath: '/tmp/foo/x.ts',
      line: 7,
      env: { ...env, EDITOR: 'emacs' },
    });
    expect(cmd).toContain('emacs +7');
  });

  it('emits file:line pattern for helix', () => {
    const cmd = buildTmuxOpenCommand({
      filePath: '/tmp/foo/x.ts',
      line: 7,
      env: { ...env, EDITOR: 'hx' },
    });
    expect(cmd).toContain("hx '\\''/tmp/foo/x.ts'\\''" + ':7');
  });
});

describe('buildTmuxOpenCommand — flags in EDITOR', () => {
  const env = { TMUX: '/tmp/tmux-501/default,1234,0' };

  it('keeps additional flags from $EDITOR', () => {
    const cmd = buildTmuxOpenCommand({
      filePath: '/tmp/foo/App.tsx',
      line: 39,
      env: { ...env, EDITOR: 'code --wait' },
    });
    expect(cmd).toContain('code --wait -g');
  });
});

describe('buildTmuxOpenCommand — quoting', () => {
  const env = { TMUX: '/tmp/tmux-501/default,1234,0', EDITOR: 'nvim' };

  it('escapes embedded single quotes safely', () => {
    const cmd = buildTmuxOpenCommand({
      filePath: "/tmp/it's-a-trap/App.tsx",
      line: 1,
      env,
    });
    expect(cmd).toContain(`'\\''`);
    expect(cmd).toContain('App.tsx');
  });
});

describe('buildTmuxOpenCommand — line defaults', () => {
  const env = { TMUX: 'x', EDITOR: 'nvim' };

  it('defaults line to 1 when omitted', () => {
    const cmd = buildTmuxOpenCommand({ filePath: '/tmp/foo/App.tsx', env });
    expect(cmd).toContain('+1');
  });

  it('defaults line to 1 when zero or negative', () => {
    const cmd1 = buildTmuxOpenCommand({ filePath: '/tmp/x.ts', line: 0, env });
    expect(cmd1).toContain('+1');
    const cmd2 = buildTmuxOpenCommand({ filePath: '/tmp/x.ts', line: -3, env });
    expect(cmd2).toContain('+1');
  });
});

describe('startLineFromRange', () => {
  it('parses 39-58 to 39', () => {
    expect(startLineFromRange('39-58')).toBe(39);
  });

  it('returns 1 when range is undefined', () => {
    expect(startLineFromRange(undefined)).toBe(1);
  });

  it('returns 1 when range is malformed', () => {
    expect(startLineFromRange('not-a-range')).toBe(1);
  });

  it('returns 1 when start would be 0 or negative', () => {
    expect(startLineFromRange('0-10')).toBe(1);
  });
});
