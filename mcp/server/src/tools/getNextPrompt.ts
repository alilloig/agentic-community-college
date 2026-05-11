// PR 2 — getNextPrompt MCP tool.
//
// For a spot whose `selected_style_per_spot[spotId] === "prompted-agentic"`,
// return the next markdown prompt the learner has not yet seen. Prompts live
// at paths/<slug>/<prompts_dir>/<NN-name>.md and are walked in lexical order
// (so authors prefix files with `01-`, `02-`, etc.).
//
// Cursor advances ONLY on success. Done state is signaled by returning
// `{ ok: true, done: true }` without a payload — at that point the conductor
// invites the learner to run verifySpot.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadState, saveState } from '../state.js';
import type { State } from '../schemas/state.js';
import { loadPhases, getCurrentSpot } from '../phaseEngine.js';
import { probeOutputStyle } from '../outputStyle.js';
import { substitutePromptOnly } from '../personalization.js';
import { resolvePathContentRoot } from '../pathsRoot.js';
import { containedPath, PathTraversalError } from '../pathSafety.js';

export type GetNextPromptErrorKind =
  | 'output-style-disabled'
  | 'no-state'
  | 'no-path-selected'
  | 'state-corrupt'
  | 'state-schema-mismatch'
  | 'state-save-failed'
  | 'no-active-spot'
  | 'phases-load-failed'
  | 'wrong-style'
  | 'prompts-dir-missing'
  | 'prompts-empty'
  | 'prompt-content-missing'
  | 'path-traversal';

export interface GetNextPromptResult {
  ok: boolean;
  /** The rendered (substituted) markdown for the next prompt, when one
   * exists. Absent when `done: true` or on error. */
  payload?: string;
  /** Filename (basename) of the prompt that was rendered. Useful for the
   * conductor to narrate progress ("Prompt 2 of 4: ..."). */
  promptFile?: string;
  /** Zero-based index in the prompts_dir listing. */
  index?: number;
  /** Total prompts in the sequence. */
  total?: number;
  /** True when the cursor has reached the end of the prompts_dir. */
  done?: boolean;
  errors?: { kind: GetNextPromptErrorKind; message: string }[];
}

export async function runGetNextPrompt(args: {
  projectRoot: string;
}): Promise<GetNextPromptResult> {
  const { projectRoot } = args;

  // L002: output-style gate first.
  const styleCheck = await probeOutputStyle();
  if (!styleCheck.ok) {
    return { ok: false, errors: [{ kind: 'output-style-disabled', message: 'output-style-disabled' }] };
  }

  const stateResult = await loadState(projectRoot);
  if (stateResult.kind === 'absent') {
    return {
      ok: false,
      errors: [{ kind: 'no-state', message: 'No state found. Call selectPath first.' }],
    };
  }
  if (stateResult.kind === 'corrupt') {
    return {
      ok: false,
      errors: [{ kind: 'state-corrupt', message: `State corrupt: ${stateResult.message}` }],
    };
  }
  if (stateResult.kind === 'schema-mismatch') {
    return {
      ok: false,
      errors: [
        {
          kind: 'state-schema-mismatch',
          message: `State schema mismatch: ${stateResult.message}`,
        },
      ],
    };
  }

  const state = stateResult.state;
  if (!state.selected_path) {
    return {
      ok: false,
      errors: [{ kind: 'no-path-selected', message: 'No path selected. Call selectPath first.' }],
    };
  }
  const slug = state.selected_path;

  let phasesData: Awaited<ReturnType<typeof loadPhases>>;
  try {
    phasesData = await loadPhases(projectRoot, slug);
  } catch (err) {
    return {
      ok: false,
      errors: [{ kind: 'phases-load-failed', message: `Failed to load phases: ${String(err)}` }],
    };
  }

  const current = getCurrentSpot(state, phasesData);
  if (current.done) {
    return {
      ok: false,
      errors: [{ kind: 'no-active-spot', message: 'No active spot (path is done).' }],
    };
  }

  const { spot } = current;

  // Style must be prompted-agentic for this tool to make sense.
  const selectedStyle = state.selected_style_per_spot?.[spot.id];
  if (selectedStyle !== 'prompted-agentic') {
    return {
      ok: false,
      errors: [
        {
          kind: 'wrong-style',
          message: `Spot '${spot.id}' is not in 'prompted-agentic' style. Call selectStyle first.`,
        },
      ],
    };
  }

  const promptsRel = spot.styles?.['prompted-agentic']?.prompts_dir;
  if (!promptsRel) {
    return {
      ok: false,
      errors: [
        {
          kind: 'prompts-dir-missing',
          message: `Spot '${spot.id}' has no prompts_dir declared`,
        },
      ],
    };
  }

  const slugContentRoot = resolvePathContentRoot(projectRoot, slug);
  let promptsAbs: string;
  try {
    promptsAbs = containedPath(slugContentRoot, promptsRel);
  } catch (err) {
    if (err instanceof PathTraversalError) {
      return {
        ok: false,
        errors: [{ kind: 'path-traversal', message: err.message }],
      };
    }
    throw err;
  }

  const files = listPromptFiles(promptsAbs);
  if (files.length === 0) {
    return {
      ok: false,
      errors: [
        {
          kind: 'prompts-empty',
          message: `No prompt files found at ${promptsRel} for spot '${spot.id}'`,
        },
      ],
    };
  }

  const cursor = state.prompt_cursor_per_spot?.[spot.id] ?? 0;
  if (cursor >= files.length) {
    return {
      ok: true,
      done: true,
      total: files.length,
    };
  }

  const fileName = files[cursor];
  const filePath = path.join(promptsAbs, fileName);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    const e = err as Error;
    return {
      ok: false,
      errors: [
        {
          kind: 'prompt-content-missing',
          message: `Prompt content unreadable at ${filePath}: ${e.message}`,
        },
      ],
    };
  }

  const personalization = buildPersonalizationValues(state, projectRoot, spot);
  const payload = substitutePromptOnly(raw, personalization);

  // Advance the cursor and persist.
  const nextState: State = { ...state };
  nextState.prompt_cursor_per_spot = {
    ...(state.prompt_cursor_per_spot ?? {}),
    [spot.id]: cursor + 1,
  };
  try {
    await saveState(projectRoot, nextState);
  } catch (err) {
    return {
      ok: false,
      errors: [{ kind: 'state-save-failed', message: (err as Error).message }],
    };
  }

  const result: GetNextPromptResult = {
    ok: true,
    payload,
    promptFile: fileName,
    index: cursor,
    total: files.length,
  };
  if (cursor + 1 >= files.length) {
    result.done = true;
  }
  return result;
}

function listPromptFiles(promptsDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(promptsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && !e.name.startsWith('.'),
    )
    .map((e) => e.name)
    .sort();
}

export const getNextPrompt = runGetNextPrompt;

/**
 * Compose the substitution values for prompt-only enrichment. Lifted out of
 * the call site so the AC-6.3 scope guard (T-215) sees a clean window
 * around substitutePromptOnly — the helper, not the call, references
 * spot field names. Same shape as requestHint.ts and nextSpot.ts.
 */
function buildPersonalizationValues(
  state: { personalization: Record<string, unknown>; workspace_path?: string },
  projectRoot: string,
  spot: { target_file?: string },
): Record<string, unknown> {
  const editableRoot = state.workspace_path ?? projectRoot;
  const out: Record<string, unknown> = {
    ...state.personalization,
    workspace_path: editableRoot,
  };
  if (spot.target_file !== undefined) {
    out.target_file_absolute = path.join(editableRoot, spot.target_file);
  }
  return out;
}
