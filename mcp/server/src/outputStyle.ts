// outputStyle.ts — the one reader of `~/.claude/settings.json`, plus the
// advisory output-style check and its opt-in writer.
//
// ACC v0.3 recommends the built-in `Concise` style: the chat stays short and
// every explanation lives in the HTML artifacts. Nothing here gates a tool.
// `start` reports the status; `setOutputStyle` writes the value only when the
// learner said yes. `dynamicProbes` and `nextChapter` reuse
// `readClaudeSettings` / `isClaudePluginEnabled` for plugin checks.

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWriteFile } from './atomicWrite.js';
import type { OutputStyleWarning } from './warnings.js';

export type { OutputStyleWarning };

export const RECOMMENDED_OUTPUT_STYLE = 'Concise';

export type ClaudeSettingsResult =
  | { ok: true; file: string; settings: Record<string, unknown> }
  | {
      ok: false;
      file: string;
      /** `missing` is ENOENT only. Any other read failure is `read-error`. */
      kind: 'missing' | 'read-error' | 'parse-error' | 'not-object';
      detail: string;
    };

/** Read and parse `~/.claude/settings.json` without throwing. */
export function readClaudeSettings(homeDir?: string): ClaudeSettingsResult {
  const file = path.join(homeDir ?? os.homedir(), '.claude', 'settings.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      file,
      kind: code === 'ENOENT' ? 'missing' : 'read-error',
      detail: (err as Error).message,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, file, kind: 'parse-error', detail: (err as Error).message };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, file, kind: 'not-object', detail: 'settings.json must contain a JSON object' };
  }
  return { ok: true, file, settings: parsed as Record<string, unknown> };
}

/** True iff `enabledPlugins[pluginKey] === true` in settings.json. */
export function isClaudePluginEnabled(pluginKey: string, homeDir?: string): boolean {
  const settings = readClaudeSettings(homeDir);
  if (!settings.ok) return false;
  const enabled = settings.settings['enabledPlugins'];
  if (typeof enabled !== 'object' || enabled === null || Array.isArray(enabled)) return false;
  return (enabled as Record<string, unknown>)[pluginKey] === true;
}

export interface OutputStyleStatus {
  /** The `outputStyle` value in settings.json, or null when unset/unreadable. */
  active: string | null;
  recommended: typeof RECOMMENDED_OUTPUT_STYLE;
  /** True when `active` is the recommended style (case-insensitive). */
  ok: boolean;
  warning?: OutputStyleWarning;
}

function warningFor(result: Extract<ClaudeSettingsResult, { ok: false }>): OutputStyleWarning {
  switch (result.kind) {
    case 'missing':
      return { kind: 'settings-file-missing', message: `Settings file not found at ${result.file}` };
    case 'read-error':
      return { kind: 'settings-read-error', message: `Failed to read ${result.file}: ${result.detail}` };
    default:
      return { kind: 'settings-parse-error', message: `Failed to parse ${result.file}: ${result.detail}` };
  }
}

export function getOutputStyleStatus(homeDir?: string): OutputStyleStatus {
  const settings = readClaudeSettings(homeDir);
  const raw = settings.ok ? settings.settings['outputStyle'] : undefined;
  const active = typeof raw === 'string' && raw.length > 0 ? raw : null;
  const status: OutputStyleStatus = {
    active,
    recommended: RECOMMENDED_OUTPUT_STYLE,
    ok: active !== null && active.toLowerCase() === RECOMMENDED_OUTPUT_STYLE.toLowerCase(),
  };
  if (!settings.ok) status.warning = warningFor(settings);
  return status;
}

export type WriteOutputStyleResult =
  | { ok: true; previous: string | null; path: string }
  | { ok: false; error: string };

/**
 * Persist `outputStyle` into settings.json. Creates the file only when it is
 * absent (ENOENT). Any file that exists but cannot be read or parsed is left
 * untouched, so an unreadable or hand-edited settings file is never
 * clobbered. Preserves the existing file mode.
 */
export async function writeOutputStyle(
  style: string,
  homeDir?: string,
): Promise<WriteOutputStyleResult> {
  const read = readClaudeSettings(homeDir);
  if (!read.ok && read.kind !== 'missing') {
    return { ok: false, error: warningFor(read).message };
  }
  const file = read.file;
  const settings = read.ok ? read.settings : {};
  const previousRaw = settings['outputStyle'];
  const previous = typeof previousRaw === 'string' ? previousRaw : null;
  settings['outputStyle'] = style;

  let mode = 0o600;
  if (read.ok) {
    try {
      mode = (await fsPromises.stat(file)).mode & 0o777;
    } catch {
      /* keep the private default */
    }
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
