// selectStyle MCP tool — persist the learner's per-spot exercise-style choice.
//
// PR 2 (this PR): both styles are functional. 'fill-in-blank' uses the starter
// file under workspace.files; 'prompted-agentic' walks an ordered prompt
// sequence under styles.prompted-agentic.prompts_dir. The conductor agent
// should call selectStyle after nextSpot when the spot exposes multiple
// styles; if a spot has no styles block, selectStyle is a no-op for backward
// compat with legacy single-style paths.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadState, saveState } from '../state.js';
import type { State, SpotStyleKind } from '../schemas/state.js';
import { loadPhases } from '../phaseEngine.js';
import { probeOutputStyle } from '../outputStyle.js';
import type { SpotData } from '../schemas/phases.js';
import { resolvePathContentRoot } from '../pathsRoot.js';

export interface SelectStyleResult {
  ok: boolean;
  selected_style?: SpotStyleKind;
  errors?: string[];
}

export async function runSelectStyle(args: {
  projectRoot: string;
  spotId: unknown;
  style: unknown;
}): Promise<SelectStyleResult> {
  const { projectRoot } = args;

  // L002 carry-forward: outputStyleOk gate runs BEFORE any state load.
  const styleCheck = await probeOutputStyle();
  if (!styleCheck.ok) {
    return { ok: false, errors: ['output-style-disabled'] };
  }

  if (typeof args.spotId !== 'string' || args.spotId.length === 0) {
    return { ok: false, errors: ['Missing required parameter: spotId'] };
  }
  if (args.style !== 'fill-in-blank' && args.style !== 'prompted-agentic') {
    return {
      ok: false,
      errors: [`style must be 'fill-in-blank' or 'prompted-agentic', got: ${String(args.style)}`],
    };
  }
  const spotId = args.spotId;
  const style = args.style as SpotStyleKind;

  const stateResult = await loadState(projectRoot);
  if (stateResult.kind === 'absent' || (stateResult.kind === 'ok' && !stateResult.state.selected_path)) {
    return { ok: false, errors: ['No path selected. Call selectPath first.'] };
  }
  if (stateResult.kind === 'corrupt') {
    return { ok: false, errors: [`State corrupt: ${stateResult.message}`] };
  }
  if (stateResult.kind === 'schema-mismatch') {
    return { ok: false, errors: [`State schema mismatch: ${stateResult.message}`] };
  }

  const state = stateResult.state;
  const slug = state.selected_path;

  let phasesData: Awaited<ReturnType<typeof loadPhases>>;
  try {
    phasesData = await loadPhases(projectRoot, slug);
  } catch (err) {
    return { ok: false, errors: [`Failed to load phases: ${String(err)}`] };
  }

  const spot = findSpot(phasesData, spotId);
  if (!spot) {
    return { ok: false, errors: [`Unknown spotId: '${spotId}' is not declared in phases.json`] };
  }

  // If the spot has no styles block, the path is in legacy single-style mode
  // and selectStyle is meaningless. Treat as a no-op success — the caller
  // already has the only behavior it can have.
  if (!spot.styles) {
    return { ok: true, selected_style: style };
  }

  if (!spot.styles[style]) {
    return {
      ok: false,
      errors: [`Spot '${spotId}' does not declare style '${style}'`],
    };
  }

  if (style === 'prompted-agentic') {
    // PR 2: require the path to actually ship at least one prompt for the spot
    // before honoring the choice. If prompts_dir is empty or absent, fall
    // back with a clear error rather than silently selecting an empty flow.
    const promptsRel = spot.styles['prompted-agentic']?.prompts_dir;
    if (!promptsRel) {
      return {
        ok: false,
        errors: [`Spot '${spotId}' declares 'prompted-agentic' without a prompts_dir`],
      };
    }
    const promptsAbs = path.join(resolvePathContentRoot(projectRoot, slug), promptsRel);
    if (!hasAnyPromptFile(promptsAbs)) {
      return {
        ok: false,
        errors: [
          `prompts-not-authored: spot '${spotId}' declares 'prompted-agentic' but no prompts are authored at ${promptsRel} yet.`,
        ],
      };
    }
  }

  // Persist the choice.
  const next: State = { ...state };
  next.selected_style_per_spot = { ...(state.selected_style_per_spot ?? {}), [spotId]: style };
  try {
    await saveState(projectRoot, next);
  } catch (err) {
    return { ok: false, errors: [`state-save-failed: ${(err as Error).message}`] };
  }

  return { ok: true, selected_style: style };
}

function findSpot(
  phasesData: Awaited<ReturnType<typeof loadPhases>>,
  spotId: string,
): SpotData | null {
  for (const phase of phasesData.phases) {
    for (const s of phase.spots) {
      if (s.id === spotId) return s;
    }
  }
  return null;
}

function hasAnyPromptFile(promptsDir: string): boolean {
  try {
    const entries = fs.readdirSync(promptsDir, { withFileTypes: true });
    return entries.some(
      (e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && !e.name.startsWith('.'),
    );
  } catch {
    return false;
  }
}

// Alias export for symmetry with the other tools.
export const selectStyle = runSelectStyle;
