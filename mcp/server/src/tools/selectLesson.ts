import { loadState, saveState, STATE_SCHEMA_VERSION } from '../state.js';
import type { State } from '../schemas/state.js';
import { discoverCourses } from '../pluginsRoot.js';
import { loadLessonBySlug } from '../registry.js';
import { prepareWorkspace, WorkspacePrepareError } from '../workspace.js';
import {
  accConfigExists,
  loadAccConfig,
  AccConfigError,
  type AccConfig,
} from '../settings.js';
import { resolveCoursePaths, envVarsFor } from '../pathResolver.js';
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
  /** Probe IDs the course-engine must run via runPreflightProbe before
   * advancing to setPersonalization. Empty/absent when the lesson declares
   * no prerequisites. */
  prerequisites?: string[];
  workspacePath?: string;
  workspaceCreated?: boolean;
  workspaceArchivedTo?: string;
  /** Solution files removed from a freshly seeded workspace. */
  workspaceStrippedFiles?: string[];
  /** Surfaces the one-time first-run setup prompt to the conductor. The
   * conductor calls `configureWorkspace` once with the learner's chosen
   * workspace_root and never sees this field again. Absent when the user
   * already has a `~/.acc/config.json`. */
  firstRunSetup?: {
    needsWorkspaceRoot: boolean;
    defaultWorkspaceRoot: string;
  };
}

export async function runSelectLesson({
  projectRoot,
  slug,
  homeDir,
}: {
  projectRoot: string;
  slug: string;
  /** Test seam for the ACC config home — defaults to `os.homedir()`. */
  homeDir?: string;
}): Promise<SelectLessonResult> {
  // Load state purely for its side effect — corrupt JSON triggers the archive
  // flow inside `loadState`, and a schema-mismatch leaves the old file on disk
  // so the user can recover. Either way we proceed to mint fresh v5 state.
  await loadState(projectRoot);

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

  // Resolve the owning course's `${paths.<id>}` declarations into absolute
  // paths so we can both surface them to the conductor and inject them as
  // env vars into any workspace install spawn. Done BEFORE workspace prep so
  // the install command sees the env on first creation.
  const owningCourse = discovery.courses.find((c) => c.name === info.course_name);
  const configFromDisk = await accConfigExists(homeDir);
  let accConfig: AccConfig;
  try {
    accConfig = await loadAccConfig(homeDir);
  } catch (err) {
    if (err instanceof AccConfigError) {
      return { ok: false, errors: [`acc-config-${err.kind}: ${err.message}`] };
    }
    // Any other throw shouldn't happen — loadAccConfig wraps every read/parse
    // failure in AccConfigError. Surface as a hard error rather than silently
    // falling back to defaults (which would hide the broken config from the
    // learner and ignore their override).
    return {
      ok: false,
      errors: [`acc-config-unexpected: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  const resolvedPaths = owningCourse && owningCourse.paths.length > 0
    ? resolveCoursePaths(owningCourse.name, owningCourse.paths, accConfig, homeDir)
    : {};
  const pathEnv = envVarsFor(resolvedPaths);

  let workspacePath: string | undefined;
  let workspaceCreated: boolean | undefined;
  let workspaceArchivedTo: string | undefined;
  let workspaceStrippedFiles: string[] | undefined;
  if (lesson.workspace) {
    try {
      const ws = await prepareWorkspace(lesson.slug, info.lesson_dir, lesson, {
        pathEnv,
      });
      workspacePath = ws.workspacePath;
      workspaceCreated = ws.created;
      workspaceArchivedTo = ws.archivedTo;
      workspaceStrippedFiles = ws.strippedFiles;
    } catch (err) {
      if (err instanceof WorkspacePrepareError) {
        return { ok: false, errors: [`workspace-prepare-failed (${err.kind}): ${err.message}`] };
      }
      return { ok: false, errors: [`workspace-prepare-failed: ${(err as Error).message}`] };
    }
  }

  // Mint fresh v5 state: cursor at chapter 0, no artifacts yet.
  const fresh: State = {
    schema_version: STATE_SCHEMA_VERSION,
    selected_lesson: info.namespaced_slug,
    personalization: {},
    chapter_cursor: 0,
    history: [
      { ts: new Date().toISOString(), event: `selectLesson:${info.namespaced_slug}` },
    ],
    artifacts: {},
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

  const result: SelectLessonResult = { ok: true };
  if (description !== undefined) result.description = description;
  if (personalizationPrompts.length > 0) result.personalizationPrompts = personalizationPrompts;
  if (lesson.prerequisites && lesson.prerequisites.length > 0) {
    result.prerequisites = lesson.prerequisites;
  }
  if (workspacePath !== undefined) result.workspacePath = workspacePath;
  if (workspaceCreated !== undefined) result.workspaceCreated = workspaceCreated;
  if (workspaceArchivedTo !== undefined) result.workspaceArchivedTo = workspaceArchivedTo;
  if (workspaceStrippedFiles !== undefined && workspaceStrippedFiles.length > 0) {
    result.workspaceStrippedFiles = workspaceStrippedFiles;
  }

  // One-time nudge: surface a friendly first-run prompt the very first time
  // a learner picks a lesson. Idempotent — once they call `configureWorkspace`
  // and a `~/.acc/config.json` exists, this field stops appearing.
  if (!configFromDisk) {
    result.firstRunSetup = {
      needsWorkspaceRoot: true,
      defaultWorkspaceRoot: accConfig.workspace_root,
    };
  }

  return result;
}
