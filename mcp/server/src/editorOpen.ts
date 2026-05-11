// F-004 — bonus tmux affordance.
//
// When the MCP server runs inside a tmux session ($TMUX is set in the
// process env Claude Code forwards) AND $EDITOR resolves to a recognized
// editor, nextSpot can emit a ready-to-paste `tmux split-window` command.
// The conductor agent surfaces it as an option — the learner runs it
// manually if they want a side-by-side editor pane. No automatic dispatch;
// the agent never runs this on its own.

import * as path from 'node:path';

const RECOGNIZED_VIM_LIKE = ['nvim', 'vim', 'vi', 'mvim'];

export interface EditorOpenContext {
  /** Absolute path to the file the learner should open. */
  filePath: string;
  /** First line of the spot's target_range (1-indexed). Defaults to 1. */
  line?: number;
  /** Process env subset. Tests inject; production passes process.env. */
  env: NodeJS.ProcessEnv;
}

/**
 * Compute a safe `tmux split-window` invocation. Returns null when the
 * environment doesn't support the affordance (no TMUX, no recognized
 * EDITOR, etc.). The returned string contains no shell metacharacters
 * outside the quoted argument so it can be displayed to the user without
 * extra escaping concerns.
 */
export function buildTmuxOpenCommand(ctx: EditorOpenContext): string | null {
  const tmux = ctx.env.TMUX;
  if (!tmux || tmux.length === 0) return null;

  const editor = (ctx.env.EDITOR ?? '').trim();
  if (editor.length === 0) return null;

  // Strip any flags from $EDITOR — we only key on the binary basename.
  // $EDITOR=`code --wait` is common; we want `code` for the dispatch.
  const head = editor.split(/\s+/)[0] ?? '';
  const baseName = path.basename(head).toLowerCase();
  if (baseName.length === 0) return null;

  const line = ctx.line && ctx.line > 0 ? ctx.line : 1;
  const filePath = ctx.filePath;

  let invocation: string | null = null;
  if (RECOGNIZED_VIM_LIKE.includes(baseName)) {
    // vim / nvim: `+<line> <file>` jumps to the line.
    invocation = `${editor} +${line} ${singleQuote(filePath)}`;
  } else if (baseName === 'code' || baseName === 'cursor') {
    invocation = `${editor} -g ${singleQuote(`${filePath}:${line}`)}`;
  } else if (baseName === 'emacs') {
    invocation = `${editor} +${line} ${singleQuote(filePath)}`;
  } else if (baseName === 'helix' || baseName === 'hx') {
    invocation = `${editor} ${singleQuote(filePath)}:${line}`;
  } else {
    // Unrecognized editor — bail rather than fabricate a command that
    // might not understand the line argument.
    return null;
  }

  return `tmux split-window -h ${singleQuote(invocation)}`;
}

/**
 * POSIX-safe single-quoting. Empty string becomes `''`. Embedded single
 * quotes become `'\''`.
 */
function singleQuote(s: string): string {
  if (s.length === 0) return "''";
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Parse `target_range` (e.g. "39-58") into the start line, defaulting to 1. */
export function startLineFromRange(rangeStr: string | undefined): number {
  if (!rangeStr) return 1;
  const m = /^(\d+)-/.exec(rangeStr);
  if (!m) return 1;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
