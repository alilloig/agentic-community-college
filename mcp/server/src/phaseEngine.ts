import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { validatePhases } from './schemas/phases.js';
import type { PhasesData, PhaseData, SpotData } from './schemas/phases.js';
import type { State } from './schemas/state.js';
import { resolvePathContentRoot } from './pathsRoot.js';

export type { PhasesData, PhaseData, SpotData };

/**
 * Error thrown when phases.json cannot be loaded at runtime.
 * The registry validates at scan time but a path can disappear between scan and use.
 */
export class LoadPhasesError extends Error {
  public readonly slug: string;
  constructor(slug: string, reason: string) {
    super(`Failed to load phases for '${slug}': ${reason}`);
    this.name = 'LoadPhasesError';
    this.slug = slug;
  }
}

/**
 * Load and validate paths/<slug>/phases.json from projectRoot.
 */
export async function loadPhases(projectRoot: string, slug: string): Promise<PhasesData> {
  const phasesPath = path.join(resolvePathContentRoot(projectRoot, slug), 'phases.json');

  let raw: string;
  try {
    raw = await fsPromises.readFile(phasesPath, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new LoadPhasesError(slug, e.message ?? String(err));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const e = err as Error;
    throw new LoadPhasesError(slug, `JSON parse failure: ${e.message}`);
  }

  const result = validatePhases(parsed);
  if (!result.ok) {
    throw new LoadPhasesError(slug, result.error);
  }

  return result.value;
}

export type GetCurrentSpotResult =
  | { done: true }
  | { done: false; phase: PhaseData; spot: SpotData };

/**
 * Resolve the current phase/spot from state.cursor against the loaded phases.
 * Returns { done: true } when the cursor is past the end.
 */
export function getCurrentSpot(state: State, phases: PhasesData): GetCurrentSpotResult {
  const { phase_id, spot_id } = state.cursor;

  const phase = phases.phases.find((p) => p.id === phase_id);
  if (!phase) {
    return { done: true };
  }

  const spot = phase.spots.find((s) => s.id === spot_id);
  if (!spot) {
    return { done: true };
  }

  return { done: false, phase, spot };
}

/**
 * Advance the cursor to the next spot (or mark done when past the last spot).
 * Returns a new State (original is not mutated).
 * Throws if already done.
 */
export function advanceCursor(state: State, phases: PhasesData): State {
  const current = getCurrentSpot(state, phases);
  if (current.done) {
    throw new Error('Cannot advance cursor: already past the end (done)');
  }

  const { phase, spot } = current;
  const phaseIndex = phases.phases.indexOf(phase);
  const spotIndex = phase.spots.indexOf(spot);

  let newPhaseId: string;
  let newSpotId: string;

  if (spotIndex < phase.spots.length - 1) {
    // Next spot within same phase
    newPhaseId = phase.id;
    newSpotId = phase.spots[spotIndex + 1].id;
  } else if (phaseIndex < phases.phases.length - 1) {
    // Cross phase boundary — first spot of next phase
    const nextPhase = phases.phases[phaseIndex + 1];
    newPhaseId = nextPhase.id;
    newSpotId = nextPhase.spots[0].id;
  } else {
    // Past the last spot of the last phase — use a sentinel that getCurrentSpot won't find
    newPhaseId = '__done__';
    newSpotId = '__done__';
  }

  return {
    ...state,
    cursor: { phase_id: newPhaseId, spot_id: newSpotId },
  };
}
