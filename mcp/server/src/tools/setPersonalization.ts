import { loadState, saveState } from '../state.js';
import {
  validatePersonalizationValues,
  type PersonalizationOptionDecl,
} from '../personalization.js';
import { probeOutputStyle } from '../outputStyle.js';
import { discoverCourses } from '../pluginsRoot.js';
import { loadLessonBySlug } from '../registry.js';

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
  // Output-style gate before any state load.
  const styleCheck = await probeOutputStyle();
  if (!styleCheck.ok) {
    return { ok: false, errors: ['output-style-disabled'] };
  }

  const stateResult = await loadState(projectRoot);
  if (stateResult.kind === 'corrupt') {
    return { ok: false, errors: [`State corrupt: ${stateResult.message}`] };
  }
  if (stateResult.kind === 'schema-mismatch') {
    return { ok: false, errors: [`State schema mismatch: ${stateResult.message}`] };
  }
  if (stateResult.kind === 'absent' || !stateResult.state.selected_lesson) {
    return { ok: false, errors: ['No lesson selected. Call selectLesson first.'] };
  }

  const state = stateResult.state;
  const namespacedSlug = state.selected_lesson;

  const discovery = discoverCourses();
  const loaded = loadLessonBySlug(discovery.courses, namespacedSlug);
  if (!loaded.ok) {
    return { ok: false, errors: [loaded.error] };
  }
  const lesson = loaded.lesson;

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
    const e = err as Error;
    return { ok: false, errors: [`state-save-failed: ${e.message}`] };
  }

  return { ok: true };
}

export const setPersonalization = runSetPersonalization;
