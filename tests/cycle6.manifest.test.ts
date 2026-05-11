// Cycle 6 — manifest rename + p2/p3 content packs (AC-6.3, AC-4.2)
// T-301..T-305: phases.json must declare p2-retry / p3-poll with the spec-mandated
// target ranges, explainer paths, rungs blocks, and {{ poll_interval_ms }}
// placeholder. The new content packs (rungs/p2-spot-1/, rungs/p3-spot-1/, phases/p2.md,
// phases/p3.md) must exist on disk and be loadable.
import { describe, it, expect } from 'vitest';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadPhases,
  getCurrentSpot,
} from '../mcp/server/src/phaseEngine.js';
import { substitutePromptOnly } from '../mcp/server/src/personalization.js';
import type { State } from '../mcp/server/src/schemas/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PATH_ROOT = path.join(REPO_ROOT, 'paths', '01-orderbook-viewer');
const PHASES_JSON_PATH = path.join(PATH_ROOT, 'phases.json');

interface PhaseManifestEntry {
  id: string;
  title?: string;
  explainer_md?: string;
  spots: Array<{
    id: string;
    target_file?: string;
    target_range?: string;
    prompt?: string;
    rungs?: { hint_md?: string; reference_md?: string; auto_write_md?: string };
    verification?: { mode?: string; command?: string; endpoint?: string };
  }>;
}

function readPhases(): { phases: PhaseManifestEntry[] } {
  const raw = fs.readFileSync(PHASES_JSON_PATH, 'utf8');
  return JSON.parse(raw) as { phases: PhaseManifestEntry[] };
}

describe('AC-6.3: phases.json — p2-retry rename (T-301)', () => {
  it('T-301: phases.json declares p2-retry phase id with target_range 103-114 and explainer phases/p2.md', () => {
    const data = readPhases();
    const phaseIds = data.phases.map((p) => p.id);

    // Rename: p2-polling MUST NOT be present.
    expect(phaseIds).not.toContain('p2-polling');
    // p2-retry MUST be present.
    expect(phaseIds).toContain('p2-retry');

    const p2 = data.phases.find((p) => p.id === 'p2-retry');
    expect(p2).toBeDefined();
    // Explainer must end with phases/p2.md.
    expect(typeof p2!.explainer_md).toBe('string');
    expect(p2!.explainer_md!.endsWith('phases/p2.md')).toBe(true);

    // First spot must carry the spec-mandated target range, target_file, and rungs block.
    expect(Array.isArray(p2!.spots)).toBe(true);
    expect(p2!.spots.length).toBeGreaterThan(0);
    const spot0 = p2!.spots[0];
    expect(spot0.id).toBe('p2-spot-1');
    expect(spot0.target_range).toBe('103-114');
    expect(spot0.target_file).toBe('src/App.tsx');

    expect(spot0.rungs).toBeDefined();
    expect(spot0.rungs!.hint_md).toBe('rungs/p2-spot-1/hint.md');
    expect(spot0.rungs!.reference_md).toBe('rungs/p2-spot-1/reference.md');
    expect(spot0.rungs!.auto_write_md).toBe('rungs/p2-spot-1/auto.md');
  });
});

describe('AC-6.3: phases.json — p3-poll rename + placeholder (T-302)', () => {
  it('T-302: phases.json declares p3-poll phase id with target_range 116-145 and {{ poll_interval_ms }} placeholder', () => {
    const data = readPhases();
    const phaseIds = data.phases.map((p) => p.id);

    // Rename: p3-display MUST NOT be present.
    expect(phaseIds).not.toContain('p3-display');
    // p3-poll MUST be present.
    expect(phaseIds).toContain('p3-poll');

    const p3 = data.phases.find((p) => p.id === 'p3-poll');
    expect(p3).toBeDefined();
    expect(typeof p3!.explainer_md).toBe('string');
    expect(p3!.explainer_md!.endsWith('phases/p3.md')).toBe(true);

    expect(Array.isArray(p3!.spots)).toBe(true);
    expect(p3!.spots.length).toBeGreaterThan(0);
    const spot0 = p3!.spots[0];
    expect(spot0.id).toBe('p3-spot-1');
    expect(spot0.target_range).toBe('116-145');
    expect(spot0.target_file).toBe('src/App.tsx');

    // Literal placeholder must survive into the prompt.
    expect(typeof spot0.prompt).toBe('string');
    expect(spot0.prompt!.indexOf('{{ poll_interval_ms }}')).toBeGreaterThan(-1);

    expect(spot0.rungs).toBeDefined();
    expect(spot0.rungs!.hint_md).toBe('rungs/p3-spot-1/hint.md');
    expect(spot0.rungs!.reference_md).toBe('rungs/p3-spot-1/reference.md');
    expect(spot0.rungs!.auto_write_md).toBe('rungs/p3-spot-1/auto.md');
  });
});

describe('AC-6.3: substitutePromptOnly renders 5000 in p3-spot-1 prompt (T-303)', () => {
  it('T-303: substitutePromptOnly renders 5000 in p3-spot-1 prompt when poll_interval_ms=5000', async () => {
    // Use the production loadPhases against REPO_ROOT — exactly how the engine
    // loads it.
    const phases = await loadPhases(REPO_ROOT, '01-orderbook-viewer');
    const p3 = phases.phases.find((p) => p.id === 'p3-poll');
    expect(p3).toBeDefined();
    const spot = p3!.spots[0];
    expect(spot.id).toBe('p3-spot-1');
    expect(typeof spot.prompt).toBe('string');

    const originalTargetFile = spot.target_file;
    const originalTargetRange = spot.target_range;
    const originalVerification = spot.verification
      ? { ...spot.verification }
      : undefined;

    const rendered = substitutePromptOnly(spot.prompt!, { poll_interval_ms: 5000 });

    expect(rendered.indexOf('5000')).toBeGreaterThan(-1);
    expect(rendered.indexOf('{{ poll_interval_ms }}')).toBe(-1);
    expect(rendered.indexOf('{{poll_interval_ms}}')).toBe(-1);

    // Negative assertion: substitution does not mutate the spot object's
    // target_file / target_range / verification fields.
    expect(spot.target_file).toBe(originalTargetFile);
    expect(spot.target_range).toBe(originalTargetRange);
    if (originalVerification !== undefined) {
      expect(spot.verification).toEqual(originalVerification);
    }
  });
});

describe('AC-6.3: getCurrentSpot resolves p2-retry/p2-spot-1 (T-304)', () => {
  it('T-304: getCurrentSpot resolves p2-retry/p2-spot-1 to a non-done Spot', async () => {
    const phases = await loadPhases(REPO_ROOT, '01-orderbook-viewer');
    const state: State = {
      schema_version: 1,
      selected_path: '01-orderbook-viewer',
      personalization: {},
      cursor: { phase_id: 'p2-retry', spot_id: 'p2-spot-1' },
      ladder: {},
      history: [],
    };

    const result = getCurrentSpot(state, phases);

    expect(result.done).toBe(false);
    if (result.done) {
      throw new Error('expected non-done result');
    }
    expect(result.phase.id).toBe('p2-retry');
    expect(result.spot.id).toBe('p2-spot-1');
    expect(result.spot.target_range).toBe('103-114');
  });
});

describe('AC-6.3: rungs and phases content packs for p2/p3 exist on disk (T-305)', () => {
  it('T-305: rungs and phases content packs for p2/p3 exist on disk and are non-empty', () => {
    const requiredFiles = [
      'rungs/p2-spot-1/hint.md',
      'rungs/p2-spot-1/reference.md',
      'rungs/p2-spot-1/auto.md',
      'rungs/p3-spot-1/hint.md',
      'rungs/p3-spot-1/reference.md',
      'rungs/p3-spot-1/auto.md',
      'phases/p2.md',
      'phases/p3.md',
    ];

    for (const rel of requiredFiles) {
      const full = path.join(PATH_ROOT, rel);
      expect(fs.existsSync(full), `missing: ${rel}`).toBe(true);
      const stat = fs.statSync(full);
      expect(stat.size, `empty: ${rel}`).toBeGreaterThan(0);
      const content = fs.readFileSync(full, 'utf8');
      expect(content.trim().length, `whitespace-only: ${rel}`).toBeGreaterThan(0);
    }

    // The p3 reference snippet must contain the literal placeholder so
    // substitution at requestHint time can fire.
    const p3Reference = fs.readFileSync(
      path.join(PATH_ROOT, 'rungs', 'p3-spot-1', 'reference.md'),
      'utf8',
    );
    expect(p3Reference.indexOf('{{ poll_interval_ms }}')).toBeGreaterThan(-1);
  });
});
