import { loadState, saveState, STATE_SCHEMA_VERSION } from '../state.js';
import type { State, OutputStyleKind } from '../schemas/state.js';
import { probeOutputStyle } from '../outputStyle.js';
import { discoverCourses } from '../pluginsRoot.js';
import { loadLessonBySlug } from '../registry.js';
import { prepareWorkspace, WorkspacePrepareError } from '../workspace.js';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

export interface SelectLessonResult {
  ok: boolean;
  errors?: string[];
  warnings?: Array<{ kind: string; message: string }>;
  description?: string;
  /** Free-form prompts the conductor walks through to call setPersonalization. */
  personalizationPrompts?: Array<{
    name: string;
    type: 'integer' | 'enum';
    range?: { min: number; max: number; default: number };
    enum?: string[];
    default?: string | number;
  }>;
  /** Surfaces the output-mode picker for the conductor. */
  outputModePrompt?: {
    message: string;
    options: OutputStyleKind[];
  };
  /** Probe IDs the course-engine must run via runPreflightProbe before
   * advancing to setPersonalization. Empty/absent when the lesson declares
   * no prerequisites. */
  prerequisites?: string[];
  workspacePath?: string;
  workspaceCreated?: boolean;
  workspaceArchivedTo?: string;
}

const DEFAULT_OUTPUT_STYLE: OutputStyleKind = 'learning';

export async function runSelectLesson({
  projectRoot,
  slug,
}: {
  projectRoot: string;
  slug: string;
}): Promise<SelectLessonResult> {
  const styleCheck = await probeOutputStyle();
  if (!styleCheck.ok) {
    return { ok: false, errors: ['output-style-disabled'] };
  }

  // Schema-mismatch / corrupt states bubble up; the learner is expected to
  // re-run selectLesson which mints fresh v4 state.
  const stateResult = await loadState(projectRoot);
  if (stateResult.kind === 'corrupt') {
    // Surface the diagnostic but proceed to mint fresh state (the corruption
    // archive flow already preserved the original bytes).
  } else if (stateResult.kind === 'schema-mismatch') {
    // v3 (or older) state on disk → ignore it and mint fresh v4. Old file
    // is left untouched on disk so the user can recover if they want.
  }

  const discovery = discoverCourses();
  if (discovery.courses.length === 0) {
    return {
      ok: false,
      errors: [
        'No ACC course plugins are enabled. Install/enable a content plugin and try again.',
      ],
    };
  }

  const loaded = loadLessonBySlug(discovery.courses, slug);
  if (!loaded.ok) {
    return { ok: false, errors: [loaded.error] };
  }
  const { lesson, info } = loaded;

  let workspacePath: string | undefined;
  let workspaceCreated: boolean | undefined;
  let workspaceArchivedTo: string | undefined;
  if (lesson.workspace) {
    try {
      const ws = await prepareWorkspace(lesson.slug, info.lesson_dir, lesson);
      workspacePath = ws.workspacePath;
      workspaceCreated = ws.created;
      workspaceArchivedTo = ws.archivedTo;
    } catch (err) {
      if (err instanceof WorkspacePrepareError) {
        return { ok: false, errors: [`workspace-prepare-failed (${err.kind}): ${err.message}`] };
      }
      return { ok: false, errors: [`workspace-prepare-failed: ${(err as Error).message}`] };
    }
  }

  // Mint fresh state. selected_output_style defaults to 'learning'; the
  // conductor will overwrite via setOutputMode after asking the learner.
  const fresh: State = {
    schema_version: STATE_SCHEMA_VERSION,
    selected_lesson: info.namespaced_slug,
    selected_output_style: DEFAULT_OUTPUT_STYLE,
    personalization: {},
    section_cursor: 0,
    history: [
      { ts: new Date().toISOString(), event: `selectLesson:${info.namespaced_slug}` },
    ],
  };
  if (workspacePath !== undefined) fresh.workspace_path = workspacePath;

  try {
    await saveState(projectRoot, fresh);
  } catch (err) {
    return { ok: false, errors: [`state-save-failed: ${(err as Error).message}`] };
  }

  // Render description.md (lesson-level overview) if present.
  let description: string | undefined;
  try {
    const descPath = path.join(info.lesson_dir, 'description.md');
    description = await fsPromises.readFile(descPath, 'utf8');
  } catch {
    /* optional; absent is fine */
  }

  // Build the personalization-prompt shape the conductor surfaces.
  const personalizationPrompts: SelectLessonResult['personalizationPrompts'] = [];
  for (const optName of lesson.personalization_options) {
    const range = lesson.personalization_ranges?.[optName];
    if (!range) continue;
    if ('values' in range) {
      personalizationPrompts.push({
        name: optName,
        type: 'enum',
        enum: range.values,
        default: range.default,
      });
    } else {
      personalizationPrompts.push({
        name: optName,
        type: 'integer',
        range: { min: range.min, max: range.max, default: range.default },
      });
    }
  }

  const result: SelectLessonResult = {
    ok: true,
    outputModePrompt: {
      message:
        'Pick an output mode. `learning` paces sections so the load-bearing pieces are left for you to write; `explanatory` implements + narrates everything.',
      options: ['learning', 'explanatory'],
    },
  };
  if (description !== undefined) result.description = description;
  if (personalizationPrompts.length > 0) result.personalizationPrompts = personalizationPrompts;
  if (lesson.prerequisites && lesson.prerequisites.length > 0) {
    result.prerequisites = lesson.prerequisites;
  }
  if (workspacePath !== undefined) result.workspacePath = workspacePath;
  if (workspaceCreated !== undefined) result.workspaceCreated = workspaceCreated;
  if (workspaceArchivedTo !== undefined) result.workspaceArchivedTo = workspaceArchivedTo;

  return result;
}
