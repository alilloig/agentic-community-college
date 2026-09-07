// outputStyle.ts — advisory check + opt-in writer for the Claude Code output
// style in `~/.claude/settings.json`.
//
// ACC v0.3 recommends the built-in `Concise` style: the chat stays short and
// every explanation lives in the HTML artifacts. Nothing here gates a tool.
// `start` reports the status; `setOutputStyle` writes the value only when the
// learner said yes.

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWriteFile } from './atomicWrite.js';

export const RECOMMENDED_OUTPUT_STYLE = 'Concise';

export interface OutputStyleWarning {
  kind: 'settings-file-missing' | 'settings-parse-error';
  message: string;
}

export interface OutputStyleStatus {
  /** The `outputStyle` value in settings.json, or null when unset/unreadable. */
  active: string | null;
  recommended: typeof RECOMMENDED_OUTPUT_STYLE;
  /** True when `active` is the recommended style (case-insensitive). */
  ok: boolean;
  warning?: OutputStyleWarning;
}

export function settingsPath(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), '.claude', 'settings.json');
}

interface ReadSettingsResult {
  parsed: Record<string, unknown> | null;
  warning?: OutputStyleWarning;
}

function readSettings(homeDir?: string): ReadSettingsResult {
  const file = settingsPath(homeDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {
      parsed: null,
      warning: { kind: 'settings-file-missing', message: `Settings file not found at ${file}` },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      parsed: null,
      warning: {
        kind: 'settings-parse-error',
        message: `Failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      parsed: null,
      warning: { kind: 'settings-parse-error', message: `${file} must contain a JSON object` },
    };
  }
  return { parsed: parsed as Record<string, unknown> };
}

/** Read the active output style name. `null` when unset or unreadable. */
export function readActiveOutputStyle(homeDir?: string): string | null {
  const { parsed } = readSettings(homeDir);
  const style = parsed?.['outputStyle'];
  return typeof style === 'string' && style.length > 0 ? style : null;
}

export function getOutputStyleStatus(homeDir?: string): OutputStyleStatus {
  const { parsed, warning } = readSettings(homeDir);
  const raw = parsed?.['outputStyle'];
  const active = typeof raw === 'string' && raw.length > 0 ? raw : null;
  const status: OutputStyleStatus = {
    active,
    recommended: RECOMMENDED_OUTPUT_STYLE,
    ok: active !== null && active.toLowerCase() === RECOMMENDED_OUTPUT_STYLE.toLowerCase(),
  };
  if (warning) status.warning = warning;
  return status;
}

export type WriteOutputStyleResult =
  | { ok: true; previous: string | null; path: string }
  | { ok: false; error: string };

/**
 * Persist `outputStyle` into settings.json. Creates the file when absent,
 * refuses to overwrite a file it cannot parse (so a hand-edited settings file
 * with a syntax error is never clobbered), preserves the existing file mode.
 */
export async function writeOutputStyle(
  style: string,
  homeDir?: string,
): Promise<WriteOutputStyleResult> {
  const file = settingsPath(homeDir);
  const { parsed, warning } = readSettings(homeDir);
  if (warning && warning.kind === 'settings-parse-error') {
    return { ok: false, error: warning.message };
  }
  const settings = parsed ?? {};
  const previousRaw = settings['outputStyle'];
  const previous = typeof previousRaw === 'string' ? previousRaw : null;
  settings['outputStyle'] = style;

  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    /* new file */
  }
  try {
    await fsPromises.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, `${JSON.stringify(settings, null, 2)}\n`, {
      mode,
      tmpPrefix: '.settings.json.tmp',
    });
  } catch (err) {
    return { ok: false, error: `Failed to write ${file}: ${(err as Error).message}` };
  }
  return { ok: true, previous, path: file };
}
