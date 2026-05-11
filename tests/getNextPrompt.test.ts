// PR 2 — getNextPrompt MCP tool tests.
//
// Verifies the prompt cursor walks the prompts_dir in lexical order, applies
// {{ ... }} substitutions, persists state, and surfaces the right errors when
// preconditions fail (output-style off, wrong selected style, missing
// directory, etc.).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runGetNextPrompt } from '../mcp/server/src/tools/getNextPrompt.js';
import { saveState, STATE_SCHEMA_VERSION } from '../mcp/server/src/state.js';
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
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'sui-getnext-'));
  tempRoots.push(r);
  return r;
}

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

function seedPath(
  projectRoot: string,
  promptFiles: Record<string, string>,
): { promptDir: string } {
  const slug = '01-orderbook-viewer';
  const slugDir = path.join(projectRoot, 'paths', slug);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(
    path.join(slugDir, 'path.json'),
    JSON.stringify({
      slug,
      title: 'Orderbook Viewer',
      summary: 'Test',
      personalization_options: [],
      build_command: 'pnpm build',
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(slugDir, 'phases.json'),
    JSON.stringify({
      phases: [
        {
          id: 'p1',
          spots: [
            {
              id: 'p1-spot-1',
              target_file: 'src/App.tsx',
              target_range: '1-10',
              prompt: 'do it',
              verification: { mode: 'compile', command: 'pnpm build' },
              styles: {
                'fill-in-blank': {
                  starter_file: 'starters/p1-spot-1/App.tsx',
                  blank_range: '1-10',
                },
                'prompted-agentic': {
                  prompts_dir: 'prompts/p1-spot-1/',
                  expected_files: ['src/App.tsx'],
                },
              },
            },
          ],
        },
      ],
    }),
    'utf8',
  );

  const promptDir = path.join(slugDir, 'prompts', 'p1-spot-1');
  fs.mkdirSync(promptDir, { recursive: true });
  for (const [name, content] of Object.entries(promptFiles)) {
    fs.writeFileSync(path.join(promptDir, name), content, 'utf8');
  }
  return { promptDir };
}

async function seedState(
  projectRoot: string,
  opts: {
    selectedStyle?: 'fill-in-blank' | 'prompted-agentic';
    promptCursor?: number;
    workspacePath?: string;
  } = {},
): Promise<void> {
  const state: State = {
    schema_version: STATE_SCHEMA_VERSION,
    selected_path: '01-orderbook-viewer',
    personalization: { pool_subset: 'DEEP_SUI' },
    cursor: { phase_id: 'p1', spot_id: 'p1-spot-1' },
    ladder: {},
    history: [],
  };
  if (opts.selectedStyle) {
    state.selected_style_per_spot = { 'p1-spot-1': opts.selectedStyle };
  }
  if (opts.promptCursor !== undefined) {
    state.prompt_cursor_per_spot = { 'p1-spot-1': opts.promptCursor };
  }
  if (opts.workspacePath) {
    state.workspace_path = opts.workspacePath;
  }
  await saveState(projectRoot, state);
}

describe('getNextPrompt — gates and validation', () => {
  it('returns output-style-disabled before any state load', async () => {
    withOutputStyleDisabled();
    const projectRoot = makeTempProjectRoot();
    const result = await runGetNextPrompt({ projectRoot });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0].kind).toBe('output-style-disabled');
  });

  it('returns no-state when no state.json exists', async () => {
    withOutputStyleEnabled();
    const projectRoot = makeTempProjectRoot();
    const result = await runGetNextPrompt({ projectRoot });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0].kind).toBe('no-state');
  });

  it('returns wrong-style when the spot is in fill-in-blank', async () => {
    withOutputStyleEnabled();
    const projectRoot = makeTempProjectRoot();
    seedPath(projectRoot, { '01.md': '# one\n' });
    await seedState(projectRoot, { selectedStyle: 'fill-in-blank' });

    const result = await runGetNextPrompt({ projectRoot });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0].kind).toBe('wrong-style');
  });

  it('returns prompts-empty when prompts_dir has no .md files', async () => {
    withOutputStyleEnabled();
    const projectRoot = makeTempProjectRoot();
    seedPath(projectRoot, {}); // empty prompt dir
    await seedState(projectRoot, { selectedStyle: 'prompted-agentic' });

    const result = await runGetNextPrompt({ projectRoot });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0].kind).toBe('prompts-empty');
  });
});

describe('getNextPrompt — cursor walk', () => {
  it('returns prompts in lexical order, advancing the cursor on each call', async () => {
    withOutputStyleEnabled();
    const projectRoot = makeTempProjectRoot();
    seedPath(projectRoot, {
      '01-first.md': '# First\n',
      '02-second.md': '# Second\n',
      '03-third.md': '# Third\n',
    });
    await seedState(projectRoot, { selectedStyle: 'prompted-agentic' });

    const r1 = await runGetNextPrompt({ projectRoot });
    expect(r1.ok).toBe(true);
    expect(r1.payload).toContain('First');
    expect(r1.promptFile).toBe('01-first.md');
    expect(r1.index).toBe(0);
    expect(r1.total).toBe(3);
    expect(r1.done).toBeUndefined();

    const r2 = await runGetNextPrompt({ projectRoot });
    expect(r2.payload).toContain('Second');
    expect(r2.promptFile).toBe('02-second.md');
    expect(r2.index).toBe(1);

    const r3 = await runGetNextPrompt({ projectRoot });
    expect(r3.payload).toContain('Third');
    expect(r3.promptFile).toBe('03-third.md');
    expect(r3.index).toBe(2);
    expect(r3.done).toBe(true);

    // Past the end: done=true with no payload.
    const r4 = await runGetNextPrompt({ projectRoot });
    expect(r4.ok).toBe(true);
    expect(r4.done).toBe(true);
    expect(r4.payload).toBeUndefined();
  });

  it('persists the cursor across calls', async () => {
    withOutputStyleEnabled();
    const projectRoot = makeTempProjectRoot();
    seedPath(projectRoot, {
      '01-a.md': '# a\n',
      '02-b.md': '# b\n',
    });
    await seedState(projectRoot, { selectedStyle: 'prompted-agentic' });

    await runGetNextPrompt({ projectRoot });
    const persisted = JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.sui-deepbook-course', 'state.json'), 'utf8'),
    );
    expect(persisted.prompt_cursor_per_spot?.['p1-spot-1']).toBe(1);
  });

  it('skips dotfiles and non-markdown files', async () => {
    withOutputStyleEnabled();
    const projectRoot = makeTempProjectRoot();
    seedPath(projectRoot, {
      '.hidden.md': '# hidden\n',
      '01-real.md': '# real\n',
      'README.txt': 'plaintext\n',
    });
    await seedState(projectRoot, { selectedStyle: 'prompted-agentic' });

    const result = await runGetNextPrompt({ projectRoot });
    expect(result.ok).toBe(true);
    expect(result.total).toBe(1);
    expect(result.promptFile).toBe('01-real.md');
  });
});

describe('getNextPrompt — substitution', () => {
  it("substitutes {{ pool_subset }} from the learner's personalization", async () => {
    withOutputStyleEnabled();
    const projectRoot = makeTempProjectRoot();
    seedPath(projectRoot, {
      '01.md': 'Configured for pool: {{ pool_subset }}.\n',
    });
    await seedState(projectRoot, { selectedStyle: 'prompted-agentic' });

    const result = await runGetNextPrompt({ projectRoot });
    expect(result.payload).toContain('Configured for pool: DEEP_SUI');
  });

  it('substitutes {{ workspace_path }} when state carries one', async () => {
    withOutputStyleEnabled();
    const projectRoot = makeTempProjectRoot();
    const wsPath = '/tmp/fake-workspace';
    seedPath(projectRoot, { '01.md': 'Workspace at {{ workspace_path }}\n' });
    await seedState(projectRoot, {
      selectedStyle: 'prompted-agentic',
      workspacePath: wsPath,
    });

    const result = await runGetNextPrompt({ projectRoot });
    expect(result.payload).toContain(`Workspace at ${wsPath}`);
  });

  it('substitutes {{ target_file_absolute }} resolved against workspace_path', async () => {
    withOutputStyleEnabled();
    const projectRoot = makeTempProjectRoot();
    const wsPath = '/tmp/fake-workspace';
    seedPath(projectRoot, { '01.md': 'Edit {{ target_file_absolute }}\n' });
    await seedState(projectRoot, {
      selectedStyle: 'prompted-agentic',
      workspacePath: wsPath,
    });

    const result = await runGetNextPrompt({ projectRoot });
    expect(result.payload).toContain(`Edit ${wsPath}/src/App.tsx`);
  });
});

describe('getNextPrompt — resumed cursor', () => {
  it('honors a pre-existing prompt_cursor_per_spot value', async () => {
    withOutputStyleEnabled();
    const projectRoot = makeTempProjectRoot();
    seedPath(projectRoot, {
      '01-a.md': '# a\n',
      '02-b.md': '# b\n',
      '03-c.md': '# c\n',
    });
    await seedState(projectRoot, {
      selectedStyle: 'prompted-agentic',
      promptCursor: 2,
    });

    const result = await runGetNextPrompt({ projectRoot });
    expect(result.payload).toContain('# c');
    expect(result.index).toBe(2);
    expect(result.done).toBe(true);
  });
});
