import * as path from 'node:path';
import * as fsPromises from 'node:fs/promises';
import { loadState, saveState } from '../state.js';
import { validatePath } from '../schemas/path.js';
import type { PathData } from '../schemas/path.js';
import { validatePersonalizationValues } from '../personalization.js';
import type { PersonalizationOptionDecl } from '../personalization.js';
import { probeOutputStyle } from '../outputStyle.js';
import { resolvePathContentRoot } from '../pathsRoot.js';

export interface SetPersonalizationResult {
  ok: boolean;
  errors?: string[];
}

export async function runSetPersonalization({
  projectRoot,
  values,
}: {
  projectRoot: string;
  values: Record<string, unknown>;
}): Promise<SetPersonalizationResult> {
  // L002 carry-forward: outputStyleOk gate runs BEFORE any state load
  const styleCheck = await probeOutputStyle();
  if (!styleCheck.ok) {
    return { ok: false, errors: ['output-style-disabled'] };
  }

  // Load state — short-circuit on corrupt/schema-mismatch
  const stateResult = await loadState(projectRoot);
  if (stateResult.kind === 'corrupt') {
    return { ok: false, errors: [`State corrupt: ${stateResult.message}`] };
  }
  if (stateResult.kind === 'schema-mismatch') {
    return { ok: false, errors: [`State schema mismatch: ${stateResult.message}`] };
  }

  // Require selected_path
  if (stateResult.kind === 'absent' || !stateResult.state.selected_path) {
    return { ok: false, errors: ['No path selected. Call selectPath first.'] };
  }

  const state = stateResult.state;
  const slug = state.selected_path;

  // Load path.json to get declared options
  let pathData: PathData;
  try {
    const pathJsonPath = path.join(resolvePathContentRoot(projectRoot, slug), 'path.json');
    const raw = await fsPromises.readFile(pathJsonPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const validation = validatePath(parsed);
    if (!validation.ok) {
      return { ok: false, errors: [`Invalid path.json: ${validation.error}`] };
    }
    pathData = validation.value;
  } catch (err) {
    return { ok: false, errors: [`Failed to load path.json: ${String(err)}`] };
  }

  // Build declared options for validation
  const declaredOptions: PersonalizationOptionDecl[] = [];
  for (const opt of pathData.personalization_options) {
    if (opt === 'poll_interval_ms') {
      const range = pathData.personalization_ranges?.poll_interval_ms ?? {
        min: 1000,
        max: 30000,
        default: 3000,
      };
      declaredOptions.push({
        name: 'poll_interval_ms',
        type: 'integer',
        range: { min: range.min, max: range.max, default: range.default },
      });
    } else if (opt === 'pool_subset') {
      const ps = pathData.personalization_ranges?.pool_subset ?? {
        values: ['both', 'DEEP_SUI', 'SUI_USDC'],
        default: 'both',
      };
      declaredOptions.push({
        name: 'pool_subset',
        type: 'enum',
        enum: ps.values,
        default: ps.default,
      });
    }
  }

  // Validate the submitted values
  const validationResult = validatePersonalizationValues(values, declaredOptions);
  if (!validationResult.ok) {
    return { ok: false, errors: validationResult.errors };
  }

  // Apply defaults for absent keys (Use defaults path)
  const merged: Record<string, unknown> = { ...(state.personalization as Record<string, unknown>) };
  for (const opt of declaredOptions) {
    if (values[opt.name] !== undefined) {
      merged[opt.name] = values[opt.name];
    } else if (merged[opt.name] === undefined) {
      // Apply default when not already set and not provided
      if (opt.type === 'integer' && opt.range !== undefined) {
        merged[opt.name] = opt.range.default;
      } else if (opt.type === 'enum' && opt.default !== undefined) {
        merged[opt.name] = opt.default;
      }
    }
  }

  // Save state with merged personalization
  const updatedState = { ...state, personalization: merged };
  // M002 carry-forward: wrap saveState in try/catch
  try {
    await saveState(projectRoot, updatedState);
  } catch (err) {
    const e = err as Error;
    return { ok: false, errors: [`state-save-failed: ${e.message}`] };
  }

  return { ok: true };
}

// Alias export expected by tests
export const setPersonalization = runSetPersonalization;
