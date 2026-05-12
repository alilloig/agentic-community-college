import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression test for the May 2026 conductor-malfunction bug
 * (acc-conductor-malfunction.html in acc-deepbook-test). The agent's
 * frontmatter shipped with `tools: []`, which strips the subagent of every
 * tool — empty array is NOT "inherit from parent". The subagent could not
 * invoke any MCP tool from its prompt, and the course-engine handoff failed
 * silently with `tool_uses: 0`.
 *
 * This test reads the agent file as text, parses just enough of the YAML
 * frontmatter to introspect `tools`, and asserts the load-bearing MCP tools
 * are listed under the canonical short form `mcp__<server>__<tool>`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_PATH = path.resolve(
  __dirname,
  '..',
  'agents',
  'course-conductor.md',
);

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
  // `tools:` accepts two YAML shapes: a flow-style list on one line, or a
  // block-style list with each entry on its own `- ` line. Both must produce
  // a non-empty array of strings.
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

  it('has a non-empty tools list (regression: tools: [] strips all bindings)', () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  it('lists the three load-bearing MCP tools under the canonical short form', () => {
    const required = [
      'mcp__agentic-community-college__advanceArtifact',
      'mcp__agentic-community-college__nextSection',
      'mcp__agentic-community-college__verifySection',
    ];
    for (const tool of required) {
      expect(tools, `missing required MCP tool: ${tool}`).toContain(tool);
    }
  });

  it('does NOT reference retired tool names from the old phase/spot runtime', () => {
    const retired = [
      'mcp__agentic-community-college__selectStyle',
      'mcp__agentic-community-college__getNextPrompt',
      'mcp__agentic-community-college__requestHint',
      'mcp__agentic-community-college__nextSpot',
      'mcp__agentic-community-college__verifySpot',
    ];
    for (const tool of retired) {
      expect(tools, `still references retired tool: ${tool}`).not.toContain(tool);
    }
  });

  it('does NOT include setup-phase tools (those belong to the course-engine skill)', () => {
    expect(tools).not.toContain('mcp__agentic-community-college__selectLesson');
    expect(tools).not.toContain('mcp__agentic-community-college__setOutputMode');
    expect(tools).not.toContain('mcp__agentic-community-college__setPersonalization');
  });
});

describe('agents/course-conductor.md body', () => {
  const fm = readFrontmatter(AGENT_PATH);

  it('describes the three MCP tools the agent uses', () => {
    expect(fm.body).toMatch(/advanceArtifact/);
    expect(fm.body).toMatch(/nextSection/);
    expect(fm.body).toMatch(/verifySection/);
  });

  it('reframes retired tool names as a "do not call" warning, not as an instruction', () => {
    // The body intentionally lists `selectStyle`, `requestHint`, etc. under a
    // "Things you must not do" warning so the model doesn't try them from
    // stale training memory. The test enforces that ANY mention of those
    // tools sits in a "do not / retired / gone" sentence.
    const retired = ['selectStyle', 'requestHint', 'nextSpot', 'verifySpot', 'getNextPrompt'];
    for (const tool of retired) {
      const re = new RegExp(`[^\\n]*\\b${tool}\\b[^\\n]*`, 'g');
      for (const line of fm.body.match(re) ?? []) {
        expect(
          /do not|don't|retired|gone|stale|removed|deprecated/i.test(line),
          `mention of retired '${tool}' must sit in a 'do not' warning context: ${line}`,
        ).toBe(true);
      }
    }
  });
});
