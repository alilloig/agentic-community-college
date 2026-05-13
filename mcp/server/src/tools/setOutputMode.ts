import { saveState } from '../state.js';
import type { OutputStyleKind } from '../schemas/state.js';
import { readActiveOutputStyle } from '../outputStyle.js';
import { runSetupGate } from './setupGate.js';

export interface SetOutputModeResult {
  ok: boolean;
  errors?: string[];
  warnings?: Array<{ kind: string; message: string }>;
}

/**
 * Persist the learner's chosen output mode (`learning` or `explanatory`) into
 * v4 state. Called by the conductor after `selectLesson` and before
 * `setPersonalization`.
 *
 * If the requested mode doesn't match what the Claude Code session is actually
 * configured for (read from `~/.claude/settings.json`), surface a warning so
 * the user can switch via `/output-style`. The mode itself is still persisted
 * — ACC doesn't enforce session-style alignment, it just nudges.
 */
export async function runSetOutputMode({
  projectRoot,
  style,
}: {
  projectRoot: string;
  style: OutputStyleKind;
}): Promise<SetOutputModeResult> {
  const gate = await runSetupGate(projectRoot);
  if (!gate.ok) {
    return { ok: false, errors: gate.errors };
  }

  if (style !== 'learning' && style !== 'explanatory') {
    return { ok: false, errors: [`Invalid output style: ${style}`] };
  }

  const updated = { ...gate.state, selected_output_style: style };
  try {
    await saveState(projectRoot, updated);
  } catch (err) {
    return { ok: false, errors: [`state-save-failed: ${(err as Error).message}`] };
  }

  // Soft warning if the requested mode doesn't match the active Claude Code style.
  const warnings: SetOutputModeResult['warnings'] = [];
  const active = readActiveOutputStyle();
  if ((active === 'learning' || active === 'explanatory') && active !== style) {
    warnings.push({
      kind: 'output-style-mismatch',
      message: `You picked ${style} in ACC, but Claude Code is currently in '${active}'. Switch via /output-style ${style} for the intended pacing.`,
    });
  }

  return warnings.length > 0 ? { ok: true, warnings } : { ok: true };
}
