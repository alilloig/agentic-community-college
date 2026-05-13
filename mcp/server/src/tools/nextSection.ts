import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { substitutePromptOnly } from '../personalization.js';
import { runSetupGate } from './setupGate.js';

export interface NextSectionResult {
  ok: boolean;
  errors?: string[];
  done?: boolean;
  /** Total sections in the lesson — surfaced so the conductor can render "N of M". */
  total?: number;
  /** Zero-based index of the section returned. Equals state.section_cursor on success. */
  index?: number;
  section?: {
    id: string;
    title: string;
    /** Substituted body (markdown). Personalization placeholders rendered. */
    body: string;
    /** Steers learning-mode TODO placement; rendered alongside the body. */
    key_moment: string;
    expected_files: string[];
    artifact_section_id: string;
    verification?: {
      mode: 'compile' | 'test-suite';
      command: string;
      cwd?: string;
    };
  };
}

export async function runNextSection({
  projectRoot,
}: {
  projectRoot: string;
}): Promise<NextSectionResult> {
  const gate = await runSetupGate(projectRoot);
  if (!gate.ok) {
    return { ok: false, errors: gate.errors };
  }
  const { state, loaded } = gate;
  const { sections, info } = loaded;

  const total = sections.sections.length;
  const cursor = state.section_cursor;
  if (cursor >= total) {
    return { ok: true, done: true, total, index: cursor };
  }

  const section = sections.sections[cursor];

  // Load section body and substitute personalization.
  const bodyPath = path.join(info.lesson_dir, section.body_md);
  let body: string;
  try {
    body = await fsPromises.readFile(bodyPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      errors: [`section-body-missing: ${bodyPath} (${(err as Error).message})`],
    };
  }
  body = substitutePromptOnly(body, state.personalization);

  const result: NextSectionResult = {
    ok: true,
    done: false,
    total,
    index: cursor,
    section: {
      id: section.id,
      title: section.title,
      body,
      key_moment: section.key_moment,
      expected_files: section.expected_files,
      artifact_section_id: section.artifact_section_id,
    },
  };
  if (section.verification !== undefined) {
    result.section!.verification = section.verification;
  }
  return result;
}
