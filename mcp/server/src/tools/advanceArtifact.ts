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
  /** Absolute path to the sibling state JSON. Same shape as the inlined state
   * for downstream tooling / browsers that can fetch local files. */
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

/**
 * Inject `<script>window.__ACC_STATE__ = {...};</script>` into the template
 * right before the closing `</body>`. The template's own poller script reads
 * `window.__ACC_STATE__` synchronously on load and applies section visibility
 * before (or instead of) the `fetch` poller — so the page renders correctly
 * even on `file://`, where most browsers block `fetch` of local JSON.
 *
 * If the template already has a marker `<!-- ACC_STATE -->`, replace it.
 * Otherwise inject before `</body>`. If neither shape is present (degraded
 * template), append at the end as a last resort.
 */
function injectStateIntoHtml(html: string, state: ArtifactStateFile): string {
  const inlined = `<script>window.__ACC_STATE__ = ${JSON.stringify(state)};</script>`;
  const markerRe = /<!--\s*ACC_STATE\s*-->/i;
  if (markerRe.test(html)) {
    return html.replace(markerRe, inlined);
  }
  const closingBodyRe = /<\/body\s*>/i;
  if (closingBodyRe.test(html)) {
    return html.replace(closingBodyRe, `${inlined}\n</body>`);
  }
  return `${html}\n${inlined}\n`;
}

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

  const dest = state.workspace_path ?? projectRoot;
  const stateFilename = lesson.artifact.state_filename ?? DEFAULT_STATE_FILENAME;
  const artifactPath = path.join(dest, RENDERED_ARTIFACT_FILENAME);
  const artifactStatePath = path.join(dest, stateFilename);

  // Build the state body once; we inline it into the HTML AND write it as a
  // sibling JSON so hosted (http://) users can also use the optional poller.
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

  // Read the template, inject inline state, write artifact.html.
  const templateAbs = path.join(info.lesson_dir, lesson.artifact.template);
  let template: string;
  try {
    template = await fsPromises.readFile(templateAbs, 'utf8');
  } catch (err) {
    return {
      ok: false,
      errors: [`artifact-template-read-failed: ${(err as Error).message}`],
    };
  }
  const rendered = injectStateIntoHtml(template, stateBody);

  try {
    await fsPromises.mkdir(dest, { recursive: true });
    await fsPromises.writeFile(artifactPath, rendered, { mode: 0o644 });
  } catch (err) {
    return {
      ok: false,
      errors: [`artifact-html-write-failed: ${(err as Error).message}`],
    };
  }

  // Atomic write of the sibling JSON using the tmp+fsync+rename pattern.
  // Polling is now optional (the inlined state is the source of truth for
  // file://), but http-served use can still benefit from live updates.
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
