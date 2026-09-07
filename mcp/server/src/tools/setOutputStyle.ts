import {
  RECOMMENDED_OUTPUT_STYLE,
  writeOutputStyle,
} from '../outputStyle.js';

export interface SetOutputStyleResult {
  ok: boolean;
  errors?: string[];
  /** Value that was in settings.json before the write (null when unset). */
  previous?: string | null;
  /** Absolute path of the settings file written. */
  path?: string;
  /** What the learner must do for the change to apply to the running session. */
  note?: string;
}

/**
 * Persist the recommended output style into `~/.claude/settings.json`.
 * Only `Concise` is accepted: ACC never sets a style the learner did not
 * pick, and the skill only calls this after an explicit yes.
 */
export async function runSetOutputStyle({
  style,
  homeDir,
}: {
  style: string;
  /** Test seam — defaults to `os.homedir()`. */
  homeDir?: string;
}): Promise<SetOutputStyleResult> {
  if (style !== RECOMMENDED_OUTPUT_STYLE) {
    return {
      ok: false,
      errors: [`Only '${RECOMMENDED_OUTPUT_STYLE}' can be set through ACC (got ${JSON.stringify(style)}).`],
    };
  }
  const written = await writeOutputStyle(style, homeDir);
  if (!written.ok) {
    return { ok: false, errors: [written.error] };
  }
  return {
    ok: true,
    previous: written.previous,
    path: written.path,
    note: `outputStyle is now '${style}' in ${written.path}. If the running session did not pick it up, run /output-style ${style}.`,
  };
}
