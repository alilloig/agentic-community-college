import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWriteFile } from '../atomicWrite.js';
import { runSetupGate } from './setupGate.js';

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
 * Inject `<script>window.__ACC_STATE__ = {...};</script>` into the template.
 * The template's own poller script reads `window.__ACC_STATE__`
 * synchronously on load and applies section visibility before (or instead
 * of) the `fetch` poller — so the page renders correctly even on `file://`,
 * where most browsers block `fetch` of local JSON.
 *
 * Anchor preference: an explicit `<!-- ACC_STATE -->` marker, otherwise the
 * closing `</body>` tag. A template lacking both is treated as malformed —
 * silently appending the script to a non-HTML file would let the artifact
 * render wrong without any signal back to the conductor, which is worse
 * than failing loudly.
 */
function injectStateIntoHtml(html: string, state: ArtifactStateFile):
  | { ok: true; html: string }
  | { ok: false; error: string } {
  const inlined = `<script>window.__ACC_STATE__ = ${JSON.stringify(state)};</script>`;
  const markerRe = /<!--\s*ACC_STATE\s*-->/i;
  if (markerRe.test(html)) {
    return { ok: true, html: html.replace(markerRe, inlined) };
  }
  const closingBodyRe = /<\/body\s*>/i;
  if (closingBodyRe.test(html)) {
    return { ok: true, html: html.replace(closingBodyRe, `${inlined}\n</body>`) };
  }
  return {
    ok: false,
    error: 'artifact-template-malformed: template has neither an <!-- ACC_STATE --> marker nor a </body> tag; cannot inject state',
  };
}

export async function runAdvanceArtifact({
  projectRoot,
}: {
  projectRoot: string;
}): Promise<AdvanceArtifactResult> {
  const gate = await runSetupGate(projectRoot);
  if (!gate.ok) {
    return { ok: false, errors: gate.errors };
  }
  const { state, loaded } = gate;
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
  const injected = injectStateIntoHtml(template, stateBody);
  if (!injected.ok) {
    return { ok: false, errors: [injected.error] };
  }

  try {
    await fsPromises.mkdir(dest, { recursive: true });
    // Atomic write so a refreshing browser tab never sees a torn HTML file
    // mid-rewrite. Mode 0o644 because the artifact must be readable by the
    // browser process (which on macOS often runs under the same user but
    // hits stricter permission checks via sandboxing).
    await atomicWriteFile(artifactPath, injected.html, {
      mode: 0o644,
      tmpPrefix: '.artifact.tmp',
    });
  } catch (err) {
    return {
      ok: false,
      errors: [`artifact-html-write-failed: ${(err as Error).message}`],
    };
  }

  // Sibling JSON — same atomic pattern. Polling is optional now (the inlined
  // state is the source of truth for file://) but the JSON is still useful
  // when the artifact is served over http://.
  try {
    await atomicWriteFile(
      artifactStatePath,
      JSON.stringify(stateBody, null, 2),
      { mode: 0o600, tmpPrefix: '.artifact-state.tmp' },
    );
  } catch (err) {
    return {
      ok: false,
      errors: [`artifact-state-write-failed: ${(err as Error).message}`],
    };
  }

  return {
    ok: true,
    artifact_path: artifactPath,
    artifact_state_path: artifactStatePath,
  };
}
