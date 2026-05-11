import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { loadState } from '../state.js';
import { probeOutputStyle } from '../outputStyle.js';
import { discoverCourses } from '../pluginsRoot.js';
import { loadLessonBySlug } from '../registry.js';

export interface AdvanceArtifactResult {
  ok: boolean;
  errors?: string[];
  /** Absolute path to the rendered artifact.html (if the lesson declares one). */
  artifact_path?: string;
  /** Absolute path to the sibling state JSON the page polls. */
  artifact_state_path?: string;
  /** True when the lesson has no `artifact` block and there was nothing to do. */
  noop?: boolean;
}

interface ArtifactStateFile {
  cursor: number;
  mode: 'learning' | 'explanatory';
  revealed: string[];
  total_sections: number;
  updated_at: string;
}

const DEFAULT_STATE_FILENAME = 'artifact-state.json';
const RENDERED_ARTIFACT_FILENAME = 'artifact.html';

export async function runAdvanceArtifact({
  projectRoot,
}: {
  projectRoot: string;
}): Promise<AdvanceArtifactResult> {
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
  const discovery = discoverCourses();
  const loaded = loadLessonBySlug(discovery.courses, state.selected_lesson);
  if (!loaded.ok) {
    return { ok: false, errors: [loaded.error] };
  }
  const { lesson, sections, info } = loaded;

  if (!lesson.artifact) {
    return { ok: true, noop: true };
  }

  // Resolve the artifact destination. Prefer the workspace if one exists so
  // the rendered HTML lives next to the learner's code.
  const dest = state.workspace_path ?? projectRoot;
  const stateFilename = lesson.artifact.state_filename ?? DEFAULT_STATE_FILENAME;
  const artifactPath = path.join(dest, RENDERED_ARTIFACT_FILENAME);
  const artifactStatePath = path.join(dest, stateFilename);

  // Copy the template into place (idempotent — overwrite is fine, it's
  // self-contained content). The browser tab the user opened once stays
  // pointed at this path forever.
  const templateAbs = path.join(info.lesson_dir, lesson.artifact.template);
  try {
    await fsPromises.mkdir(dest, { recursive: true });
    await fsPromises.copyFile(templateAbs, artifactPath);
  } catch (err) {
    return {
      ok: false,
      errors: [`artifact-template-copy-failed: ${(err as Error).message}`],
    };
  }

  const revealed: string[] = [];
  const upTo = Math.min(state.section_cursor + 1, sections.sections.length);
  for (let i = 0; i < upTo; i++) {
    revealed.push(sections.sections[i].artifact_section_id);
  }
  const stateBody: ArtifactStateFile = {
    cursor: state.section_cursor,
    mode: state.selected_output_style,
    revealed,
    total_sections: sections.sections.length,
    updated_at: new Date().toISOString(),
  };

  // Atomic write using the same tmp+fsync+rename pattern as state.ts.
  const bytes = JSON.stringify(stateBody, null, 2);
  const tmpPath = path.join(
    dest,
    `.artifact-state.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  await fsPromises.writeFile(tmpPath, bytes, { flag: 'wx', mode: 0o600 });
  const handle = await fsPromises.open(tmpPath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsPromises.rename(tmpPath, artifactStatePath);

  return {
    ok: true,
    artifact_path: artifactPath,
    artifact_state_path: artifactStatePath,
  };
}
