import { saveState } from '../state.js';
import { runVerification, type VerifySpawnFn } from '../verify.js';
import { runSetupGate } from './setupGate.js';

export interface VerifySectionResult {
  ok: boolean;
  errors?: string[];
  /** True when the verification subprocess exited 0. */
  pass?: boolean;
  /** Captured stdout+stderr (truncated by the spawn). */
  output?: string;
  /** True when verifySection advanced the cursor (on pass). */
  advanced?: boolean;
  /** True when this verifySection ran the lesson's final_verification. */
  final?: boolean;
  /** True when the cursor reached the end after this run. */
  done?: boolean;
  /** New section_cursor value (post-run). */
  section_cursor?: number;
}

export async function runVerifySection({
  projectRoot,
  spawn,
}: {
  projectRoot: string;
  /** Test seam; production leaves it undefined and we fall back to node:child_process. */
  spawn?: VerifySpawnFn;
}): Promise<VerifySectionResult> {
  const gate = await runSetupGate(projectRoot);
  if (!gate.ok) {
    return { ok: false, errors: gate.errors };
  }
  const { state, loaded } = gate;
  const { sections, lesson } = loaded;

  const total = sections.sections.length;
  const cursor = state.section_cursor;
  // Defensive: the conductor is meant to stop calling verifySection after
  // nextSection reports `done: true`, but a re-entrant call (or a stale
  // state where `section_cursor` has somehow drifted past `total`) must not
  // re-run final_verification or advance the cursor further — that would
  // produce a permanently corrupted state.
  if (cursor >= total) {
    return {
      ok: true,
      done: true,
      final: true,
      pass: false,
      section_cursor: cursor,
      output: 'Lesson already complete; section_cursor is past the last section.',
    };
  }
  const isFinal = cursor >= total - 1;

  // Choose verification: the current section's, or final_verification if
  // we're at the last section.
  const section = sections.sections[Math.min(cursor, total - 1)];
  const adapter = isFinal
    ? sections.final_verification
    : section.verification ?? sections.final_verification;

  // Resolve verification cwd against the workspace if one exists.
  const verifyCwd = state.workspace_path ?? projectRoot;
  const fullAdapter = { ...adapter };
  if (lesson.workspace?.verification_cwd && fullAdapter.cwd === undefined) {
    fullAdapter.cwd = lesson.workspace.verification_cwd;
  }

  const verifyOpts = spawn !== undefined ? { spawn } : undefined;
  const v = await runVerification(fullAdapter, verifyCwd, verifyOpts);

  // Advance cursor on pass.
  const newCursor = v.pass ? cursor + 1 : cursor;
  const advanced = v.pass;

  const updated = {
    ...state,
    section_cursor: newCursor,
    test_status: {
      pass: v.pass,
      output: v.output,
      ts: new Date().toISOString(),
    },
  };
  try {
    await saveState(projectRoot, updated);
  } catch (err) {
    return { ok: false, errors: [`state-save-failed: ${(err as Error).message}`] };
  }

  return {
    ok: true,
    pass: v.pass,
    output: v.output,
    advanced,
    final: isFinal,
    done: newCursor >= total,
    section_cursor: newCursor,
  };
}
