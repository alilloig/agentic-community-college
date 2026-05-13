import { saveState } from '../state.js';
import {
  validatePersonalizationValues,
  type PersonalizationOptionDecl,
} from '../personalization.js';
import { runSetupGate } from './setupGate.js';

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
  const gate = await runSetupGate(projectRoot);
  if (!gate.ok) {
    return { ok: false, errors: gate.errors };
  }
  const { state, loaded } = gate;
  const { lesson } = loaded;
  const namespacedSlug = state.selected_lesson;

  // Build declared options from the lesson's personalization block.
  const declaredOptions: PersonalizationOptionDecl[] = [];
  for (const optName of lesson.personalization_options) {
    const range = lesson.personalization_ranges?.[optName];
    if (range === undefined) {
      // Declared in personalization_options but no range = error: a well-formed
      // lesson always pairs them. Surface so the author fixes it.
      return {
        ok: false,
        errors: [
          `Lesson '${namespacedSlug}' declares personalization_options=${optName} but personalization_ranges has no entry for it.`,
        ],
      };
    }
    if ('values' in range) {
      declaredOptions.push({
        name: optName,
        type: 'enum',
        enum: range.values,
        default: range.default,
      });
    } else {
      declaredOptions.push({
        name: optName,
        type: 'integer',
        range: { min: range.min, max: range.max, default: range.default },
      });
    }
  }

  const validation = validatePersonalizationValues(values, declaredOptions);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }

  // Merge submitted values with defaults for any absent keys.
  const merged: Record<string, unknown> = {
    ...(state.personalization as Record<string, unknown>),
  };
  for (const opt of declaredOptions) {
    if (values[opt.name] !== undefined) {
      merged[opt.name] = values[opt.name];
    } else if (merged[opt.name] === undefined) {
      if (opt.type === 'integer' && opt.range !== undefined) {
        merged[opt.name] = opt.range.default;
      } else if (opt.type === 'enum' && opt.default !== undefined) {
        merged[opt.name] = opt.default;
      }
    }
  }

  const updated = { ...state, personalization: merged };
  try {
    await saveState(projectRoot, updated);
  } catch (err) {
    return { ok: false, errors: [`state-save-failed: ${(err as Error).message}`] };
  }

  return { ok: true };
}

export const setPersonalization = runSetPersonalization;
