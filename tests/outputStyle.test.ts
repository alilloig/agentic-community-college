import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getOutputStyleStatus,
  isClaudePluginEnabled,
  writeOutputStyle,
  RECOMMENDED_OUTPUT_STYLE,
} from '../mcp/server/src/outputStyle.js';
import { runSetOutputStyle } from '../mcp/server/src/tools/setOutputStyle.js';

let tempHome: string;

function settingsFile(): string {
  return path.join(tempHome, '.claude', 'settings.json');
}

function writeSettings(content: string): void {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), content, 'utf8');
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-home-'));
});

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('getOutputStyleStatus', () => {
  it('reports ok when the active style is Concise (case-insensitive)', () => {
    writeSettings(JSON.stringify({ outputStyle: 'Concise' }));
    const s = getOutputStyleStatus(tempHome);
    expect(s).toEqual({ active: 'Concise', recommended: 'Concise', ok: true });

    writeSettings(JSON.stringify({ outputStyle: 'concise' }));
    expect(getOutputStyleStatus(tempHome).ok).toBe(true);
  });

  it('reports ok=false with the active name for any other style', () => {
    writeSettings(JSON.stringify({ outputStyle: 'Explanatory' }));
    const s = getOutputStyleStatus(tempHome);
    expect(s.ok).toBe(false);
    expect(s.active).toBe('Explanatory');
    expect(s.recommended).toBe(RECOMMENDED_OUTPUT_STYLE);
  });

  it('reports active=null when settings.json has no outputStyle', () => {
    writeSettings(JSON.stringify({ enabledPlugins: {} }));
    const s = getOutputStyleStatus(tempHome);
    expect(s.active).toBeNull();
    expect(s.ok).toBe(false);
    expect(s.warning).toBeUndefined();
  });

  it('carries a settings-file-missing warning when the file is absent', () => {
    const s = getOutputStyleStatus(tempHome);
    expect(s.active).toBeNull();
    expect(s.ok).toBe(false);
    expect(s.warning?.kind).toBe('settings-file-missing');
  });

  it('carries a settings-parse-error warning for malformed JSON', () => {
    writeSettings('{ not json');
    const s = getOutputStyleStatus(tempHome);
    expect(s.warning?.kind).toBe('settings-parse-error');
    expect(s.ok).toBe(false);
  });

  it('isClaudePluginEnabled reads enabledPlugins strictly', () => {
    expect(isClaudePluginEnabled('toolkit@contract-hero', tempHome)).toBe(false);
    writeSettings(JSON.stringify({ enabledPlugins: { 'toolkit@contract-hero': true, 'other@x': 'yes' } }));
    expect(isClaudePluginEnabled('toolkit@contract-hero', tempHome)).toBe(true);
    expect(isClaudePluginEnabled('other@x', tempHome)).toBe(false);
    writeSettings(JSON.stringify({ enabledPlugins: [] }));
    expect(isClaudePluginEnabled('toolkit@contract-hero', tempHome)).toBe(false);
  });
});

describe('writeOutputStyle', () => {
  it('creates settings.json when absent', async () => {
    const r = await writeOutputStyle('Concise', tempHome);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.previous).toBeNull();
      expect(r.path).toBe(settingsFile());
    }
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    expect(parsed.outputStyle).toBe('Concise');
  });

  it('preserves every other key and returns the previous value', async () => {
    writeSettings(JSON.stringify({ outputStyle: 'Explanatory', enabledPlugins: { 'x@y': true }, model: 'opus' }));
    const r = await writeOutputStyle('Concise', tempHome);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.previous).toBe('Explanatory');
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    expect(parsed).toEqual({ outputStyle: 'Concise', enabledPlugins: { 'x@y': true }, model: 'opus' });
  });

  it('refuses to overwrite a settings file it cannot parse', async () => {
    writeSettings('{ broken');
    const r = await writeOutputStyle('Concise', tempHome);
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe('{ broken');
  });

  it('preserves the existing file mode', async () => {
    writeSettings(JSON.stringify({ outputStyle: 'Default' }));
    fs.chmodSync(settingsFile(), 0o644);
    await writeOutputStyle('Concise', tempHome);
    expect(fs.statSync(settingsFile()).mode & 0o777).toBe(0o644);
  });
});

describe('setOutputStyle tool', () => {
  it('only accepts Concise', async () => {
    const r = await runSetOutputStyle({ style: 'Explanatory', homeDir: tempHome });
    expect(r.ok).toBe(false);
    expect(r.errors?.[0]).toMatch(/Concise/);
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it('writes Concise and reports previous + path + note', async () => {
    writeSettings(JSON.stringify({ outputStyle: 'Default' }));
    const r = await runSetOutputStyle({ style: 'Concise', homeDir: tempHome });
    expect(r.ok).toBe(true);
    expect(r.previous).toBe('Default');
    expect(r.path).toBe(settingsFile());
    expect(r.note).toMatch(/\/output-style Concise/);
    expect(getOutputStyleStatus(tempHome).ok).toBe(true);
  });
});
