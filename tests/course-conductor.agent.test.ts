import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression test for the May 2026 conductor-malfunction bug: the agent's
 * frontmatter shipped with `tools: []`, which strips the subagent of every
 * tool (an empty array is NOT "inherit from parent"). The course-engine
 * handoff then failed silently with `tool_uses: 0`.
 *
 * v0.3: the conductor drives the chapter loop through exactly two MCP tools,
 * `nextChapter` and `verifyChapter`, plus the file/shell tools it needs to
 * implement chapters and write artifacts, plus AskUserQuestion to pause.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_PATH = path.resolve(__dirname, '..', 'agents', 'course-conductor.md');

const MCP_PREFIX = 'mcp__plugin_agentic-community-college_agentic-community-college__';

const EXPECTED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'AskUserQuestion',
  `${MCP_PREFIX}nextChapter`,
  `${MCP_PREFIX}verifyChapter`,
];

const RETIRED_TOOLS = [
  'setOutputMode',
  'advanceArtifact',
  'nextSection',
  'verifySection',
  'selectStyle',
  'requestHint',
  'nextSpot',
  'verifySpot',
  'getNextPrompt',
];

const SETUP_TOOLS = ['selectLesson', 'setOutputStyle', 'setPersonalization', 'start', 'runPreflightProbe'];

interface Frontmatter {
  raw: string;
  body: string;
}

function readFrontmatter(filePath: string): Frontmatter {
  const text = fs.readFileSync(filePath, 'utf8');
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`No YAML frontmatter found at ${filePath}`);
  return { raw: m[1], body: m[2] };
}

function extractTools(yaml: string): string[] {
  const oneLine = /^tools:\s*\[(.*?)\]\s*$/m.exec(yaml);
  if (oneLine) {
    return oneLine[1]
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter((s) => s.length > 0);
  }
  const block = /^tools:\s*\n((?:\s*-\s+.*\n?)+)/m.exec(yaml);
  if (block) {
    return block[1]
      .split('\n')
      .map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1])
      .filter((v): v is string => !!v);
  }
  return [];
}

describe('agents/course-conductor.md frontmatter', () => {
  const fm = readFrontmatter(AGENT_PATH);
  const tools = extractTools(fm.raw);

  it('declares name: course-conductor', () => {
    expect(fm.raw).toMatch(/^name:\s*course-conductor\s*$/m);
  });

  it('lists exactly the v0.3 tool set (regression: tools: [] strips all bindings)', () => {
    expect(new Set(tools)).toEqual(new Set(EXPECTED_TOOLS));
    expect(tools).toHaveLength(EXPECTED_TOOLS.length);
  });

  it('does NOT bind retired tool names (v0.2 section runtime + older phase/spot runtime)', () => {
    for (const fragment of RETIRED_TOOLS) {
      for (const tool of tools) {
        expect(tool, `still references retired tool '${fragment}': ${tool}`).not.toMatch(
          new RegExp(`__${fragment}$`),
        );
      }
    }
  });

  it('does NOT include setup-phase tools (those belong to the course-engine skill)', () => {
    for (const fragment of SETUP_TOOLS) {
      for (const tool of tools) {
        expect(tool, `conductor should not hold the setup-phase tool '${fragment}': ${tool}`).not.toMatch(
          new RegExp(`__${fragment}$`),
        );
      }
    }
  });
});

describe('agents/course-conductor.md body', () => {
  const fm = readFrontmatter(AGENT_PATH);

  it('describes the two MCP tools the agent uses', () => {
    expect(fm.body).toMatch(/\bnextChapter\b/);
    expect(fm.body).toMatch(/\bverifyChapter\b/);
  });

  it('documents the nextChapter envelope fields the loop depends on', () => {
    for (const field of [
      'artifact_path',
      'artifact_nav',
      'artifact_conventions_path',
      'summary_artifact_path',
      'artifacts',
      'final_verification',
      'docs_dir',
      'workspace_path',
      'expected_files',
      'key_idea',
    ]) {
      expect(fm.body, `body should mention envelope field ${field}`).toContain(field);
    }
  });

  it('documents the verifyChapter envelope fields', () => {
    for (const field of ['artifact_recorded', 'chapter_cursor', 'advanced', 'warnings']) {
      expect(fm.body, `body should mention verifyChapter field ${field}`).toContain(field);
    }
  });

  it('caps implementation attempts at 5 before asking the learner', () => {
    expect(fm.body).toMatch(/5 (failed )?attempts/);
  });

  it('keeps the one-chapter-per-turn rule and the never-auto-retry rule', () => {
    expect(fm.body).toMatch(/one chapter per learner turn/i);
    expect(fm.body).toMatch(/never auto-retry/i);
  });

  it('offers publish-html only when publish_available is true and never invokes it', () => {
    expect(fm.body).toContain('publish_available');
    expect(fm.body).toContain('toolkit@contract-hero');
    expect(fm.body).toContain('publish-html');
    expect(fm.body).toMatch(/never invoke `publish-html`/i);
  });

  it('says plainly when the e2e skipped tests for missing credentials', () => {
    expect(fm.body).toMatch(/skipped for missing credentials/i);
  });

  it('reframes retired tool names as a "do not call" warning, not as an instruction', () => {
    for (const tool of RETIRED_TOOLS) {
      const re = new RegExp(`[^\\n]*\\b${tool}\\b[^\\n]*`, 'g');
      const mentions = fm.body.match(re) ?? [];
      expect(mentions.length, `retired '${tool}' should be listed in the warning`).toBeGreaterThan(0);
      for (const line of mentions) {
        expect(
          /do not|don't|retired|gone|stale|removed|deprecated/i.test(line),
          `mention of retired '${tool}' must sit in a 'do not' warning context: ${line}`,
        ).toBe(true);
      }
    }
  });

  it('does not reference the v0.2 output-mode state field', () => {
    expect(fm.body).not.toContain('selected_output_style');
  });
});
