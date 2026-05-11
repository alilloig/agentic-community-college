// F-005: selectStyle MCP tool tests
//
// PR 1 honors 'fill-in-blank' end-to-end and rejects 'prompted-agentic' with
// style-not-yet-supported. Verifies output-style gating, state persistence,
// and validation against the spot's declared styles block.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runSelectStyle } from '../mcp/server/src/tools/selectStyle.js';
import { saveState } from '../mcp/server/src/state.js';
import { STATE_SCHEMA_VERSION } from '../mcp/server/src/state.js';
import type { State } from '../mcp/server/src/schemas/state.js';

let tempRoots: string[];
let tempHomes: string[];
let originalHome: string | undefined;

beforeEach(() => {
  tempRoots = [];
  tempHomes = [];
  originalHome = process.env.HOME;
});

afterEach(() => {
  process.env.HOME = originalHome;
  for (const r of [...tempRoots, ...tempHomes]) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  }
  vi.restoreAllMocks();
});

function makeTempProjectRoot(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'sui-selectStyle-'));
  tempRoots.push(r);
  return r;
}

/** Set a fake HOME with a settings.json that enables the learning-output-style plugin. */
function withOutputStyleEnabled(): void {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sui-home-'));
  tempHomes.push(tempHome);
  process.env.HOME = tempHome;
  fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(tempHome, '.claude', 'settings.json'),
    JSON.stringify({
      enabledPlugins: { 'learning-output-style@claude-plugins-official': true },
    }),
    'utf8',
  );
}

/** Set a HOME without the output-style plugin enabled. */
function withOutputStyleDisabled(): void {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sui-home-'));
  tempHomes.push(tempHome);
  process.env.HOME = tempHome;
  fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(tempHome, '.claude', 'settings.json'),
    JSON.stringify({ enabledPlugins: {} }),
    'utf8',
  );
}

/** Seed paths/<slug>/{path.json, phases.json} with optional spot styles. */
function seedPath(
  projectRoot: string,
  opts: { spotStyles?: Record<string, unknown>; declareWorkspace?: boolean } = {},
): void {
  const slug = '01-orderbook-viewer';
  const slugDir = path.join(projectRoot, 'paths', slug);
  fs.mkdirSync(slugDir, { recursive: true });

  const pathJson: Record<string, unknown> = {
    slug,
    title: 'Orderbook Viewer',
    summary: 'Test',
    personalization_options: [],
    build_command: 'pnpm build',
  };
  fs.writeFileSync(path.join(slugDir, 'path.json'), JSON.stringify(pathJson), 'utf8');

  const phasesJson = {
    phases: [
      {
        id: 'p1',
        title: 'Phase 1',
        spots: [
          {
            id: 'p1-spot-1',
            title: 'Spot 1',
            target_file: 'src/App.tsx',
            target_range: '1-10',
            prompt: 'Do the thing',
            verification: { mode: 'compile', command: 'pnpm build' },
            ...(opts.spotStyles ? { styles: opts.spotStyles } : {}),
          },
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(slugDir, 'phases.json'), JSON.stringify(phasesJson), 'utf8');
}

async function seedState(projectRoot: string): Promise<void> {
  const state: State = {
    schema_version: STATE_SCHEMA_VERSION,
    selected_path: '01-orderbook-viewer',
    personalization: {},
    cursor: { phase_id: 'p1', spot_id: 'p1-spot-1' },
    ladder: {},
    history: [],
  };
  await saveState(projectRoot, state);
}

describe('selectStyle — output-style gate', () => {
  it('returns output-style-disabled before any state load', async () => {
    withOutputStyleDisabled();
    const projectRoot = makeTempProjectRoot();
    const result = await runSelectStyle({
      projectRoot,
      spotId: 'p1-spot-1',
      style: 'fill-in-blank',
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('output-style-disabled');
  });
});

describe('selectStyle — input validation', () => {
  it('rejects missing spotId', async () => {
    withOutputStyleEnabled();
    const projectRoot = makeTempProjectRoot();
    seedPath(projectRoot);
    await seedState(projectRoot);

    const result = await runSelectStyle({
      projectRoot,
      spotId: undefined as unknown,
      style: 'fill-in-blank',
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/spotId/);
  });

  it("rejects style values that aren't fill-in-blank or prompted-agentic", async () => {
    withOutputStyleEnabled();
    const projectRoot = makeTempProjectRoot();
    seedPath(projectRoot);
    await seedState(projectRoot);

    const result = await runSelectStyle({
      projectRoot,
      spotId: 'p1-spot-1',
      style: 'something-else' as unknown,
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/style must be/);
  });
});

describe('selectStyle — no path selected', () => {
  it('returns an error when no state.selected_path exists', async () => {
    withOutputStyleEnabled();
    const projectRoot = makeTempProjectRoot();
    seedPath(projectRoot);
    // No state seeded.

    const result = await runSelectStyle({
      projectRoot,
      spotId: 'p1-spot-1',
      style: 'fill-in-blank',
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/No path selected/);
  });
});

describe('selectStyle — spot validation', () => {
  it('rejects unknown spotId not declared in phases.json', async () => {
    withOutputStyleEnabled();
    const projectRoot = makeTempProjectRoot();
    seedPath(projectRoot);
    await seedState(projectRoot);

    const result = await runSelectStyle({
      projectRoot,
      spotId: 'never-declared',
      style: 'fill-in-blank',
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/Unknown spotId/);
  });

  it('rejects when the spot does not declare the requested style', async () => {
    withOutputStyleEnabled();
    const projectRoot = makeTempProjectRoot();
    seedPath(projectRoot, {
      spotStyles: {
        'fill-in-blank': { starter_file: 'starters/p1-spot-1/App.tsx', blank_range: '1-10' },
      },
    });
    await seedState(projectRoot);

    const result = await runSelectStyle({
      projectRoot,
      spotId: 'p1-spot-1',
      style: 'prompted-agentic',
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/does not declare style/);
  });
});

describe('selectStyle — fill-in-blank happy path', () => {
  it('persists the choice into state.selected_style_per_spot', async () => {
    withOutputStyleEnabled();
    const projectRoot = makeTempProjectRoot();
    seedPath(projectRoot, {
      spotStyles: {
        'fill-in-blank': { starter_file: 'starters/p1-spot-1/App.tsx', blank_range: '1-10' },
        'prompted-agentic': {
          prompts_dir: 'prompts/p1-spot-1/',
          expected_files: ['src/App.tsx'],
        },
      },
    });
    await seedState(projectRoot);

    const result = await runSelectStyle({
      projectRoot,
      spotId: 'p1-spot-1',
      style: 'fill-in-blank',
    });
    expect(result.ok).toBe(true);
    expect(result.selected_style).toBe('fill-in-blank');

    // State persisted.
    const persisted = JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.sui-deepbook-course', 'state.json'), 'utf8'),
    );
    expect(persisted.selected_style_per_spot?.['p1-spot-1']).toBe('fill-in-blank');
  });
});

describe('selectStyle — prompted-agentic gating (PR 2)', () => {
  it('rejects with prompts-not-authored when prompts_dir is declared but empty', async () => {
    withOutputStyleEnabled();
    const projectRoot = makeTempProjectRoot();
    seedPath(projectRoot, {
      spotStyles: {
        'fill-in-blank': { starter_file: 'starters/p1-spot-1/App.tsx', blank_range: '1-10' },
        'prompted-agentic': {
          prompts_dir: 'prompts/p1-spot-1/',
          expected_files: ['src/App.tsx'],
        },
      },
    });
    await seedState(projectRoot);
    // Note: prompts/p1-spot-1/ is NOT created → empty.

    const result = await runSelectStyle({
      projectRoot,
      spotId: 'p1-spot-1',
      style: 'prompted-agentic',
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/prompts-not-authored/);

    // No state persistence on rejection.
    const persisted = JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.sui-deepbook-course', 'state.json'), 'utf8'),
    );
    expect(persisted.selected_style_per_spot?.['p1-spot-1']).toBeUndefined();
  });

  it('persists prompted-agentic when at least one prompt file exists', async () => {
    withOutputStyleEnabled();
    const projectRoot = makeTempProjectRoot();
    seedPath(projectRoot, {
      spotStyles: {
        'fill-in-blank': { starter_file: 'starters/p1-spot-1/App.tsx', blank_range: '1-10' },
        'prompted-agentic': {
          prompts_dir: 'prompts/p1-spot-1/',
          expected_files: ['src/App.tsx'],
        },
      },
    });
    // Author one prompt.
    const promptDir = path.join(projectRoot, 'paths', '01-orderbook-viewer', 'prompts', 'p1-spot-1');
    fs.mkdirSync(promptDir, { recursive: true });
    fs.writeFileSync(path.join(promptDir, '01-orient.md'), '# orient\n', 'utf8');
    await seedState(projectRoot);

    const result = await runSelectStyle({
      projectRoot,
      spotId: 'p1-spot-1',
      style: 'prompted-agentic',
    });
    expect(result.ok).toBe(true);
    expect(result.selected_style).toBe('prompted-agentic');

    const persisted = JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.sui-deepbook-course', 'state.json'), 'utf8'),
    );
    expect(persisted.selected_style_per_spot?.['p1-spot-1']).toBe('prompted-agentic');
  });
});

describe('selectStyle — legacy single-style path', () => {
  it('returns ok without persisting when spot has no styles block (legacy mode)', async () => {
    withOutputStyleEnabled();
    const projectRoot = makeTempProjectRoot();
    seedPath(projectRoot); // no spot styles
    await seedState(projectRoot);

    const result = await runSelectStyle({
      projectRoot,
      spotId: 'p1-spot-1',
      style: 'fill-in-blank',
    });
    expect(result.ok).toBe(true);
    expect(result.selected_style).toBe('fill-in-blank');
  });
});
